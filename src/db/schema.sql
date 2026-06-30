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

CREATE INDEX IF NOT EXISTS idx_translations_hash_lang ON translations(source_hash, target_lang);

CREATE TABLE IF NOT EXISTS translation_cache (
  id SERIAL PRIMARY KEY,
  source_hash VARCHAR(64) NOT NULL,
  source_text TEXT NOT NULL,
  target_lang VARCHAR(10) NOT NULL,
  translated_text TEXT NOT NULL,
  provider VARCHAR(20) NOT NULL,
  model VARCHAR(50) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(source_hash, target_lang)
);

CREATE INDEX IF NOT EXISTS idx_translation_cache_hash_lang ON translation_cache(source_hash, target_lang);

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
