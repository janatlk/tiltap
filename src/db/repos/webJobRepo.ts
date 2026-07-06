import { query, queryOne } from "../connection";

export interface WebJobEntry {
  id: number;
  request_number: number;
  job_id: string;
  type: "transcribe" | "youtube";
  status: "pending" | "running" | "completed" | "failed";
  source_lang: string | null;
  target_lang: string | null;
  source_url: string | null;
  source_type: string | null;
  filename: string | null;
  full_text: string | null;
  segments_json: unknown;
  provider: string | null;
  model: string | null;
  gpu: string | null;
  error_message: string | null;
  progress_percent: number | null;
  progress_label: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export async function createWebJob(payload: {
  jobId: string;
  type: "transcribe" | "youtube";
  sourceLang?: string;
  targetLang?: string;
  sourceUrl?: string;
  sourceType?: string;
  filename?: string;
}): Promise<WebJobEntry> {
  return queryOne<WebJobEntry>(
    `INSERT INTO web_jobs
       (job_id, type, status, source_lang, target_lang, source_url, source_type, filename)
     VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      payload.jobId,
      payload.type,
      payload.sourceLang ?? null,
      payload.targetLang ?? null,
      payload.sourceUrl ?? null,
      payload.sourceType ?? null,
      payload.filename ?? null,
    ]
  ) as Promise<WebJobEntry>;
}

export async function updateWebJob(
  jobId: string,
  updates: Partial<Pick<WebJobEntry, "status" | "full_text" | "segments_json" | "provider" | "model" | "gpu" | "error_message" | "progress_percent" | "progress_label" | "completed_at">>
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (updates.status !== undefined) {
    fields.push(`status = $${idx++}`);
    values.push(updates.status);
  }
  if (updates.full_text !== undefined) {
    fields.push(`full_text = $${idx++}`);
    values.push(updates.full_text);
  }
  if (updates.segments_json !== undefined) {
    fields.push(`segments_json = $${idx++}`);
    values.push(JSON.stringify(updates.segments_json));
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
  if (updates.error_message !== undefined) {
    fields.push(`error_message = $${idx++}`);
    values.push(updates.error_message);
  }
  if (updates.progress_percent !== undefined) {
    fields.push(`progress_percent = $${idx++}`);
    values.push(updates.progress_percent);
  }
  if (updates.progress_label !== undefined) {
    fields.push(`progress_label = $${idx++}`);
    values.push(updates.progress_label);
  }
  if (updates.completed_at !== undefined) {
    fields.push(`completed_at = $${idx++}`);
    values.push(updates.completed_at);
  }

  if (fields.length === 0) return;

  fields.push(`updated_at = NOW()`);
  values.push(jobId);

  await queryOne(
    `UPDATE web_jobs SET ${fields.join(", ")} WHERE job_id = $${idx}`,
    values
  );
}

export async function getWebJobById(jobId: string): Promise<WebJobEntry | null> {
  return queryOne<WebJobEntry>(
    `SELECT * FROM web_jobs WHERE job_id = $1 LIMIT 1`,
    [jobId]
  );
}

export async function getWebJobByRequestNumber(requestNumber: number): Promise<WebJobEntry | null> {
  return queryOne<WebJobEntry>(
    `SELECT * FROM web_jobs WHERE request_number = $1 LIMIT 1`,
    [requestNumber]
  );
}

export async function listWebJobs(limit = 100): Promise<WebJobEntry[]> {
  const rows = await query<WebJobEntry>(
    `SELECT * FROM web_jobs
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows ?? [];
}
