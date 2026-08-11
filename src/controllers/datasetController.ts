import { createReadStream } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import type { Request, Response } from "express";
import { logger } from "../utils/logger";
import { currentAnnotator, hashPassword, passwordProblem, publicAnnotator } from "../services/datasetAuthService";
import { prepareTask, isTaskRunning, removeTaskFiles, resolveInsideDataset } from "../services/datasetPipeline";
import { buildArchive, existingArchive, formatDuration } from "../services/datasetExportService";
import * as repo from "../db/repos/datasetRepo";
import { detectMediaSource } from "../services/youtubeService";

/**
 * The annotation workspace: linguists claim a recording, correct each clip's
 * transcript, and mark the recording finished.
 */

const SUPPORTED_LANGUAGES = new Set(["ky", "ru", "uz", "tg", "en"]);

async function requireAnnotatorOr401(req: Request, res: Response) {
  const annotator = await currentAnnotator(req);
  if (!annotator) {
    res.status(401).json({ error: "Unauthorized", loginRequired: true });
    return null;
  }
  return annotator;
}

function taskView(task: repo.DatasetTask) {
  return {
    id: task.id,
    title: task.title,
    language: task.language,
    sourceKind: task.source_kind,
    sourceUrl: task.source_url,
    status: task.status,
    stage: task.stage,
    progress: task.progress,
    error: task.error_message,
    durationSec: task.duration_sec,
    segmentationMethod: task.segmentation_method,
    segmentCount: task.segment_count,
    reviewedCount: task.reviewed_count,
    ownerId: task.owner_id,
    createdAt: task.created_at,
    completedAt: task.completed_at,
    running: isTaskRunning(task.id),
  };
}

function segmentView(segment: repo.DatasetSegment) {
  return {
    id: segment.id,
    idx: segment.idx,
    clipNumber: Number(segment.clip_number),
    startSec: segment.start_sec,
    endSec: segment.end_sec,
    durationSec: segment.duration_sec,
    asrText: segment.asr_text,
    text: segment.text,
    status: segment.status,
    forcedCut: segment.forced_cut,
    editedBy: segment.edited_by,
    editedAt: segment.edited_at,
  };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export async function listTasks(req: Request, res: Response): Promise<void> {
  const annotator = await requireAnnotatorOr401(req, res);
  if (!annotator) return;

  const [tasks, annotators] = await Promise.all([repo.listTasks(), repo.listAnnotators()]);
  const names = new Map(annotators.map((a) => [a.id, a.display_name]));

  res.json({
    tasks: tasks.map((task) => ({ ...taskView(task), ownerName: task.owner_id ? names.get(task.owner_id) ?? null : null })),
  });
}

function validateNewTask(body: { title?: string; language?: string }): { title: string; language: string } | { error: string } {
  const language = (body.language || "ky").toLowerCase();
  if (!SUPPORTED_LANGUAGES.has(language)) {
    return { error: `Язык ${language} не поддерживается` };
  }
  const title = (body.title || "").trim();
  return { title: title || "Без названия", language };
}

export async function createLinkTask(req: Request, res: Response): Promise<void> {
  const annotator = await requireAnnotatorOr401(req, res);
  if (!annotator) return;

  const { url } = req.body as { url?: string };
  if (!url || !/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: "Нужна ссылка, начинающаяся с http" });
    return;
  }

  const validated = validateNewTask(req.body as { title?: string; language?: string });
  if ("error" in validated) {
    res.status(400).json({ error: validated.error });
    return;
  }

  const task = await repo.createTask({
    title: validated.title === "Без названия" ? `${detectMediaSource(url)}: ${url.slice(0, 120)}` : validated.title,
    language: validated.language,
    sourceKind: "link",
    sourceUrl: url,
    createdBy: annotator.id,
  });

  // Preparation runs for minutes; holding the request open would only give the
  // browser something to time out on. The task row carries the progress.
  void prepareTask(task, { kind: "link", url });

  res.status(202).json({ task: taskView(task) });
}

export async function createUploadTask(req: Request, res: Response): Promise<void> {
  const annotator = await requireAnnotatorOr401(req, res);
  if (!annotator) return;

  const file = (req as Request & { file?: { buffer: Buffer; originalname: string } }).file;
  if (!file) {
    res.status(400).json({ error: "Файл не получен" });
    return;
  }

  const validated = validateNewTask(req.body as { title?: string; language?: string });
  if ("error" in validated) {
    res.status(400).json({ error: validated.error });
    return;
  }

  const task = await repo.createTask({
    title: validated.title === "Без названия" ? file.originalname.slice(0, 200) : validated.title,
    language: validated.language,
    sourceKind: "upload",
    createdBy: annotator.id,
  });

  void prepareTask(task, { kind: "upload", buffer: file.buffer, filename: file.originalname });

  res.status(202).json({ task: taskView(task) });
}

export async function getTask(req: Request, res: Response): Promise<void> {
  const annotator = await requireAnnotatorOr401(req, res);
  if (!annotator) return;

  const task = await repo.getTask(Number(req.params.id));
  if (!task) {
    res.status(404).json({ error: "Задача не найдена" });
    return;
  }

  const segments = await repo.listSegments(task.id);
  res.json({
    task: taskView(task),
    segments: segments.map(segmentView),
    canEdit: canEdit(task, annotator),
  });
}

/**
 * Only the owner edits. Two people typing into the same transcript would
 * overwrite each other with no warning and no way to tell which version was
 * the considered one.
 */
function canEdit(task: repo.DatasetTask, annotator: repo.Annotator): boolean {
  return task.owner_id === null || task.owner_id === annotator.id || annotator.is_admin;
}

export async function claimTask(req: Request, res: Response): Promise<void> {
  const annotator = await requireAnnotatorOr401(req, res);
  if (!annotator) return;

  const task = await repo.getTask(Number(req.params.id));
  if (!task) {
    res.status(404).json({ error: "Задача не найдена" });
    return;
  }

  const release = (req.body as { release?: boolean })?.release === true;
  if (release) {
    if (task.owner_id !== annotator.id && !annotator.is_admin) {
      res.status(403).json({ error: "Задача закреплена за другим лингвистом" });
      return;
    }
    await repo.assignTask(task.id, null);
    res.json({ ok: true, ownerId: null });
    return;
  }

  if (task.owner_id !== null && task.owner_id !== annotator.id && !annotator.is_admin) {
    const owner = await repo.findAnnotatorById(task.owner_id);
    res.status(409).json({ error: `Задачу уже взял: ${owner?.display_name ?? "другой лингвист"}` });
    return;
  }

  await repo.assignTask(task.id, annotator.id);
  res.json({ ok: true, ownerId: annotator.id });
}

export async function completeTask(req: Request, res: Response): Promise<void> {
  const annotator = await requireAnnotatorOr401(req, res);
  if (!annotator) return;

  const task = await repo.getTask(Number(req.params.id));
  if (!task) {
    res.status(404).json({ error: "Задача не найдена" });
    return;
  }
  if (!canEdit(task, annotator)) {
    res.status(403).json({ error: "Задача закреплена за другим лингвистом" });
    return;
  }

  const done = (req.body as { done?: boolean })?.done !== false;
  await repo.setTaskCompletion(task.id, done);
  const updated = await repo.getTask(task.id);
  res.json({ task: updated ? taskView(updated) : null });
}

export async function deleteTask(req: Request, res: Response): Promise<void> {
  const annotator = await requireAnnotatorOr401(req, res);
  if (!annotator) return;
  if (!annotator.is_admin) {
    res.status(403).json({ error: "Удалять задачи может только администратор" });
    return;
  }

  const id = Number(req.params.id);
  const deleted = await repo.deleteTask(id);
  if (!deleted) {
    res.status(404).json({ error: "Задача не найдена" });
    return;
  }
  await removeTaskFiles(id);
  logger.info("Dataset task deleted", { taskId: id, by: annotator.username });
  res.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

export async function updateSegment(req: Request, res: Response): Promise<void> {
  const annotator = await requireAnnotatorOr401(req, res);
  if (!annotator) return;

  const segment = await repo.getSegment(Number(req.params.id));
  if (!segment) {
    res.status(404).json({ error: "Фрагмент не найден" });
    return;
  }

  const task = await repo.getTask(segment.task_id);
  if (!task || !canEdit(task, annotator)) {
    res.status(403).json({ error: "Задача закреплена за другим лингвистом" });
    return;
  }

  const body = req.body as { text?: string; status?: string };
  const status = body.status === "skipped" ? "skipped" : body.status === "pending" ? "pending" : "approved";
  const text = (body.text ?? segment.text).trim();

  if (status === "approved" && text.length === 0) {
    res.status(400).json({ error: "Пустой текст нельзя подтвердить — отметьте фрагмент как брак" });
    return;
  }

  const updated = await repo.updateSegment(segment.id, { text, status, editedBy: annotator.id });
  const reviewed = await repo.refreshReviewedCount(segment.task_id);
  res.json({ segment: updated ? segmentView(updated) : null, reviewedCount: reviewed });
}

export async function getSegmentAudio(req: Request, res: Response): Promise<void> {
  const annotator = await requireAnnotatorOr401(req, res);
  if (!annotator) return;

  const segment = await repo.getSegment(Number(req.params.id));
  if (!segment) {
    res.status(404).json({ error: "Фрагмент не найден" });
    return;
  }

  const filePath = resolveInsideDataset(segment.audio_path);
  if (!filePath) {
    logger.warn("Dataset clip path outside the dataset root", { segmentId: segment.id });
    res.status(400).json({ error: "Некорректный путь к файлу" });
    return;
  }

  let size: number;
  try {
    size = (await fs.stat(filePath)).size;
  } catch {
    res.status(404).json({ error: "Файл фрагмента не найден на диске" });
    return;
  }

  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Accept-Ranges", "bytes");
  // Clips never change once cut, so the browser may keep them for the session.
  res.setHeader("Cache-Control", "private, max-age=3600");

  // Safari refuses to play audio it cannot request by range.
  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : size - 1;
      if (start >= size || end >= size || start > end) {
        res.status(416).setHeader("Content-Range", `bytes */${size}`);
        res.end();
        return;
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      res.setHeader("Content-Length", String(end - start + 1));
      createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }

  res.setHeader("Content-Length", String(size));
  createReadStream(filePath).pipe(res);
}

// ---------------------------------------------------------------------------
// Stats and export
// ---------------------------------------------------------------------------

export async function getStats(req: Request, res: Response): Promise<void> {
  const annotator = await requireAnnotatorOr401(req, res);
  if (!annotator) return;

  const [stats, archive] = await Promise.all([repo.datasetStats(), existingArchive()]);
  res.json({
    ...stats,
    approvedHuman: formatDuration(stats.approvedSeconds),
    archive: archive ? { bytes: archive.bytes, builtAt: archive.builtAt } : null,
  });
}

export async function exportArchive(req: Request, res: Response): Promise<void> {
  const annotator = await requireAnnotatorOr401(req, res);
  if (!annotator) return;
  if (!annotator.is_admin) {
    res.status(403).json({ error: "Выгрузку собирает администратор" });
    return;
  }

  try {
    const summary = await buildArchive();
    res.json({
      clips: summary.clips,
      totalSeconds: summary.totalSeconds,
      totalHuman: formatDuration(summary.totalSeconds),
      bytes: summary.archiveBytes,
      builtAt: summary.builtAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Dataset export failed", { error: message });
    res.status(500).json({ error: message });
  }
}

export async function downloadArchive(req: Request, res: Response): Promise<void> {
  const annotator = await requireAnnotatorOr401(req, res);
  if (!annotator) return;

  const archive = await existingArchive();
  if (!archive) {
    res.status(404).json({ error: "Архив ещё не собран" });
    return;
  }

  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Length", String(archive.bytes));
  res.setHeader("Content-Disposition", `attachment; filename="tiltap_dataset.tar.gz"`);
  createReadStream(archive.path).pipe(res);
}

// ---------------------------------------------------------------------------
// Annotator management (site admin only, mounted under /api/admin)
// ---------------------------------------------------------------------------

export async function adminListAnnotators(_req: Request, res: Response): Promise<void> {
  const annotators = await repo.listAnnotators();
  res.json({ annotators: annotators.map(publicAnnotator) });
}

export async function adminCreateAnnotator(req: Request, res: Response): Promise<void> {
  const { username, displayName, password, isAdmin } = req.body as {
    username?: string;
    displayName?: string;
    password?: string;
    isAdmin?: boolean;
  };

  if (!username || !/^[a-z0-9_.-]{3,64}$/i.test(username)) {
    res.status(400).json({ error: "Логин: 3–64 символа, латиница, цифры, дефис, точка, подчёркивание" });
    return;
  }
  if (!password) {
    res.status(400).json({ error: "Нужен пароль" });
    return;
  }
  const problem = passwordProblem(password);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }

  const created = await repo.createAnnotator({
    username,
    displayName: displayName?.trim() || username,
    passwordHash: await hashPassword(password),
    isAdmin: isAdmin === true,
  });
  if (!created) {
    res.status(409).json({ error: "Такой логин уже занят" });
    return;
  }

  logger.info("Annotator created", { username: created.username });
  res.status(201).json({ annotator: publicAnnotator(created) });
}

export async function adminSetAnnotatorPassword(req: Request, res: Response): Promise<void> {
  const { password } = req.body as { password?: string };
  if (!password) {
    res.status(400).json({ error: "Нужен пароль" });
    return;
  }
  const problem = passwordProblem(password);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }

  const id = Number(req.params.id);
  const annotator = await repo.findAnnotatorById(id);
  if (!annotator) {
    res.status(404).json({ error: "Лингвист не найден" });
    return;
  }

  await repo.setAnnotatorPassword(id, await hashPassword(password));
  res.json({ ok: true });
}

export async function adminSetAnnotatorActive(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id);
  const annotator = await repo.findAnnotatorById(id);
  if (!annotator) {
    res.status(404).json({ error: "Лингвист не найден" });
    return;
  }

  const active = (req.body as { active?: boolean })?.active === true;
  await repo.setAnnotatorActive(id, active);
  res.json({ ok: true, active });
}
