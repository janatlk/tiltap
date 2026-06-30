import { queryOne } from "../connection";

export interface CleanupCacheEntry {
  id: number;
  source_hash: string;
  source_text: string;
  cleaned_text: string;
  language: string;
  provider: string;
  model: string;
  created_at: Date;
}

export async function getCleanupByHash(
  sourceHash: string,
  language: string
): Promise<CleanupCacheEntry | null> {
  return queryOne<CleanupCacheEntry>(
    `SELECT * FROM cleanup_cache
     WHERE source_hash = $1 AND language = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [sourceHash, language]
  );
}

export async function saveCleanup(payload: {
  sourceText: string;
  sourceHash?: string;
  cleanedText: string;
  language: string;
  provider: string;
  model: string;
}): Promise<CleanupCacheEntry> {
  const sourceHash = payload.sourceHash ?? hashText(payload.sourceText);
  return queryOne<CleanupCacheEntry>(
    `INSERT INTO cleanup_cache
       (source_hash, source_text, cleaned_text, language, provider, model)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source_hash) DO UPDATE SET
       cleaned_text = EXCLUDED.cleaned_text,
       provider = EXCLUDED.provider,
       model = EXCLUDED.model,
       created_at = NOW()
     RETURNING *`,
    [
      sourceHash,
      payload.sourceText,
      payload.cleanedText,
      payload.language,
      payload.provider,
      payload.model,
    ]
  ) as Promise<CleanupCacheEntry>;
}

function hashText(text: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require("crypto");
  return createHash("sha256").update(text).digest("hex");
}
