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

-- Bilingual glossary injected into the translation prompt.
--
-- Exists because the models invent word forms on Kyrgyz, Tajik and Uzbek, and
-- do so confidently: asking the model which words it is unsure about does not
-- surface those errors, since it is not unsure. Matching the source text
-- against this table instead makes coverage independent of the model's own
-- confidence.
--
-- direction is stored explicitly rather than derived, because a term's
-- translation is not always reversible.
CREATE TABLE IF NOT EXISTS translation_glossary (
  id SERIAL PRIMARY KEY,
  source_lang VARCHAR(10) NOT NULL,
  target_lang VARCHAR(10) NOT NULL,
  term VARCHAR(200) NOT NULL,
  translation VARCHAR(400) NOT NULL,
  -- Optional guidance passed to the model with the term, e.g. "имя человека,
  -- не переводить" or "только в контексте погоды".
  note VARCHAR(400),
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Lookup is always "all terms for this direction", then matched in memory:
-- the tables are small (hundreds of entries) and matching needs the source
-- language's own morphology, which SQL cannot do.
CREATE UNIQUE INDEX IF NOT EXISTS idx_glossary_unique
  ON translation_glossary(source_lang, target_lang, LOWER(term));
CREATE INDEX IF NOT EXISTS idx_glossary_direction
  ON translation_glossary(source_lang, target_lang) WHERE enabled;

-- Admin handling of a feedback item. Added separately from the feedback table
-- so existing rows keep working: everything defaults to 'new'.
--
-- 'deferred' exists because some reports cannot be answered immediately, and a
-- report that is neither answered nor closed is exactly the one that gets
-- forgotten. Deferred items are re-sent to the admin daily until they move.
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS status VARCHAR(12) DEFAULT 'new';
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS admin_reply TEXT;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS admin_reply_at TIMESTAMP WITH TIME ZONE;
-- Whether the reply reached the user. Web reports have no push channel, so a
-- reply to them is stored and shown when they come back, not delivered.
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS reply_delivered BOOLEAN DEFAULT FALSE;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS reply_seen_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS last_reminded_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status, created_at DESC);

-- Admin sessions issued after a successful password login.
--
-- Kept in the database rather than in memory so a backend restart does not log
-- the admin out, and so a stolen session can be revoked by deleting a row.
-- Only the hash of the session token is stored: a database dump then does not
-- hand over working sessions.
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash VARCHAR(64) PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  ip VARCHAR(64),
  user_agent VARCHAR(300)
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at);

-- ---------------------------------------------------------------------------
-- Dataset annotation: audio collected and corrected by linguists so GigaAM can
-- be fine-tuned on Kyrgyz. Kept apart from the production tables above because
-- this data has a different owner, a different lifetime, and is the one part of
-- the system whose value is the corpus itself rather than the request log.
-- ---------------------------------------------------------------------------

-- One linguist. Separate accounts rather than a shared password so an edit can
-- be traced to a person: when a systematic mistake turns up in the corpus, the
-- only way to fix it at the source is to know whose habit it was.
CREATE TABLE IF NOT EXISTS dataset_annotators (
  id SERIAL PRIMARY KEY,
  username VARCHAR(64) UNIQUE NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_login_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS dataset_sessions (
  token_hash VARCHAR(64) PRIMARY KEY,
  annotator_id INTEGER NOT NULL REFERENCES dataset_annotators(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  ip VARCHAR(64)
);

CREATE INDEX IF NOT EXISTS idx_dataset_sessions_expiry ON dataset_sessions(expires_at);

-- One source recording: a link or an uploaded file, plus how far its
-- preparation got.
CREATE TABLE IF NOT EXISTS dataset_tasks (
  id SERIAL PRIMARY KEY,
  title VARCHAR(300) NOT NULL,
  language VARCHAR(10) NOT NULL DEFAULT 'ky',
  source_kind VARCHAR(16) NOT NULL,
  source_url TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'queued',
  stage VARCHAR(40),
  progress INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  duration_sec REAL,
  audio_path TEXT,
  segmentation_method VARCHAR(16),
  segment_count INTEGER NOT NULL DEFAULT 0,
  reviewed_count INTEGER NOT NULL DEFAULT 0,
  -- A task belongs to one linguist at a time. Two people editing the same
  -- transcript would silently overwrite each other, and the loser would never
  -- know their hour of work was gone.
  owner_id INTEGER REFERENCES dataset_annotators(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES dataset_annotators(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_dataset_tasks_status ON dataset_tasks(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dataset_tasks_owner ON dataset_tasks(owner_id, status);

-- One clip. clip_number is global and assigned once at creation, so a file name
-- never changes meaning: renumbering on export would break every reference a
-- linguist or a training run already made to it.
CREATE TABLE IF NOT EXISTS dataset_segments (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES dataset_tasks(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  clip_number BIGINT UNIQUE NOT NULL,
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  duration_sec REAL NOT NULL,
  audio_path TEXT NOT NULL,
  -- Kept beside the edited text so the corpus records what the model got wrong,
  -- not only what the right answer was. That difference is the training signal.
  asr_text TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  forced_cut BOOLEAN NOT NULL DEFAULT FALSE,
  edited_by INTEGER REFERENCES dataset_annotators(id) ON DELETE SET NULL,
  edited_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dataset_segments_task_idx ON dataset_segments(task_id, idx);
CREATE INDEX IF NOT EXISTS idx_dataset_segments_status ON dataset_segments(task_id, status);

-- Global clip numbering, independent of table ids so a deleted task does not
-- leave a hole that a later clip could reuse.
CREATE SEQUENCE IF NOT EXISTS dataset_clip_number_seq START 1;
