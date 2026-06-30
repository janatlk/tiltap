import { queryOne } from "../connection";

export interface Translation {
  id: number;
  telegram_chat_id: string;
  transcription_id: number;
  source_text: string;
  source_hash: string;
  target_lang: string;
  translated_text: string;
  created_at: Date;
}

export interface TranslationCacheEntry {
  id: number;
  source_hash: string;
  source_text: string;
  target_lang: string;
  translated_text: string;
  provider: string;
  model: string;
  created_at: Date;
}

export async function saveTranslation(payload: {
  telegramChatId: number;
  transcriptionId: number;
  sourceText: string;
  sourceHash?: string;
  targetLang: string;
  translatedText: string;
}): Promise<Translation> {
  const sourceHash = payload.sourceHash ?? hashText(payload.sourceText);
  return queryOne<Translation>(
    `INSERT INTO translations
       (telegram_chat_id, transcription_id, source_text, source_hash, target_lang, translated_text)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      payload.telegramChatId,
      payload.transcriptionId,
      payload.sourceText,
      sourceHash,
      payload.targetLang,
      payload.translatedText,
    ]
  ) as Promise<Translation>;
}

export async function getTranslation(
  transcriptionId: number,
  targetLang: string
): Promise<Translation | null> {
  return queryOne<Translation>(
    `SELECT * FROM translations
     WHERE transcription_id = $1 AND target_lang = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [transcriptionId, targetLang]
  );
}

export async function getTranslationCache(
  sourceHash: string,
  targetLang: string
): Promise<TranslationCacheEntry | null> {
  return queryOne<TranslationCacheEntry>(
    `SELECT * FROM translation_cache
     WHERE source_hash = $1 AND target_lang = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [sourceHash, targetLang]
  );
}

export async function saveTranslationCache(payload: {
  sourceText: string;
  sourceHash?: string;
  targetLang: string;
  translatedText: string;
  provider: string;
  model: string;
}): Promise<TranslationCacheEntry> {
  const sourceHash = payload.sourceHash ?? hashText(payload.sourceText);
  return queryOne<TranslationCacheEntry>(
    `INSERT INTO translation_cache
       (source_hash, source_text, target_lang, translated_text, provider, model)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source_hash, target_lang) DO UPDATE SET
       translated_text = EXCLUDED.translated_text,
       provider = EXCLUDED.provider,
       model = EXCLUDED.model,
       created_at = NOW()
     RETURNING *`,
    [
      sourceHash,
      payload.sourceText,
      payload.targetLang,
      payload.translatedText,
      payload.provider,
      payload.model,
    ]
  ) as Promise<TranslationCacheEntry>;
}

function hashText(text: string): string {
  // Node crypto is imported dynamically to keep the repo layer lightweight.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require("crypto");
  return createHash("sha256").update(text).digest("hex");
}
