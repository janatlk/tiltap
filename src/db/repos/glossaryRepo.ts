import { query, queryOne } from "../connection";

export interface GlossaryEntry {
  id: number;
  source_lang: string;
  target_lang: string;
  term: string;
  translation: string;
  note: string | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

/** All enabled entries for one direction. Callers match them against the text. */
export async function listForDirection(sourceLang: string, targetLang: string): Promise<GlossaryEntry[]> {
  return await query<GlossaryEntry>(
    `SELECT * FROM translation_glossary
     WHERE source_lang = $1 AND target_lang = $2 AND enabled
     ORDER BY LENGTH(term) DESC`,
    [sourceLang.toLowerCase(), targetLang.toLowerCase()]
  );
}

/** Everything, for the admin UI. */
export async function listAll(sourceLang?: string, targetLang?: string): Promise<GlossaryEntry[]> {
  if (sourceLang && targetLang) {
    return await query<GlossaryEntry>(
      `SELECT * FROM translation_glossary
       WHERE source_lang = $1 AND target_lang = $2
       ORDER BY term`,
      [sourceLang.toLowerCase(), targetLang.toLowerCase()]
    );
  }
  return await query<GlossaryEntry>(
    `SELECT * FROM translation_glossary ORDER BY source_lang, target_lang, term`
  );
}

export async function upsertEntry(payload: {
  sourceLang: string;
  targetLang: string;
  term: string;
  translation: string;
  note?: string | null;
  enabled?: boolean;
}): Promise<GlossaryEntry | null> {
  return queryOne<GlossaryEntry>(
    `INSERT INTO translation_glossary (source_lang, target_lang, term, translation, note, enabled)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source_lang, target_lang, LOWER(term)) DO UPDATE SET
       translation = EXCLUDED.translation,
       note = EXCLUDED.note,
       enabled = EXCLUDED.enabled,
       updated_at = NOW()
     RETURNING *`,
    [
      payload.sourceLang.toLowerCase(),
      payload.targetLang.toLowerCase(),
      payload.term.trim(),
      payload.translation.trim(),
      payload.note?.trim() || null,
      payload.enabled ?? true,
    ]
  );
}

export async function deleteEntry(id: number): Promise<boolean> {
  // RETURNING rather than a row count: the two backends report affected rows
  // differently, but both return the rows themselves.
  const rows = await query<{ id: number }>(
    `DELETE FROM translation_glossary WHERE id = $1 RETURNING id`,
    [id]
  );
  return rows.length > 0;
}

/** Distinct directions that have at least one entry — used to label the UI. */
export async function listDirections(): Promise<{ source_lang: string; target_lang: string; count: number }[]> {
  const rows = await query<{ source_lang: string; target_lang: string; count: number | string }>(
    `SELECT source_lang, target_lang, COUNT(*)::int AS count
     FROM translation_glossary
     WHERE enabled
     GROUP BY source_lang, target_lang
     ORDER BY source_lang, target_lang`
  );
  return rows.map((r) => ({ ...r, count: Number(r.count) }));
}
