import { query, queryOne } from "../connection";

// "issue" is not a rating but a free-text problem report. It rides on the same
// row so a complaint keeps its context snapshot, and it is excluded from the
// satisfaction denominator: nobody said the result was bad, only that something
// went wrong.
export type FeedbackRating = "up" | "down" | "issue";
export type FeedbackSource = "telegram" | "web";

export interface FeedbackEntry {
  status: string | null;
  admin_reply: string | null;
  admin_reply_at: Date | null;
  reply_delivered: boolean | null;
  reply_seen_at: Date | null;
  status_changed_at: Date | null;
  last_reminded_at: Date | null;
  id: number;
  request_number: number | null;
  source: FeedbackSource;
  rating: FeedbackRating;
  category: string | null;
  comment: string | null;
  telegram_chat_id: number | null;
  telegram_username: string | null;
  telegram_name: string | null;
  web_client_id: string | null;
  job_id: string | null;
  source_type: string | null;
  source_url: string | null;
  source_lang: string | null;
  target_lang: string | null;
  provider: string | null;
  model: string | null;
  interface_lang: string | null;
  created_at: Date;
}

export interface CreateFeedbackPayload {
  requestNumber?: number | null;
  source: FeedbackSource;
  rating: FeedbackRating;
  category?: string | null;
  comment?: string | null;
  telegramChatId?: number | null;
  telegramUsername?: string | null;
  telegramName?: string | null;
  webClientId?: string | null;
  jobId?: string | null;
  sourceType?: string | null;
  sourceUrl?: string | null;
  sourceLang?: string | null;
  targetLang?: string | null;
  provider?: string | null;
  model?: string | null;
  interfaceLang?: string | null;
}

export async function createFeedback(payload: CreateFeedbackPayload): Promise<FeedbackEntry> {
  return queryOne<FeedbackEntry>(
    `INSERT INTO feedback
       (request_number, source, rating, category, comment,
        telegram_chat_id, telegram_username, telegram_name, web_client_id, job_id,
        source_type, source_url, source_lang, target_lang, provider, model, interface_lang)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [
      payload.requestNumber ?? null,
      payload.source,
      payload.rating,
      payload.category ?? null,
      payload.comment ?? null,
      payload.telegramChatId ?? null,
      payload.telegramUsername ?? null,
      payload.telegramName ?? null,
      payload.webClientId ?? null,
      payload.jobId ?? null,
      payload.sourceType ?? null,
      payload.sourceUrl ?? null,
      payload.sourceLang ?? null,
      payload.targetLang ?? null,
      payload.provider ?? null,
      payload.model ?? null,
      payload.interfaceLang ?? null,
    ]
  ) as Promise<FeedbackEntry>;
}

/**
 * Fill in details the user supplies after the initial rating: the Telegram flow
 * records the thumb first (so the signal is never lost), then optionally a
 * reason category and a free-text comment.
 */
export async function updateFeedback(
  id: number,
  updates: { category?: string; comment?: string }
): Promise<FeedbackEntry | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (updates.category !== undefined) {
    fields.push(`category = $${idx++}`);
    values.push(updates.category);
  }
  if (updates.comment !== undefined) {
    fields.push(`comment = $${idx++}`);
    values.push(updates.comment);
  }
  if (fields.length === 0) return null;

  values.push(id);
  return queryOne<FeedbackEntry>(
    `UPDATE feedback SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );
}

export async function listFeedback(
  options: { limit?: number; rating?: FeedbackRating } = {}
): Promise<FeedbackEntry[]> {
  const limit = Math.min(options.limit ?? 100, 500);
  if (options.rating) {
    const rows = await query<FeedbackEntry>(
      `SELECT * FROM feedback WHERE rating = $1 ORDER BY created_at DESC LIMIT $2`,
      [options.rating, limit]
    );
    return rows ?? [];
  }
  const rows = await query<FeedbackEntry>(
    `SELECT * FROM feedback ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows ?? [];
}

export async function getFeedbackStats(): Promise<{
  up: number;
  down: number;
  issue: number;
  total: number;
}> {
  const rows = await query<{ rating: FeedbackRating; count: string }>(
    `SELECT rating, COUNT(*)::text AS count FROM feedback GROUP BY rating`
  );
  let up = 0;
  let down = 0;
  let issue = 0;
  for (const row of rows ?? []) {
    if (row.rating === "up") up = Number(row.count);
    if (row.rating === "down") down = Number(row.count);
    if (row.rating === "issue") issue = Number(row.count);
  }
  // total stays the rating count so the satisfaction rate keeps its meaning;
  // problem reports are counted alongside, not folded in.
  return { up, down, issue, total: up + down };
}

// ---------------------------------------------------------------------------
// Admin handling: reply, resolve, defer
// ---------------------------------------------------------------------------

export type FeedbackStatus = "new" | "resolved" | "deferred";

/** Record the admin's reply. Delivery is the caller's job and is reported back. */
export async function saveAdminReply(
  id: number,
  reply: string,
  delivered: boolean
): Promise<FeedbackEntry | null> {
  return queryOne<FeedbackEntry>(
    `UPDATE feedback
     SET admin_reply = $1, admin_reply_at = NOW(), reply_delivered = $2
     WHERE id = $3
     RETURNING *`,
    [reply, delivered, id]
  );
}

export async function setStatus(id: number, status: FeedbackStatus): Promise<FeedbackEntry | null> {
  return queryOne<FeedbackEntry>(
    `UPDATE feedback
     SET status = $1,
         status_changed_at = NOW(),
         -- Clear the reminder clock so a freshly deferred item is not treated
         -- as already reminded today.
         last_reminded_at = NULL
     WHERE id = $2
     RETURNING *`,
    [status, id]
  );
}

/**
 * Deferred items that have not been reported to the admin in the last `hours`.
 * Driven by a stored timestamp rather than a timer so restarts do not reset the
 * schedule or cause a double reminder.
 */
export async function listDeferredDueForReminder(hours: number): Promise<FeedbackEntry[]> {
  const rows = await query<FeedbackEntry>(
    `SELECT * FROM feedback
     WHERE status = 'deferred'
       AND (last_reminded_at IS NULL OR last_reminded_at < NOW() - ($1 || ' hours')::interval)
     ORDER BY created_at ASC`,
    [String(hours)]
  );
  return rows ?? [];
}

export async function markReminded(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await query(`UPDATE feedback SET last_reminded_at = NOW() WHERE id = ANY($1::int[])`, [ids]);
}

/** Undelivered replies for a returning web visitor. */
export async function listPendingWebReplies(webClientId: string): Promise<FeedbackEntry[]> {
  const rows = await query<FeedbackEntry>(
    `SELECT * FROM feedback
     WHERE web_client_id = $1 AND admin_reply IS NOT NULL AND reply_seen_at IS NULL
     ORDER BY admin_reply_at ASC`,
    [webClientId]
  );
  return rows ?? [];
}

export async function markRepliesSeen(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await query(`UPDATE feedback SET reply_seen_at = NOW() WHERE id = ANY($1::int[])`, [ids]);
}

export async function countByStatus(): Promise<Record<string, number>> {
  const rows = await query<{ status: string; count: number | string }>(
    `SELECT COALESCE(status, 'new') AS status, COUNT(*)::int AS count
     FROM feedback WHERE rating = 'issue' GROUP BY COALESCE(status, 'new')`
  );
  const out: Record<string, number> = { new: 0, resolved: 0, deferred: 0 };
  for (const r of rows ?? []) out[r.status] = Number(r.count);
  return out;
}
