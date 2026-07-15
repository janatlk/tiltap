import { query, queryOne } from "../connection";

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
  source_lang: string | null;
  target_lang: string;
  translated_text: string;
  provider: string;
  model: string;
  status: "pending" | "confirmed" | "rejected" | "error";
  confirmed: boolean;
  confirmed_at: Date | null;
  confirmed_by: string | null;
  rejected_at: Date | null;
  rejected_by: string | null;
  error_message: string | null;
  error_at: Date | null;
  source_url: string | null;
  source_type: string | null;
  request_number: number | null;
  cost_usd: number | null;
  created_at: Date;
  updated_at: Date;
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

/**
 * Return a translation cache entry only if it has been admin-confirmed.
 * Unconfirmed/rejected/error entries are intentionally not returned so that
 * identical text is re-translated until a human approves the result.
 */
export async function getConfirmedTranslationCache(
  sourceHash: string,
  targetLang: string
): Promise<TranslationCacheEntry | null> {
  return queryOne<TranslationCacheEntry>(
    `SELECT * FROM translation_cache
     WHERE source_hash = $1 AND target_lang = $2 AND status = 'confirmed'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [sourceHash, targetLang]
  );
}

/**
 * Return any cache entry (regardless of status). Used by the admin review UI.
 */
export async function getTranslationCache(
  sourceHash: string,
  targetLang: string
): Promise<TranslationCacheEntry | null> {
  return queryOne<TranslationCacheEntry>(
    `SELECT * FROM translation_cache
     WHERE source_hash = $1 AND target_lang = $2
     ORDER BY updated_at DESC
     LIMIT 1`,
    [sourceHash, targetLang]
  );
}

/**
 * Hard-delete a cache entry. Kept for admin cleanup use.
 */
export async function deleteTranslationCache(
  sourceHash: string,
  targetLang: string
): Promise<void> {
  await queryOne(
    `DELETE FROM translation_cache
     WHERE source_hash = $1 AND target_lang = $2`,
    [sourceHash, targetLang]
  );
}

/**
 * Save a fresh translation as pending. If a confirmed entry already
 * exists for this (hash, target_lang), it is NOT overwritten.
 */
export async function saveTranslationCache(payload: {
  sourceText: string;
  sourceHash?: string;
  sourceLang?: string;
  targetLang: string;
  translatedText: string;
  provider: string;
  model: string;
  sourceUrl?: string;
  sourceType?: string;
  requestNumber?: number;
  costUsd?: number;
}): Promise<TranslationCacheEntry> {
  const sourceHash = payload.sourceHash ?? hashText(payload.sourceText);
  return queryOne<TranslationCacheEntry>(
    `INSERT INTO translation_cache
       (source_hash, source_text, source_lang, target_lang, translated_text, provider, model,
        status, source_url, source_type, request_number, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $11)
     ON CONFLICT (source_hash, target_lang) DO UPDATE SET
       translated_text = EXCLUDED.translated_text,
       source_lang = COALESCE(EXCLUDED.source_lang, translation_cache.source_lang),
       provider = EXCLUDED.provider,
       model = EXCLUDED.model,
       status = CASE WHEN translation_cache.status = 'confirmed' THEN 'confirmed' ELSE 'pending' END,
       source_url = COALESCE(EXCLUDED.source_url, translation_cache.source_url),
       source_type = COALESCE(EXCLUDED.source_type, translation_cache.source_type),
       request_number = COALESCE(EXCLUDED.request_number, translation_cache.request_number),
       cost_usd = COALESCE(EXCLUDED.cost_usd, translation_cache.cost_usd),
       updated_at = NOW()
     RETURNING *`,
    [
      sourceHash,
      payload.sourceText,
      payload.sourceLang ?? null,
      payload.targetLang,
      payload.translatedText,
      payload.provider,
      payload.model,
      payload.sourceUrl ?? null,
      payload.sourceType ?? null,
      payload.requestNumber ?? null,
      payload.costUsd ?? null,
    ]
  ) as Promise<TranslationCacheEntry>;
}

/**
 * Confirm a cached translation (optionally with an edited version).
 * Once confirmed, translateText() will return this value for matching requests.
 */
export async function confirmTranslationCache(payload: {
  sourceHash: string;
  targetLang: string;
  confirmedBy?: string;
  translatedText?: string;
  sourceUrl?: string;
  sourceType?: string;
  sourceLang?: string;
}): Promise<TranslationCacheEntry | null> {
  const { sourceHash, targetLang, confirmedBy, translatedText, sourceUrl, sourceType, sourceLang } = payload;

  if (translatedText !== undefined) {
    return queryOne<TranslationCacheEntry>(
      `INSERT INTO translation_cache
         (source_hash, source_text, source_lang, target_lang, translated_text, provider, model,
          status, confirmed, confirmed_at, confirmed_by, source_url, source_type)
       VALUES ($1, '', $2, $3, $4, 'admin', 'admin-edit', 'confirmed', TRUE, NOW(), $5, $6, $7)
       ON CONFLICT (source_hash, target_lang) DO UPDATE SET
         translated_text = EXCLUDED.translated_text,
         source_lang = COALESCE(EXCLUDED.source_lang, translation_cache.source_lang),
         provider = EXCLUDED.provider,
         model = EXCLUDED.model,
         status = 'confirmed',
         confirmed = TRUE,
         confirmed_at = NOW(),
         confirmed_by = EXCLUDED.confirmed_by,
         source_url = COALESCE(EXCLUDED.source_url, translation_cache.source_url),
         source_type = COALESCE(EXCLUDED.source_type, translation_cache.source_type),
         updated_at = NOW()
       RETURNING *`,
      [sourceHash, sourceLang ?? null, targetLang, translatedText, confirmedBy ?? null, sourceUrl ?? null, sourceType ?? null]
    );
  }

  return queryOne<TranslationCacheEntry>(
    `UPDATE translation_cache
     SET status = 'confirmed',
         confirmed = TRUE,
         confirmed_at = NOW(),
         confirmed_by = $3,
         source_url = COALESCE($4, source_url),
         source_type = COALESCE($5, source_type),
         updated_at = NOW()
     WHERE source_hash = $1 AND target_lang = $2
     RETURNING *`,
    [sourceHash, targetLang, confirmedBy ?? null, sourceUrl ?? null, sourceType ?? null]
  );
}

/**
 * Reject a cached translation. Instead of deleting, the row is kept with
 * status 'rejected' so admins can review rejection history.
 */
export async function rejectTranslationCache(payload: {
  sourceHash: string;
  targetLang: string;
  rejectedBy?: string;
}): Promise<TranslationCacheEntry | null> {
  const { sourceHash, targetLang, rejectedBy } = payload;
  return queryOne<TranslationCacheEntry>(
    `UPDATE translation_cache
     SET status = 'rejected',
         confirmed = FALSE,
         rejected_at = NOW(),
         rejected_by = $3,
         updated_at = NOW()
     WHERE source_hash = $1 AND target_lang = $2
     RETURNING *`,
    [sourceHash, targetLang, rejectedBy ?? null]
  );
}

/**
 * Log a translation failure as an error row. If a row already exists for this
 * (hash, target_lang), update it with the error details.
 */
export async function logTranslationError(payload: {
  sourceText: string;
  sourceHash?: string;
  sourceLang?: string;
  targetLang: string;
  errorMessage: string;
  provider?: string;
  model?: string;
  sourceUrl?: string;
  sourceType?: string;
  requestNumber?: number;
  costUsd?: number;
}): Promise<TranslationCacheEntry | null> {
  const sourceHash = payload.sourceHash ?? hashText(payload.sourceText);
  return queryOne<TranslationCacheEntry>(
    `INSERT INTO translation_cache
       (source_hash, source_text, source_lang, target_lang, translated_text, provider, model,
        status, error_message, error_at, source_url, source_type, request_number, cost_usd)
     VALUES ($1, $2, $3, $4, '', $5, $6, 'error', $7, NOW(), $8, $9, $10, $11)
     ON CONFLICT (source_hash, target_lang) DO UPDATE SET
       status = 'error',
       error_message = EXCLUDED.error_message,
       error_at = NOW(),
       source_url = COALESCE(EXCLUDED.source_url, translation_cache.source_url),
       source_type = COALESCE(EXCLUDED.source_type, translation_cache.source_type),
       request_number = COALESCE(EXCLUDED.request_number, translation_cache.request_number),
       cost_usd = COALESCE(EXCLUDED.cost_usd, translation_cache.cost_usd),
       updated_at = NOW()
     RETURNING *`,
    [
      sourceHash,
      payload.sourceText,
      payload.sourceLang ?? null,
      payload.targetLang,
      payload.provider ?? "unknown",
      payload.model ?? "unknown",
      payload.errorMessage,
      payload.sourceUrl ?? null,
      payload.sourceType ?? null,
      payload.requestNumber ?? null,
      payload.costUsd ?? null,
    ]
  );
}

export async function listPendingTranslations(limit = 100): Promise<TranslationCacheEntry[]> {
  const rows = await query<TranslationCacheEntry>(
    `SELECT * FROM translation_cache
     WHERE status = 'pending'
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows ?? [];
}

export async function listConfirmedTranslations(limit = 100): Promise<TranslationCacheEntry[]> {
  const rows = await query<TranslationCacheEntry>(
    `SELECT * FROM translation_cache
     WHERE status = 'confirmed'
     ORDER BY confirmed_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows ?? [];
}

export async function listRejectedTranslations(limit = 100): Promise<TranslationCacheEntry[]> {
  const rows = await query<TranslationCacheEntry>(
    `SELECT * FROM translation_cache
     WHERE status = 'rejected'
     ORDER BY rejected_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows ?? [];
}

export async function listErrorTranslations(limit = 100): Promise<TranslationCacheEntry[]> {
  const rows = await query<TranslationCacheEntry>(
    `SELECT
       id,
       source_hash,
       source_text,
       source_lang,
       target_lang,
       COALESCE(translated_text, '') AS translated_text,
       provider,
       model,
       status,
       FALSE AS confirmed,
       NULL::timestamp WITH time zone AS confirmed_at,
       NULL AS confirmed_by,
       NULL::timestamp with time zone AS rejected_at,
       NULL AS rejected_by,
       error_message,
       created_at AS error_at,
       source_url,
       source_type,
       request_number,
       created_at,
       created_at AS updated_at
     FROM translation_requests
     WHERE error_message IS NOT NULL
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows ?? [];
}

export async function saveTranslationRequest(payload: {
  sourceHash?: string;
  sourceText: string;
  sourceLang?: string;
  targetLang: string;
  translatedText?: string;
  provider: string;
  model: string;
  status?: "pending" | "error" | "confirmed";
  errorMessage?: string;
  sourceUrl?: string;
  sourceType?: string;
  requestNumber?: number;
  costUsd?: number;
}): Promise<void> {
  const sourceHash = payload.sourceHash ?? hashText(payload.sourceText);
  await queryOne(
    `INSERT INTO translation_requests
       (request_number, source_hash, source_text, source_lang, target_lang, translated_text, provider, model,
        status, error_message, source_url, source_type, cost_usd)
     VALUES (COALESCE($12, nextval('translation_request_number_seq')), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $13)`,
    [
      sourceHash,
      payload.sourceText,
      payload.sourceLang ?? null,
      payload.targetLang,
      payload.translatedText ?? null,
      payload.provider,
      payload.model,
      payload.status ?? "pending",
      payload.errorMessage ?? null,
      payload.sourceUrl ?? null,
      payload.sourceType ?? null,
      payload.requestNumber ?? null,
      payload.costUsd ?? null,
    ]
  );
}

export async function getNextRequestNumber(): Promise<number> {
  const row = await queryOne<{ nextval: number }>(
    "SELECT nextval('translation_request_number_seq') AS nextval"
  );
  return row?.nextval ?? 0;
}

export async function findTranslationByRequestNumber(
  requestNumber: number
): Promise<TranslationCacheEntry | null> {
  return queryOne<TranslationCacheEntry>(
    `SELECT * FROM translation_cache
     WHERE request_number = $1
     LIMIT 1`,
    [requestNumber]
  );
}

export async function findTranslationRequestByNumber(
  requestNumber: number
): Promise<TranslationCacheEntry | null> {
  const row = await queryOne<TranslationCacheEntry>(
    `SELECT
       id,
       request_number,
       source_hash,
       source_text,
       source_lang,
       target_lang,
       COALESCE(translated_text, '') AS translated_text,
       provider,
       model,
       status,
       FALSE AS confirmed,
       NULL::timestamp WITH time zone AS confirmed_at,
       NULL AS confirmed_by,
       NULL::timestamp with time zone AS rejected_at,
       NULL AS rejected_by,
       error_message,
       created_at AS error_at,
       source_url,
       source_type,
       created_at,
       created_at AS updated_at
     FROM translation_requests
     WHERE request_number = $1
     LIMIT 1`,
    [requestNumber]
  );
  return row ?? null;
}

function hashText(text: string): string {
  // Node crypto is imported dynamically to keep the repo layer lightweight.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require("crypto");
  return createHash("sha256").update(text).digest("hex");
}
