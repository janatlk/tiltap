import { query, queryOne } from "../connection";

export interface TranscriptionRequestEntry {
  id: number;
  request_number: number;
  telegram_chat_id: number | null;
  telegram_message_id: number | null;
  source_type: string | null;
  source_url: string | null;
  filename: string | null;
  language: string | null;
  full_text: string | null;
  segments_json: unknown;
  provider: string | null;
  model: string | null;
  gpu: string | null;
  status: "pending" | "completed" | "error";
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export async function createTranscriptionRequest(payload: {
  telegramChatId?: number;
  telegramMessageId?: number;
  sourceType?: string;
  sourceUrl?: string;
  filename?: string;
  language?: string;
}): Promise<TranscriptionRequestEntry> {
  return queryOne<TranscriptionRequestEntry>(
    `INSERT INTO transcription_requests
       (telegram_chat_id, telegram_message_id, source_type, source_url, filename, language, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     RETURNING *`,
    [
      payload.telegramChatId ?? null,
      payload.telegramMessageId ?? null,
      payload.sourceType ?? null,
      payload.sourceUrl ?? null,
      payload.filename ?? null,
      payload.language ?? null,
    ]
  ) as Promise<TranscriptionRequestEntry>;
}

export async function updateTranscriptionRequest(
  requestNumber: number,
  updates: Partial<{
    status: "pending" | "completed" | "error";
    fullText: string;
    segmentsJson: unknown;
    provider: string;
    model: string;
    gpu: string;
    errorMessage: string;
    completedAt: Date;
  }>
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (updates.status !== undefined) {
    fields.push(`status = $${idx++}`);
    values.push(updates.status);
  }
  if (updates.fullText !== undefined) {
    fields.push(`full_text = $${idx++}`);
    values.push(updates.fullText);
  }
  if (updates.segmentsJson !== undefined) {
    fields.push(`segments_json = $${idx++}`);
    values.push(JSON.stringify(updates.segmentsJson));
  }
  if (updates.provider !== undefined) {
    fields.push(`provider = $${idx++}`);
    values.push(updates.provider);
  }
  if (updates.model !== undefined) {
    fields.push(`model = $${idx++}`);
    values.push(updates.model);
  }
  if (updates.gpu !== undefined) {
    fields.push(`gpu = $${idx++}`);
    values.push(updates.gpu);
  }
  if (updates.errorMessage !== undefined) {
    fields.push(`error_message = $${idx++}`);
    values.push(updates.errorMessage);
  }
  if (updates.completedAt !== undefined) {
    fields.push(`completed_at = $${idx++}`);
    values.push(updates.completedAt);
  }

  if (fields.length === 0) return;

  fields.push(`updated_at = NOW()`);
  values.push(requestNumber);

  await queryOne(
    `UPDATE transcription_requests SET ${fields.join(", ")} WHERE request_number = $${idx}`,
    values
  );
}

export async function getTranscriptionRequestByNumber(
  requestNumber: number
): Promise<TranscriptionRequestEntry | null> {
  return queryOne<TranscriptionRequestEntry>(
    `SELECT * FROM transcription_requests WHERE request_number = $1 LIMIT 1`,
    [requestNumber]
  );
}

export async function listTranscriptionRequests(limit = 100): Promise<TranscriptionRequestEntry[]> {
  const rows = await query<TranscriptionRequestEntry>(
    `SELECT * FROM transcription_requests
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows ?? [];
}

export async function listErrorTranscriptionRequests(limit = 100): Promise<TranscriptionRequestEntry[]> {
  const rows = await query<TranscriptionRequestEntry>(
    `SELECT * FROM transcription_requests
     WHERE status = 'error' OR error_message IS NOT NULL
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows ?? [];
}
