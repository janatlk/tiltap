import type { Request, Response } from "express";
import { logger } from "../utils/logger";
import { transcribeAudio, type TranscriptionProgress } from "../services/transcriptionService";
import type { TranscriptionResult } from "../types";
import { translateText } from "../services/translationService";
import { cleanupTranscription, detectTranscriptionIssues } from "../services/cleanupService";
import { isSupportedMediaUrl, validateMediaUrl, transcribeMediaLink } from "../services/youtubeService";
import type { TranslateRequest } from "../types";
import * as webJobRepo from "../db/repos/webJobRepo";
import * as translationRepo from "../db/repos/translationRepo";
import {
  createFeedback,
  updateFeedback,
  type FeedbackEntry,
  type FeedbackRating,
} from "../db/repos/feedbackRepo";
import { sendAdminAlert } from "../services/alertService";

const MAX_FILE_BYTES = 25 * 1024 * 1024;

export type WebJobStatus = "pending" | "running" | "completed" | "failed";

export interface WebJob {
  id: string;
  requestNumber?: number;
  type: "transcribe" | "youtube";
  status: WebJobStatus;
  progress: TranscriptionProgress;
  sourceLang?: string;
  targetLang?: string;
  sourceUrl?: string;
  sourceType?: string;
  filename?: string;
  result?: TranscriptionResult;
  cleanedText?: string;
  translatedText?: string;
  translatedLang?: string;
  translationWarning?: string;
  translationError?: string;
  translationRequestId?: number;
  transcriptionId?: number;
  error?: string;
  pid?: number;
  listeners: Set<(job: WebJob) => void>;
  createdAt: number;
}

const jobs = new Map<string, WebJob>();
const JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes

function generateJobId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function cleanupExpiredJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.createdAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}

async function createJob(type: "transcribe" | "youtube", meta: { sourceLang?: string; targetLang?: string; sourceUrl?: string; sourceType?: string; filename?: string } = {}): Promise<WebJob> {
  cleanupExpiredJobs();
  const job: WebJob = {
    id: generateJobId(),
    type,
    status: "pending",
    progress: { percent: 0, label: "Starting..." },
    sourceLang: meta.sourceLang,
    targetLang: meta.targetLang,
    sourceUrl: meta.sourceUrl,
    sourceType: meta.sourceType,
    filename: meta.filename,
    listeners: new Set(),
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);

  try {
    const entry = await webJobRepo.createWebJob({
      jobId: job.id,
      type,
      sourceLang: meta.sourceLang,
      targetLang: meta.targetLang,
      sourceUrl: meta.sourceUrl,
      sourceType: meta.sourceType,
      filename: meta.filename,
    });
    job.requestNumber = entry.request_number;
  } catch (err) {
    logger.error("Failed to create web job audit row", { error: err instanceof Error ? err.message : String(err), jobId: job.id });
  }

  return job;
}

function updateJob(job: WebJob, updates: Partial<WebJob>): void {
  const prevStatus = job.status;
  Object.assign(job, updates);
  for (const listener of job.listeners) {
    try {
      listener(job);
    } catch {
      // ignore listener errors
    }
  }
  if (updates.status && updates.status !== prevStatus) {
    webJobRepo.updateWebJob(job.id, {
      status: updates.status,
      error_message: updates.error,
      completed_at: updates.status === "completed" || updates.status === "failed" ? new Date() : undefined,
    }).catch((err) => {
      logger.error("Failed to persist web job status", { error: err instanceof Error ? err.message : String(err), jobId: job.id });
    });
  }
}

function setJobProgress(job: WebJob, progress: TranscriptionProgress): void {
  job.progress = progress;
  updateJob(job, {});
  webJobRepo.updateWebJob(job.id, {
    progress_percent: Math.round(progress.percent),
    progress_label: progress.label,
  }).catch((err) => {
    logger.error("Failed to persist web job progress", { error: err instanceof Error ? err.message : String(err), jobId: job.id });
  });
}

export function getJob(jobId: string): WebJob | undefined {
  return jobs.get(jobId);
}

export async function handleWebTranscribe(req: Request, res: Response): Promise<void> {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    if (file.size > MAX_FILE_BYTES) {
      res.status(400).json({ error: `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max allowed is 25 MB.` });
      return;
    }

    const sourceLang = typeof req.body.sourceLang === "string" ? req.body.sourceLang : "auto";
    const targetLang = typeof req.body.targetLang === "string" && req.body.targetLang !== "none" ? req.body.targetLang : undefined;

    const job = await createJob("transcribe", {
      sourceLang,
      targetLang,
      filename: file.originalname,
      sourceType: "web_upload",
    });
    res.status(202).json({ jobId: job.id, requestNumber: job.requestNumber });

    processAudioJob(job, file.buffer, file.originalname, sourceLang, targetLang, "web_upload").catch((err) => {
      logger.error("Web transcribe job failed", { error: err instanceof Error ? err.message : String(err), jobId: job.id });
      updateJob(job, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    });
  } catch (err) {
    logger.error("Web transcribe request error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function handleWebYouTube(req: Request, res: Response): Promise<void> {
  try {
    const { url, sourceLang, targetLang } = req.body as { url?: string; sourceLang?: string; targetLang?: string };

    if (!url || !isSupportedMediaUrl(url)) {
      res.status(400).json({ error: "Missing or invalid media URL. Supported: YouTube, TikTok, Instagram Reels" });
      return;
    }

    const validation = await validateMediaUrl(url);
    if (!validation.ok) {
      res.status(400).json({ error: validation.reason ?? "unknown", details: validation });
      return;
    }

    const language = sourceLang && sourceLang !== "none" ? sourceLang : "auto";
    const target = targetLang && targetLang !== "none" ? targetLang : undefined;

    const job = await createJob("youtube", {
      sourceLang: language,
      targetLang: target,
      sourceUrl: url,
      sourceType: "youtube",
    });
    res.status(202).json({ jobId: job.id, requestNumber: job.requestNumber, title: validation.title });

    processMediaLinkJob(job, url, language, target, "youtube").catch((err) => {
      logger.error("Web media link job failed", { error: err instanceof Error ? err.message : String(err), jobId: job.id });
      updateJob(job, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    });
  } catch (err) {
    logger.error("Web YouTube request error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function handleWebTranslate(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as TranslateRequest;
    if (!body.text || typeof body.text !== "string") {
      res.status(400).json({ error: "Missing or invalid 'text' field" });
      return;
    }
    if (!body.targetLang || typeof body.targetLang !== "string") {
      res.status(400).json({ error: "Missing or invalid 'targetLang' field" });
      return;
    }

    const result = await translateText(body);
    res.status(200).json(result);
  } catch (err) {
    logger.error("Web translate error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function handleWebJobStatus(req: Request, res: Response): Promise<void> {
  const job = getJob(String(req.params.jobId));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.status(200).json({
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    result: job.result,
    cleanedText: job.cleanedText,
    translatedText: job.translatedText,
    translatedLang: job.translatedLang,
    translationWarning: job.translationWarning,
    translationError: job.translationError,
    translationRequestId: job.translationRequestId,
    transcriptionId: job.transcriptionId,
    error: job.error,
  });
}

export function handleWebJobProgress(req: Request, res: Response): void {
  const job = getJob(String(req.params.jobId));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const sendUpdate = (j: WebJob): void => {
    res.write(`data: ${JSON.stringify({
      status: j.status,
      progress: j.progress,
      result: j.result,
      cleanedText: j.cleanedText,
      translatedText: j.translatedText,
      translatedLang: j.translatedLang,
      translationWarning: j.translationWarning,
      translationError: j.translationError,
      translationRequestId: j.translationRequestId,
      transcriptionId: j.transcriptionId,
      error: j.error,
    })}\n\n`);
    if (j.status === "completed" || j.status === "failed") {
      res.end();
    }
  };

  sendUpdate(job);
  job.listeners.add(sendUpdate);

  req.on("close", () => {
    job.listeners.delete(sendUpdate);
  });
}

async function processAudioJob(
  job: WebJob,
  buffer: Buffer,
  filename: string,
  language: string,
  targetLanguage?: string,
  sourceType?: string
): Promise<void> {
  updateJob(job, { status: "running", progress: { percent: 0, label: "Transcribing..." } });

  const result = await transcribeAudio(
    buffer,
    filename,
    language,
    (pid) => updateJob(job, { pid }),
    (progress) => setJobProgress(job, progress)
  );

  await finalizeTranscription(job, result, targetLanguage, undefined, sourceType);
}

async function processMediaLinkJob(
  job: WebJob,
  url: string,
  language: string,
  targetLanguage?: string,
  sourceType?: string
): Promise<void> {
  updateJob(job, { status: "running", progress: { percent: 0, label: "Starting..." } });

  const result = await transcribeMediaLink(
    url,
    language,
    (progress) => setJobProgress(job, progress),
    (pid) => updateJob(job, { pid })
  );

  await finalizeTranscription(job, result, targetLanguage, url, sourceType);
}

async function finalizeTranscription(
  job: WebJob,
  result: TranscriptionResult,
  targetLanguage?: string,
  sourceUrl?: string,
  sourceType?: string
): Promise<void> {
  if (result.segments.length === 0) {
    updateJob(job, { status: "completed", result });
    webJobRepo.updateWebJob(job.id, {
      status: "completed",
      full_text: result.text,
      segments_json: result.segments,
      provider: result.provider,
      model: result.model,
      gpu: result.gpu,
      completed_at: new Date(),
    }).catch((err) => {
      logger.error("Failed to persist empty web job result", { error: err instanceof Error ? err.message : String(err), jobId: job.id });
    });
    return;
  }

  setJobProgress(job, { percent: 95, label: "Finalizing..." });
  const cleanup = await cleanupTranscription(result.text, result.language);
  const cleanedText = cleanup.cleanedText;
  const cleanupWarning = cleanup.warning;

  const quality = detectTranscriptionIssues(cleanedText, result.language, result.segments);
  if (quality.isSuspicious) {
    logger.warn("Web transcription quality flags", { jobId: job.id, flags: quality.flags });
  }

  let translatedText: string | undefined;
  let translationWarning: string | undefined;
  let translationError: string | undefined;
  if (targetLanguage && targetLanguage !== result.language && cleanedText) {
    try {
      const translation = await translateText({ text: cleanedText, targetLang: targetLanguage, sourceLang: result.language, sourceUrl, sourceType });
      translatedText = translation.translatedText;
      translationWarning = translation.warning;
      updateJob(job, { translationRequestId: translation.requestId });
    } catch (err) {
      translationError = err instanceof Error ? err.message : String(err);
      logger.error("Web auto-translation failed", { error: translationError, jobId: job.id });
    }
  }

  const transcriptionWarning = (result as TranscriptionResult & { warning?: string }).warning;
  const combinedWarning = [cleanupWarning, transcriptionWarning].filter(Boolean).join("; ") || undefined;

  updateJob(job, {
    status: "completed",
    result: { ...result, text: cleanedText, warning: combinedWarning },
    cleanedText,
    translatedText,
    translatedLang: targetLanguage,
    translationWarning,
    translationError,
  });

  webJobRepo.updateWebJob(job.id, {
    status: "completed",
    full_text: cleanedText,
    segments_json: result.segments,
    provider: result.provider,
    model: result.model,
    gpu: result.gpu,
    completed_at: new Date(),
  }).catch((err) => {
    logger.error("Failed to persist web job result", { error: err instanceof Error ? err.message : String(err), jobId: job.id });
  });
}

// Expose job map for testing/inspection only.
export function getJobs(): Map<string, WebJob> {
  return jobs;
}

const FEEDBACK_CATEGORIES = new Set(["stt", "translation", "download", "speed", "other"]);

/** Alerts go out with parse_mode HTML, so user text must be escaped. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Ping the admin about a negative web rating or a problem report. Positive ones
 * are only stored —
 * the admin panel shows them — so the alert channel stays quiet and useful.
 * The follow-up (reason + comment) arrives as its own message because the user
 * may take a while to type it, and it must not be throttled away.
 */
function alertWebFeedback(entry: FeedbackEntry, isFollowUp = false): void {
  if (entry.rating !== "down" && entry.rating !== "issue") return;
  const header =
    entry.rating === "issue"
      ? "🛠 <b>Сообщение о проблеме (веб)</b>"
      : "👎 <b>Негативный отзыв (веб)</b>";
  const lines = [
    isFollowUp ? "💬 <b>Комментарий к отзыву (веб)</b>" : header,
    entry.request_number ? `Запрос: #${entry.request_number}` : "Запрос: —",
    entry.source_type === "text" ? "Тип: перевод текста" : null,
    entry.source_lang || entry.target_lang
      ? `Пара: ${entry.source_lang ?? "?"} → ${entry.target_lang ?? "?"}`
      : null,
    entry.provider || entry.model ? `Движок: ${entry.provider ?? "?"} / ${entry.model ?? "?"}` : null,
    entry.category ? `Причина: ${entry.category}` : null,
    entry.comment ? `\n«${escapeHtml(entry.comment)}»` : null,
  ].filter(Boolean);
  void sendAdminAlert(
    `feedback-web-${entry.id}${isFollowUp ? "-comment" : ""}`,
    lines.join("\n"),
    0
  );
}

/**
 * Store a rating for a finished web result. The context (request number,
 * languages, engine) is snapshotted onto the feedback row so an admin can judge
 * the complaint without looking anything up.
 *
 * Two kinds of result can be rated. Audio/YouTube runs are jobs and arrive with
 * a jobId. Plain text translation is not a job — it is answered synchronously —
 * so it arrives with only its public request number, and the context is read
 * back from translation_requests rather than taken from the client.
 */
export async function handleWebFeedback(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      jobId?: string;
      requestNumber?: number | string;
      rating?: string;
      category?: string;
      comment?: string;
      clientId?: string;
    };

    const rating: FeedbackRating | null =
      body.rating === "up" || body.rating === "down" || body.rating === "issue" ? body.rating : null;
    if (!rating) {
      res.status(400).json({ error: "rating must be 'up', 'down' or 'issue'" });
      return;
    }

    // A problem report is the text; an empty one carries no information at all.
    if (rating === "issue" && !String(body.comment ?? "").trim()) {
      res.status(400).json({ error: "comment is required for a problem report" });
      return;
    }

    const jobId = body.jobId ? String(body.jobId) : undefined;
    // Prefer the in-memory job; fall back to the persisted row after a restart.
    const job = jobId ? getJob(jobId) : undefined;
    const persisted = !job && jobId ? await webJobRepo.getWebJobById(jobId).catch(() => null) : null;

    // Text translations identify themselves by request number only. Look the row
    // up so provider/model/langs come from what actually ran, not from the page.
    const claimedNumber = Number(body.requestNumber);
    const requestNumber = Number.isInteger(claimedNumber) && claimedNumber > 0 ? claimedNumber : null;
    const translation =
      !job && !persisted && requestNumber
        ? await translationRepo.findTranslationRequestByNumber(requestNumber).catch(() => null)
        : null;

    // Require some identifier, but do not insist the lookup succeeded: an old
    // job may have been evicted from memory, and losing a real complaint is
    // worse than storing one with thin context.
    if (!jobId && !requestNumber) {
      res.status(400).json({ error: "jobId or requestNumber is required" });
      return;
    }

    const category =
      body.category && FEEDBACK_CATEGORIES.has(body.category) ? body.category : undefined;

    const entry = await createFeedback({
      requestNumber: job?.requestNumber ?? persisted?.request_number ?? translation?.request_number ?? null,
      source: "web",
      rating,
      category: category ?? null,
      comment: body.comment ? String(body.comment).trim().slice(0, 2000) : null,
      webClientId: body.clientId ? String(body.clientId).slice(0, 64) : null,
      jobId: jobId ?? null,
      // "text" marks a plain translation, so the admin panel can tell a bad
      // translation apart from a bad transcription without opening the row.
      sourceType: job?.sourceType ?? persisted?.source_type ?? translation?.source_type ?? (requestNumber && !jobId ? "text" : "web"),
      sourceUrl: job?.sourceUrl ?? persisted?.source_url ?? translation?.source_url ?? null,
      sourceLang: job?.sourceLang ?? persisted?.source_lang ?? translation?.source_lang ?? null,
      targetLang: job?.targetLang ?? persisted?.target_lang ?? translation?.target_lang ?? null,
      provider: job?.result?.provider ?? persisted?.provider ?? translation?.provider ?? null,
      model: job?.result?.model ?? persisted?.model ?? translation?.model ?? null,
    });

    logger.info("Web feedback recorded", {
      feedbackId: entry.id,
      rating,
      jobId,
      requestNumber: entry.request_number,
    });

    alertWebFeedback(entry);

    res.json({ ok: true, id: entry.id, requestNumber: entry.request_number });
  } catch (err) {
    logger.error("Web feedback error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * Attach the reason and free-text comment the user supplies after the initial
 * rating. This updates the existing row rather than writing a new one, so a
 * single complaint is counted once.
 */
export async function handleWebFeedbackDetails(req: Request, res: Response): Promise<void> {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid feedback id" });
      return;
    }

    const body = req.body as { category?: string; comment?: string };
    const updates: { category?: string; comment?: string } = {};
    if (body.category && FEEDBACK_CATEGORIES.has(body.category)) updates.category = body.category;
    if (body.comment) {
      const comment = String(body.comment).trim().slice(0, 2000);
      if (comment) updates.comment = comment;
    }

    if (!updates.category && !updates.comment) {
      res.json({ ok: true, id, updated: false });
      return;
    }

    const entry = await updateFeedback(id, updates);
    if (!entry) {
      res.status(404).json({ error: "Feedback not found" });
      return;
    }

    logger.info("Web feedback details added", { feedbackId: id, category: entry.category });
    alertWebFeedback(entry, true);

    res.json({ ok: true, id, updated: true });
  } catch (err) {
    logger.error("Web feedback details error", {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: "Internal server error" });
  }
}
