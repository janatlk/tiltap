import { query, queryOne } from "../connection";

/**
 * Storage for the annotation corpus: linguists, the recordings they work on,
 * and the individual clips they correct.
 */

export interface Annotator {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  is_admin: boolean;
  active: boolean;
  created_at: Date;
  last_login_at: Date | null;
}

export type TaskStatus = "queued" | "processing" | "ready" | "done" | "failed";
export type SegmentStatus = "pending" | "approved" | "skipped";

export interface DatasetTask {
  id: number;
  title: string;
  language: string;
  source_kind: string;
  source_url: string | null;
  status: TaskStatus;
  stage: string | null;
  progress: number;
  error_message: string | null;
  duration_sec: number | null;
  audio_path: string | null;
  segmentation_method: string | null;
  segment_count: number;
  reviewed_count: number;
  owner_id: number | null;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface DatasetSegment {
  id: number;
  task_id: number;
  idx: number;
  clip_number: string | number;
  start_sec: number;
  end_sec: number;
  duration_sec: number;
  audio_path: string;
  asr_text: string;
  text: string;
  status: SegmentStatus;
  forced_cut: boolean;
  edited_by: number | null;
  edited_at: Date | null;
}

// ---------------------------------------------------------------------------
// Annotators
// ---------------------------------------------------------------------------

export async function findAnnotatorByUsername(username: string): Promise<Annotator | null> {
  return queryOne<Annotator>(
    `SELECT * FROM dataset_annotators WHERE username = $1`,
    [username.trim().toLowerCase()]
  );
}

export async function findAnnotatorById(id: number): Promise<Annotator | null> {
  return queryOne<Annotator>(`SELECT * FROM dataset_annotators WHERE id = $1`, [id]);
}

export async function listAnnotators(): Promise<Annotator[]> {
  return query<Annotator>(`SELECT * FROM dataset_annotators ORDER BY display_name`);
}

export async function createAnnotator(payload: {
  username: string;
  displayName: string;
  passwordHash: string;
  isAdmin?: boolean;
}): Promise<Annotator | null> {
  return queryOne<Annotator>(
    `INSERT INTO dataset_annotators (username, display_name, password_hash, is_admin)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (username) DO NOTHING
     RETURNING *`,
    [payload.username.trim().toLowerCase(), payload.displayName.trim(), payload.passwordHash, payload.isAdmin ?? false]
  );
}

export async function setAnnotatorPassword(id: number, passwordHash: string): Promise<void> {
  await query(`UPDATE dataset_annotators SET password_hash = $2 WHERE id = $1`, [id, passwordHash]);
}

export async function setAnnotatorActive(id: number, active: boolean): Promise<void> {
  await query(`UPDATE dataset_annotators SET active = $2 WHERE id = $1`, [id, active]);
  if (!active) {
    // Deactivating has to cut live sessions too, or the account stays usable
    // until the cookie happens to expire.
    await query(`DELETE FROM dataset_sessions WHERE annotator_id = $1`, [id]);
  }
}

export async function touchAnnotatorLogin(id: number): Promise<void> {
  await query(`UPDATE dataset_annotators SET last_login_at = NOW() WHERE id = $1`, [id]);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function createAnnotatorSession(
  tokenHash: string,
  annotatorId: number,
  hours: number,
  ip: string
): Promise<void> {
  await query(
    `INSERT INTO dataset_sessions (token_hash, annotator_id, expires_at, ip)
     VALUES ($1, $2, NOW() + ($3 || ' hours')::interval, $4)`,
    [tokenHash, annotatorId, String(hours), ip]
  );
}

export async function resolveAnnotatorSession(tokenHash: string): Promise<Annotator | null> {
  const session = await queryOne<{ annotator_id: number }>(
    `UPDATE dataset_sessions SET last_seen_at = NOW()
     WHERE token_hash = $1 AND expires_at > NOW()
     RETURNING annotator_id`,
    [tokenHash]
  );
  if (!session) return null;

  const annotator = await findAnnotatorById(session.annotator_id);
  // A session outlives a deactivation otherwise: the row is still valid, but
  // the person behind it is not.
  return annotator?.active ? annotator : null;
}

export async function destroyAnnotatorSession(tokenHash: string): Promise<void> {
  await query(`DELETE FROM dataset_sessions WHERE token_hash = $1`, [tokenHash]);
}

export async function purgeExpiredAnnotatorSessions(): Promise<void> {
  await query(`DELETE FROM dataset_sessions WHERE expires_at < NOW()`);
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export async function createTask(payload: {
  title: string;
  language: string;
  sourceKind: "link" | "upload";
  sourceUrl?: string | null;
  createdBy: number;
}): Promise<DatasetTask> {
  const row = await queryOne<DatasetTask>(
    `INSERT INTO dataset_tasks (title, language, source_kind, source_url, created_by, owner_id)
     VALUES ($1, $2, $3, $4, $5, $5)
     RETURNING *`,
    [payload.title.slice(0, 300), payload.language, payload.sourceKind, payload.sourceUrl ?? null, payload.createdBy]
  );
  if (!row) throw new Error("Failed to create dataset task");
  return row;
}

export async function listTasks(): Promise<DatasetTask[]> {
  return query<DatasetTask>(`SELECT * FROM dataset_tasks ORDER BY created_at DESC LIMIT 200`);
}

export async function getTask(id: number): Promise<DatasetTask | null> {
  return queryOne<DatasetTask>(`SELECT * FROM dataset_tasks WHERE id = $1`, [id]);
}

export async function updateTaskProgress(
  id: number,
  patch: { status?: TaskStatus; stage?: string | null; progress?: number; errorMessage?: string | null }
): Promise<void> {
  await query(
    `UPDATE dataset_tasks SET
       status = COALESCE($2, status),
       stage = COALESCE($3, stage),
       progress = COALESCE($4, progress),
       error_message = COALESCE($5, error_message),
       updated_at = NOW()
     WHERE id = $1`,
    [id, patch.status ?? null, patch.stage ?? null, patch.progress ?? null, patch.errorMessage ?? null]
  );
}

export async function markTaskReady(
  id: number,
  info: { durationSec: number; audioPath: string; method: string; segmentCount: number }
): Promise<void> {
  await query(
    `UPDATE dataset_tasks SET
       status = 'ready', stage = NULL, progress = 100, error_message = NULL,
       duration_sec = $2, audio_path = $3, segmentation_method = $4, segment_count = $5,
       updated_at = NOW()
     WHERE id = $1`,
    [id, info.durationSec, info.audioPath, info.method, info.segmentCount]
  );
}

export async function markTaskFailed(id: number, message: string): Promise<void> {
  await query(
    `UPDATE dataset_tasks SET status = 'failed', stage = NULL, error_message = $2, updated_at = NOW()
     WHERE id = $1`,
    [id, message.slice(0, 1000)]
  );
}

/** Flip between ready and done without losing the reviewed counter. */
export async function setTaskCompletion(id: number, done: boolean): Promise<void> {
  await query(
    `UPDATE dataset_tasks SET
       status = $2, completed_at = $3, updated_at = NOW()
     WHERE id = $1`,
    [id, done ? "done" : "ready", done ? new Date() : null]
  );
}

export async function assignTask(id: number, ownerId: number | null): Promise<void> {
  await query(`UPDATE dataset_tasks SET owner_id = $2, updated_at = NOW() WHERE id = $1`, [id, ownerId]);
}

export async function refreshReviewedCount(taskId: number): Promise<number> {
  const row = await queryOne<{ reviewed: number | string }>(
    `UPDATE dataset_tasks SET
       reviewed_count = (SELECT COUNT(*) FROM dataset_segments WHERE task_id = $1 AND status <> 'pending'),
       updated_at = NOW()
     WHERE id = $1
     RETURNING reviewed_count AS reviewed`,
    [taskId]
  );
  return Number(row?.reviewed ?? 0);
}

export async function deleteTask(id: number): Promise<DatasetTask | null> {
  return queryOne<DatasetTask>(`DELETE FROM dataset_tasks WHERE id = $1 RETURNING *`, [id]);
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

export async function nextClipNumber(): Promise<number> {
  const row = await queryOne<{ n: string | number }>(`SELECT nextval('dataset_clip_number_seq') AS n`);
  return Number(row?.n ?? 0);
}

export async function insertSegment(payload: {
  taskId: number;
  idx: number;
  clipNumber: number;
  startSec: number;
  endSec: number;
  audioPath: string;
  asrText: string;
  forcedCut: boolean;
}): Promise<void> {
  await query(
    `INSERT INTO dataset_segments
       (task_id, idx, clip_number, start_sec, end_sec, duration_sec, audio_path, asr_text, text, forced_cut)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)
     ON CONFLICT (task_id, idx) DO NOTHING`,
    [
      payload.taskId,
      payload.idx,
      payload.clipNumber,
      payload.startSec,
      payload.endSec,
      payload.endSec - payload.startSec,
      payload.audioPath,
      payload.asrText,
      payload.forcedCut,
    ]
  );
}

export async function listSegments(taskId: number): Promise<DatasetSegment[]> {
  return query<DatasetSegment>(
    `SELECT * FROM dataset_segments WHERE task_id = $1 ORDER BY idx`,
    [taskId]
  );
}

export async function getSegment(id: number): Promise<DatasetSegment | null> {
  return queryOne<DatasetSegment>(`SELECT * FROM dataset_segments WHERE id = $1`, [id]);
}

export async function updateSegment(
  id: number,
  patch: { text: string; status: SegmentStatus; editedBy: number }
): Promise<DatasetSegment | null> {
  return queryOne<DatasetSegment>(
    `UPDATE dataset_segments SET text = $2, status = $3, edited_by = $4, edited_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, patch.text, patch.status, patch.editedBy]
  );
}

/** Everything approved, for export. */
export async function listApprovedSegments(): Promise<(DatasetSegment & { language: string; task_title: string })[]> {
  return query<DatasetSegment & { language: string; task_title: string }>(
    `SELECT s.*, t.language, t.title AS task_title
     FROM dataset_segments s
     JOIN dataset_tasks t ON t.id = s.task_id
     WHERE s.status = 'approved' AND LENGTH(TRIM(s.text)) > 0
     ORDER BY s.clip_number`
  );
}

export async function datasetStats(): Promise<{
  tasks: number;
  segments: number;
  approved: number;
  approvedSeconds: number;
}> {
  const row = await queryOne<{
    tasks: string | number;
    segments: string | number;
    approved: string | number;
    approved_seconds: string | number | null;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM dataset_tasks) AS tasks,
       (SELECT COUNT(*) FROM dataset_segments) AS segments,
       (SELECT COUNT(*) FROM dataset_segments WHERE status = 'approved') AS approved,
       (SELECT COALESCE(SUM(duration_sec), 0) FROM dataset_segments WHERE status = 'approved') AS approved_seconds`
  );
  return {
    tasks: Number(row?.tasks ?? 0),
    segments: Number(row?.segments ?? 0),
    approved: Number(row?.approved ?? 0),
    approvedSeconds: Number(row?.approved_seconds ?? 0),
  };
}
