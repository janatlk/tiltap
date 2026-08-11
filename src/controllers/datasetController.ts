import { createReadStream } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import type { Request, Response } from "express";
import { logger } from "../utils/logger";
import { currentAnnotator, hashPassword, passwordProblem, publicAnnotator } from "../services/datasetAuthService";
import { verifyPassword } from "../services/adminAuthService";
import { prepareTask, isTaskRunning, removeTaskFiles, resolveInsideDataset } from "../services/datasetPipeline";
import { buildArchive, existingArchive, formatDuration } from "../services/datasetExportService";
import * as repo from "../db/repos/datasetRepo";
import { detectMediaSource } from "../services/youtubeService";
import { ROLES, ROLE_NAMES, can, isRole, isSuperAdmin, roleOf } from "../services/datasetPermissions";

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

/**
 * Тот же вход, но ещё и с проверкой права. Скрыть кнопку на странице — не
 * защита: запрос можно послать и без неё.
 */
async function requireCapability(
  req: Request,
  res: Response,
  capability: Parameters<typeof can>[1],
  message: string
) {
  const annotator = await requireAnnotatorOr401(req, res);
  if (!annotator) return null;
  if (!can(annotator, capability)) {
    res.status(403).json({ error: message });
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
  const annotator = await requireCapability(req, res, "createTask", "Смотритель не может добавлять записи");
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
  const annotator = await requireCapability(req, res, "createTask", "Смотритель не может добавлять записи");
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
  if (!can(annotator, "annotate")) return false;
  return task.owner_id === null || task.owner_id === annotator.id || isSuperAdmin(annotator);
}

/**
 * Отказ должен называть настоящую причину. Смотрителю, которому пишут
 * «закреплена за другим», остаётся искать владельца, которого нет.
 */
function whyCannotEdit(annotator: repo.Annotator): string {
  return can(annotator, "annotate")
    ? "Запись закреплена за другим лингвистом"
    : "Смотритель не может править расшифровки";
}

export async function claimTask(req: Request, res: Response): Promise<void> {
  const annotator = await requireCapability(req, res, "annotate", "Смотритель не может брать записи в работу");
  if (!annotator) return;

  const task = await repo.getTask(Number(req.params.id));
  if (!task) {
    res.status(404).json({ error: "Задача не найдена" });
    return;
  }

  const release = (req.body as { release?: boolean })?.release === true;
  if (release) {
    if (task.owner_id !== annotator.id && !isSuperAdmin(annotator)) {
      res.status(403).json({ error: "Задача закреплена за другим лингвистом" });
      return;
    }
    await repo.assignTask(task.id, null);
    res.json({ ok: true, ownerId: null });
    return;
  }

  if (task.owner_id !== null && task.owner_id !== annotator.id && !isSuperAdmin(annotator)) {
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
    res.status(403).json({ error: whyCannotEdit(annotator) });
    return;
  }

  const done = (req.body as { done?: boolean })?.done !== false;
  await repo.setTaskCompletion(task.id, done);
  const updated = await repo.getTask(task.id);
  res.json({ task: updated ? taskView(updated) : null });
}

export async function deleteTask(req: Request, res: Response): Promise<void> {
  const annotator = await requireCapability(req, res, "deleteTask", "Удалять записи может только супер-админ");
  if (!annotator) return;

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
    res.status(403).json({ error: whyCannotEdit(annotator) });
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
  const annotator = await requireCapability(req, res, "export", "Выгрузку собирает супер-админ");
  if (!annotator) return;

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
  // Скачивание закрыто тем же правом, что и сборка: иначе корпус уносил бы
  // любой, кому дали посмотреть на ход работы.
  const annotator = await requireCapability(req, res, "export", "Скачивать корпус может супер-админ");
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
// Пользователи
// ---------------------------------------------------------------------------

function usernameProblem(username: string | undefined): string | null {
  if (!username || !/^[a-z0-9_.-]{3,64}$/i.test(username)) {
    return "Логин: 3–64 символа, латиница, цифры, дефис, точка, подчёркивание";
  }
  return null;
}

export async function listUsers(req: Request, res: Response): Promise<void> {
  const annotator = await requireCapability(req, res, "manageUsers", "Управлять пользователями может супер-админ");
  if (!annotator) return;

  const users = await repo.listAnnotators();
  res.json({
    users: users.map(publicAnnotator),
    roles: ROLES.map((role) => ({ value: role, label: ROLE_NAMES[role] })),
    meId: annotator.id,
  });
}

export async function createUser(req: Request, res: Response): Promise<void> {
  const annotator = await requireCapability(req, res, "manageUsers", "Управлять пользователями может супер-админ");
  if (!annotator) return;

  const { username, displayName, password, role } = req.body as {
    username?: string;
    displayName?: string;
    password?: string;
    role?: string;
  };

  const badName = usernameProblem(username);
  if (badName) {
    res.status(400).json({ error: badName });
    return;
  }
  const badPassword = password ? passwordProblem(password) : "Нужен пароль";
  if (badPassword) {
    res.status(400).json({ error: badPassword });
    return;
  }
  if (role !== undefined && !isRole(role)) {
    res.status(400).json({ error: "Неизвестная роль" });
    return;
  }

  const created = await repo.createAnnotator({
    username: username as string,
    displayName: displayName?.trim() || (username as string),
    passwordHash: await hashPassword(password as string),
    role: isRole(role) ? role : "annotator",
  });
  if (!created) {
    res.status(409).json({ error: "Такой логин уже занят" });
    return;
  }

  logger.info("Dataset user created", { username: created.username, role: roleOf(created), by: annotator.username });
  res.status(201).json({ user: publicAnnotator(created) });
}

export async function updateUser(req: Request, res: Response): Promise<void> {
  const annotator = await requireCapability(req, res, "manageUsers", "Управлять пользователями может супер-админ");
  if (!annotator) return;

  const target = await repo.findAnnotatorById(Number(req.params.id));
  if (!target) {
    res.status(404).json({ error: "Пользователь не найден" });
    return;
  }

  const { role, displayName, active } = req.body as { role?: string; displayName?: string; active?: boolean };
  if (role !== undefined && !isRole(role)) {
    res.status(400).json({ error: "Неизвестная роль" });
    return;
  }

  // Снять последнего супер-админа — значит запереть дверь снаружи: управлять
  // людьми станет некому, и чинить это придётся руками в базе.
  const losesAdmin =
    roleOf(target) === "super_admin" && ((isRole(role) && role !== "super_admin") || active === false);
  if (losesAdmin && (await repo.countActiveSuperAdmins()) <= 1) {
    res.status(409).json({ error: "Это последний супер-админ. Сначала назначьте другого." });
    return;
  }

  await repo.updateAnnotator(target.id, {
    displayName,
    role: isRole(role) ? role : undefined,
  });
  if (active !== undefined) {
    await repo.setAnnotatorActive(target.id, active);
  }

  const fresh = await repo.findAnnotatorById(target.id);
  logger.info("Dataset user updated", { username: target.username, by: annotator.username });
  res.json({ user: fresh ? publicAnnotator(fresh) : null });
}

export async function deleteUser(req: Request, res: Response): Promise<void> {
  const annotator = await requireCapability(req, res, "manageUsers", "Управлять пользователями может супер-админ");
  if (!annotator) return;

  const target = await repo.findAnnotatorById(Number(req.params.id));
  if (!target) {
    res.status(404).json({ error: "Пользователь не найден" });
    return;
  }
  if (target.id === annotator.id) {
    res.status(409).json({ error: "Нельзя удалить самого себя" });
    return;
  }
  if (roleOf(target) === "super_admin" && (await repo.countActiveSuperAdmins()) <= 1) {
    res.status(409).json({ error: "Это последний супер-админ. Сначала назначьте другого." });
    return;
  }

  await repo.deleteAnnotator(target.id);
  logger.info("Dataset user deleted", { username: target.username, by: annotator.username });
  res.json({ ok: true });
}

export async function setUserPassword(req: Request, res: Response): Promise<void> {
  const annotator = await requireCapability(req, res, "manageUsers", "Менять чужие пароли может супер-админ");
  if (!annotator) return;

  const target = await repo.findAnnotatorById(Number(req.params.id));
  if (!target) {
    res.status(404).json({ error: "Пользователь не найден" });
    return;
  }

  const { password } = req.body as { password?: string };
  const problem = password ? passwordProblem(password) : "Нужен пароль";
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }

  // Свой пароль меняют, сидя на этой же странице — выкидывать себя незачем.
  const self = target.id === annotator.id;
  await repo.setAnnotatorPassword(target.id, await hashPassword(password as string), !self);
  logger.info("Dataset password changed", { username: target.username, by: annotator.username, self });
  res.json({ ok: true, self });
}

// ---------------------------------------------------------------------------
// Аварийный вход для админа сайта (за requireAdmin, монтируется в /api/admin)
// ---------------------------------------------------------------------------

/**
 * Если единственный супер-админ потерян, изнутри этой страницы починить нечего.
 * Админ сайта, у которого и так есть доступ ко всему, может завести нового.
 */
export async function adminListAnnotators(_req: Request, res: Response): Promise<void> {
  const users = await repo.listAnnotators();
  res.json({ users: users.map(publicAnnotator) });
}

export async function adminCreateAnnotator(req: Request, res: Response): Promise<void> {
  const { username, displayName, password, role } = req.body as {
    username?: string;
    displayName?: string;
    password?: string;
    role?: string;
  };

  const badName = usernameProblem(username);
  if (badName) {
    res.status(400).json({ error: badName });
    return;
  }
  const badPassword = password ? passwordProblem(password) : "Нужен пароль";
  if (badPassword) {
    res.status(400).json({ error: badPassword });
    return;
  }

  const created = await repo.createAnnotator({
    username: username as string,
    displayName: displayName?.trim() || (username as string),
    passwordHash: await hashPassword(password as string),
    role: isRole(role) ? role : "super_admin",
  });
  if (!created) {
    res.status(409).json({ error: "Такой логин уже занят" });
    return;
  }

  logger.info("Dataset user created by site admin", { username: created.username, role: roleOf(created) });
  res.status(201).json({ user: publicAnnotator(created) });
}

/** Смена собственного пароля — доступна всем, включая смотрителя. */
export async function changeOwnPassword(req: Request, res: Response): Promise<void> {
  const annotator = await requireAnnotatorOr401(req, res);
  if (!annotator) return;

  const { currentPassword, password } = req.body as { currentPassword?: string; password?: string };
  const problem = password ? passwordProblem(password) : "Нужен новый пароль";
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }
  if (!currentPassword) {
    res.status(400).json({ error: "Введите текущий пароль" });
    return;
  }

  // Текущий пароль спрашивается и у своей учётки: без этого любой, кто подошёл
  // к незапертому компьютеру, меняет пароль и забирает доступ себе.
  if (!(await verifyPassword(currentPassword, annotator.password_hash))) {
    res.status(403).json({ error: "Текущий пароль неверен" });
    return;
  }

  await repo.setAnnotatorPassword(annotator.id, await hashPassword(password as string), false);
  logger.info("Dataset user changed own password", { username: annotator.username });
  res.json({ ok: true });
}
