-- TilTap database schema

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  telegram_chat_id BIGINT UNIQUE NOT NULL,
  preferred_language VARCHAR(10),
  interface_language VARCHAR(10) DEFAULT 'ru',
  target_language VARCHAR(10),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Migration safety net: ensure the column exists for databases created before this schema version
ALTER TABLE users ADD COLUMN IF NOT EXISTS interface_language VARCHAR(10) DEFAULT 'ru';
ALTER TABLE users ADD COLUMN IF NOT EXISTS target_language VARCHAR(10);

-- Backfill existing users with default interface language
ALTER TABLE users ALTER COLUMN interface_language SET DEFAULT 'ru';
UPDATE users SET interface_language = COALESCE(interface_language, 'ru') WHERE interface_language IS NULL;

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  telegram_chat_id BIGINT NOT NULL,
  telegram_message_id BIGINT,
  update_id BIGINT,
  message_type VARCHAR(20) NOT NULL, -- 'text', 'video', 'voice', 'audio', 'document'
  file_id VARCHAR(255),
  file_size INTEGER,
  mime_type VARCHAR(100),
  raw_payload JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transcriptions (
  id SERIAL PRIMARY KEY,
  telegram_chat_id BIGINT NOT NULL,
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  language VARCHAR(10) NOT NULL,
  full_text TEXT NOT NULL,
  segments JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS translations (
  id SERIAL PRIMARY KEY,
  telegram_chat_id BIGINT NOT NULL,
  transcription_id INTEGER REFERENCES transcriptions(id) ON DELETE CASCADE,
  source_text TEXT NOT NULL,
  source_hash VARCHAR(64) NOT NULL,
  target_lang VARCHAR(10) NOT NULL,
  translated_text TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Migration safety net: ensure source_hash exists for databases created before this schema version
ALTER TABLE translations ADD COLUMN IF NOT EXISTS source_hash VARCHAR(64);
UPDATE translations SET source_hash = COALESCE(source_hash, '') WHERE source_hash IS NULL;
ALTER TABLE translations ALTER COLUMN source_hash SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_translations_hash_lang ON translations(source_hash, target_lang);

CREATE TABLE IF NOT EXISTS translation_cache (
  id SERIAL PRIMARY KEY,
  source_hash VARCHAR(64) NOT NULL,
  source_text TEXT NOT NULL,
  source_lang VARCHAR(10),
  target_lang VARCHAR(10) NOT NULL,
  translated_text TEXT NOT NULL,
  provider VARCHAR(20) NOT NULL,
  model VARCHAR(50) NOT NULL,
  -- Lifecycle status: pending / confirmed / rejected / error
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  confirmed_at TIMESTAMP WITH TIME ZONE,
  confirmed_by VARCHAR(255),
  rejected_at TIMESTAMP WITH TIME ZONE,
  rejected_by VARCHAR(255),
  error_message TEXT,
  error_at TIMESTAMP WITH TIME ZONE,
  -- Traceability: where did the source text come from?
  source_url TEXT,
  source_type VARCHAR(20), -- 'text', 'youtube', 'audio', 'telegram', 'web'
  -- Public request number for user error reports
  request_number BIGINT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(source_hash, target_lang)
);

CREATE INDEX IF NOT EXISTS idx_translation_cache_hash_lang ON translation_cache(source_hash, target_lang);
CREATE INDEX IF NOT EXISTS idx_translation_cache_confirmed ON translation_cache(confirmed, created_at);

-- Migration safety net: ensure columns exist on older databases
ALTER TABLE translation_cache ADD COLUMN IF NOT EXISTS confirmed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE translation_cache ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE translation_cache ADD COLUMN IF NOT EXISTS confirmed_by VARCHAR(255);
ALTER TABLE translation_cache ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE translation_cache ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'pending';
ALTER TABLE translation_cache ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE translation_cache ADD COLUMN IF NOT EXISTS rejected_by VARCHAR(255);
ALTER TABLE translation_cache ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE translation_cache ADD COLUMN IF NOT EXISTS error_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE translation_cache ADD COLUMN IF NOT EXISTS source_lang VARCHAR(10);
ALTER TABLE translation_cache ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE translation_cache ADD COLUMN IF NOT EXISTS source_type VARCHAR(20);
ALTER TABLE translation_cache ADD COLUMN IF NOT EXISTS request_number BIGINT;

-- Backfill: existing confirmed rows get status 'confirmed'
UPDATE translation_cache SET status = 'confirmed' WHERE confirmed = TRUE AND status = 'pending';

-- Status-dependent indexes can only be created after the column is guaranteed to exist.
CREATE INDEX IF NOT EXISTS idx_translation_cache_status ON translation_cache(status, created_at);
CREATE INDEX IF NOT EXISTS idx_translation_cache_request_number ON translation_cache(request_number);

-- Public request number sequence. Numbers start at 1000 to look familiar to users.
CREATE SEQUENCE IF NOT EXISTS translation_request_number_seq START 1000;

-- Audit log: every translation request (successful or failed) with its source link.
CREATE TABLE IF NOT EXISTS translation_requests (
  id SERIAL PRIMARY KEY,
  request_number BIGINT NOT NULL UNIQUE DEFAULT nextval('translation_request_number_seq'),
  source_hash VARCHAR(64) NOT NULL,
  source_text TEXT NOT NULL,
  source_lang VARCHAR(10),
  target_lang VARCHAR(10) NOT NULL,
  translated_text TEXT,
  provider VARCHAR(20) NOT NULL,
  model VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  error_message TEXT,
  source_url TEXT,
  source_type VARCHAR(20),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Backfill: existing audit rows created before request_number was added.
ALTER TABLE translation_requests ADD COLUMN IF NOT EXISTS source_lang VARCHAR(10);
ALTER TABLE translation_requests ADD COLUMN IF NOT EXISTS request_number BIGINT DEFAULT nextval('translation_request_number_seq');
ALTER TABLE translation_requests ALTER COLUMN request_number SET NOT NULL;
ALTER TABLE translation_requests ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(12, 6);
ALTER TABLE translation_cache ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(12, 6);

CREATE INDEX IF NOT EXISTS idx_translation_requests_created_at ON translation_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_translation_requests_hash_lang ON translation_requests(source_hash, target_lang);
CREATE INDEX IF NOT EXISTS idx_translation_requests_number ON translation_requests(request_number);
CREATE INDEX IF NOT EXISTS idx_translation_requests_errors ON translation_requests(error_message, created_at DESC);

-- Web transcription jobs audit log.
-- Unlike translation_cache, these rows are not user-reviewable; they exist so
-- admins can inspect STT results, provider/model used, and first-segment timing.
CREATE TABLE IF NOT EXISTS web_jobs (
  id SERIAL PRIMARY KEY,
  request_number BIGINT NOT NULL UNIQUE DEFAULT nextval('translation_request_number_seq'),
  job_id VARCHAR(64) NOT NULL UNIQUE,
  type VARCHAR(20) NOT NULL, -- 'transcribe' | 'youtube'
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  source_lang VARCHAR(10),
  target_lang VARCHAR(10),
  source_url TEXT,
  source_type VARCHAR(20),
  filename VARCHAR(255),
  full_text TEXT,
  segments_json JSONB NOT NULL DEFAULT '[]',
  provider VARCHAR(20),
  model VARCHAR(100),
  gpu VARCHAR(50),
  error_message TEXT,
  progress_percent INTEGER,
  progress_label VARCHAR(100),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_web_jobs_created_at ON web_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_web_jobs_status ON web_jobs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_web_jobs_request_number ON web_jobs(request_number);

-- Telegram/media transcription audit log.
-- Mirrors translation_requests: every transcription attempt (successful or failed)
-- gets a public request_number from the shared sequence.
CREATE TABLE IF NOT EXISTS transcription_requests (
  id SERIAL PRIMARY KEY,
  request_number BIGINT NOT NULL UNIQUE DEFAULT nextval('translation_request_number_seq'),
  telegram_chat_id BIGINT,
  telegram_message_id BIGINT,
  source_type VARCHAR(20),      -- 'telegram_media' | 'youtube' | 'tiktok' | 'instagram'
  source_url TEXT,
  filename VARCHAR(255),
  language VARCHAR(10),
  full_text TEXT,
  segments_json JSONB NOT NULL DEFAULT '[]',
  provider VARCHAR(20),
  model VARCHAR(100),
  gpu VARCHAR(50),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_transcription_requests_number ON transcription_requests(request_number);
CREATE INDEX IF NOT EXISTS idx_transcription_requests_created_at ON transcription_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transcription_requests_status ON transcription_requests(status, created_at DESC);

-- Migration safety net for older databases
ALTER TABLE web_jobs ADD COLUMN IF NOT EXISTS request_number BIGINT DEFAULT nextval('translation_request_number_seq');
ALTER TABLE web_jobs ALTER COLUMN request_number SET NOT NULL;
ALTER TABLE web_jobs ADD COLUMN IF NOT EXISTS job_id VARCHAR(64) UNIQUE;
ALTER TABLE web_jobs ADD COLUMN IF NOT EXISTS type VARCHAR(20);
ALTER TABLE web_jobs ADD COLUMN IF NOT EXISTS status VARCHAR(20);
ALTER TABLE web_jobs ADD COLUMN IF NOT EXISTS source_lang VARCHAR(10);
ALTER TABLE web_jobs ADD COLUMN IF NOT EXISTS target_lang VARCHAR(10);
ALTER TABLE web_jobs ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE web_jobs ADD COLUMN IF NOT EXISTS source_type VARCHAR(20);
ALTER TABLE web_jobs ADD COLUMN IF NOT EXISTS filename VARCHAR(255);
ALTER TABLE web_jobs ADD COLUMN IF NOT EXISTS full_text TEXT;
ALTER TABLE web_jobs ADD COLUMN IF NOT EXISTS segments_json JSONB DEFAULT '[]';
ALTER TABLE web_jobs ADD COLUMN IF NOT EXISTS provider VARCHAR(20);
ALTER TABLE web_jobs ADD COLUMN IF NOT EXISTS model VARCHAR(100);
ALTER TABLE web_jobs ADD COLUMN IF NOT EXISTS gpu VARCHAR(50);
ALTER TABLE web_jobs ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE web_jobs ADD COLUMN IF NOT EXISTS progress_percent INTEGER;
ALTER TABLE web_jobs ADD COLUMN IF NOT EXISTS progress_label VARCHAR(100);
ALTER TABLE web_jobs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE web_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE web_jobs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP WITH TIME ZONE;

-- Migration safety net for transcription_requests on older databases
ALTER TABLE transcription_requests ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT;
ALTER TABLE transcription_requests ADD COLUMN IF NOT EXISTS telegram_message_id BIGINT;
ALTER TABLE transcription_requests ADD COLUMN IF NOT EXISTS source_type VARCHAR(20);
ALTER TABLE transcription_requests ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE transcription_requests ADD COLUMN IF NOT EXISTS filename VARCHAR(255);
ALTER TABLE transcription_requests ADD COLUMN IF NOT EXISTS language VARCHAR(10);
ALTER TABLE transcription_requests ADD COLUMN IF NOT EXISTS full_text TEXT;
ALTER TABLE transcription_requests ADD COLUMN IF NOT EXISTS segments_json JSONB DEFAULT '[]';
ALTER TABLE transcription_requests ADD COLUMN IF NOT EXISTS provider VARCHAR(20);
ALTER TABLE transcription_requests ADD COLUMN IF NOT EXISTS model VARCHAR(100);
ALTER TABLE transcription_requests ADD COLUMN IF NOT EXISTS gpu VARCHAR(50);
ALTER TABLE transcription_requests ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending';
ALTER TABLE transcription_requests ALTER COLUMN status SET NOT NULL;
ALTER TABLE transcription_requests ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE transcription_requests ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE transcription_requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
ALTER TABLE transcription_requests ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP WITH TIME ZONE;

CREATE TABLE IF NOT EXISTS cleanup_cache (
  id SERIAL PRIMARY KEY,
  source_hash VARCHAR(64) UNIQUE NOT NULL,
  source_text TEXT NOT NULL,
  cleaned_text TEXT NOT NULL,
  language VARCHAR(10) NOT NULL,
  provider VARCHAR(20) NOT NULL,
  model VARCHAR(50) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cleanup_cache_hash ON cleanup_cache(source_hash);

CREATE TABLE IF NOT EXISTS pending_actions (
  id SERIAL PRIMARY KEY,
  telegram_chat_id BIGINT UNIQUE NOT NULL,
  action_id VARCHAR(64) NOT NULL,
  action_type VARCHAR(20) NOT NULL, -- 'media', 'youtube'
  payload JSONB NOT NULL,
  buffer BYTEA,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pending_actions_chat_id ON pending_actions(telegram_chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(telegram_chat_id);
CREATE INDEX IF NOT EXISTS idx_transcriptions_chat_id ON transcriptions(telegram_chat_id);

-- User feedback on a specific result (Telegram bot and web UI).
-- Context is snapshotted on the row so an admin can judge a complaint without
-- joining anything: who sent it, which public request number, language pair,
-- and which engine actually produced the result.
CREATE TABLE IF NOT EXISTS feedback (
  id SERIAL PRIMARY KEY,
  request_number BIGINT,               -- public number the user can quote
  source VARCHAR(20) NOT NULL,         -- 'telegram' | 'web'
  rating VARCHAR(10) NOT NULL,         -- 'up' | 'down' | 'issue' (free-text problem report)
  category VARCHAR(40),                -- 'stt' | 'translation' | 'download' | 'speed' | 'other'
  comment TEXT,
  -- Who
  telegram_chat_id BIGINT,
  telegram_username VARCHAR(255),
  telegram_name VARCHAR(255),
  web_client_id VARCHAR(64),           -- anonymous browser id (localStorage)
  job_id VARCHAR(64),                  -- web job id when source = 'web'
  -- Context snapshot
  source_type VARCHAR(20),             -- telegram_media | youtube | web | text | ...
  source_url TEXT,
  source_lang VARCHAR(10),
  target_lang VARCHAR(10),
  provider VARCHAR(20),
  model VARCHAR(100),
  interface_lang VARCHAR(10),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_rating ON feedback(rating, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_request_number ON feedback(request_number);
CREATE INDEX IF NOT EXISTS idx_feedback_chat_id ON feedback(telegram_chat_id);
