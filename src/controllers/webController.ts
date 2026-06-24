import type { Request, Response } from "express";
import { logger } from "../utils/logger";
import { transcribeAudio, type TranscriptionProgress } from "../services/transcriptionService";
import type { TranscriptionResult } from "../types";
import { translateText } from "../services/translationService";
import { cleanupTranscription, detectTranscriptionIssues } from "../services/cleanupService";
import { isValidYouTubeUrl, validateYouTubeUrl, transcribeYouTube } from "../services/youtubeService";
import type { TranslateRequest } from "../types";

const MAX_FILE_BYTES = 25 * 1024 * 1024;

export type WebJobStatus = "pending" | "running" | "completed" | "failed";

export interface WebJob {
  id: string;
  type: "transcribe" | "youtube";
  status: WebJobStatus;
  progress: TranscriptionProgress;
  result?: TranscriptionResult;
  cleanedText?: string;
  translatedText?: string;
  translatedLang?: string;
  translationError?: string;
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

function createJob(type: "transcribe" | "youtube"): WebJob {
  cleanupExpiredJobs();
  const job: WebJob = {
    id: generateJobId(),
    type,
    status: "pending",
    progress: { percent: 0, label: "Starting..." },
    listeners: new Set(),
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

function updateJob(job: WebJob, updates: Partial<WebJob>): void {
  Object.assign(job, updates);
  for (const listener of job.listeners) {
    try {
      listener(job);
    } catch {
      // ignore listener errors
    }
  }
}

function setJobProgress(job: WebJob, progress: TranscriptionProgress): void {
  job.progress = progress;
  updateJob(job, {});
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

    const job = createJob("transcribe");
    res.status(202).json({ jobId: job.id });

    processAudioJob(job, file.buffer, file.originalname, sourceLang, targetLang).catch((err) => {
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

    if (!url || !isValidYouTubeUrl(url)) {
      res.status(400).json({ error: "Missing or invalid YouTube URL" });
      return;
    }

    const validation = await validateYouTubeUrl(url);
    if (!validation.ok) {
      res.status(400).json({ error: validation.reason ?? "unknown", details: validation });
      return;
    }

    const language = sourceLang && sourceLang !== "none" ? sourceLang : "auto";
    const target = targetLang && targetLang !== "none" ? targetLang : undefined;

    const job = createJob("youtube");
    res.status(202).json({ jobId: job.id, title: validation.title });

    processYouTubeJob(job, url, language, target).catch((err) => {
      logger.error("Web YouTube job failed", { error: err instanceof Error ? err.message : String(err), jobId: job.id });
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
    translationError: job.translationError,
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
      translationError: j.translationError,
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
  targetLanguage?: string
): Promise<void> {
  updateJob(job, { status: "running", progress: { percent: 0, label: "Transcribing..." } });

  const result = await transcribeAudio(
    buffer,
    filename,
    language,
    (pid) => updateJob(job, { pid }),
    (progress) => setJobProgress(job, progress)
  );

  await finalizeTranscription(job, result, targetLanguage);
}

async function processYouTubeJob(
  job: WebJob,
  url: string,
  language: string,
  targetLanguage?: string
): Promise<void> {
  updateJob(job, { status: "running", progress: { percent: 0, label: "Starting..." } });

  const result = await transcribeYouTube(
    url,
    language,
    (progress) => setJobProgress(job, progress),
    (pid) => updateJob(job, { pid })
  );

  await finalizeTranscription(job, result, targetLanguage);
}

async function finalizeTranscription(
  job: WebJob,
  result: TranscriptionResult,
  targetLanguage?: string
): Promise<void> {
  if (result.segments.length === 0) {
    updateJob(job, { status: "completed", result });
    return;
  }

  setJobProgress(job, { percent: 95, label: "Finalizing..." });
  const cleanup = await cleanupTranscription(result.text, result.language);
  const cleanedText = cleanup.cleanedText;

  const quality = detectTranscriptionIssues(cleanedText, result.language, result.segments);
  if (quality.isSuspicious) {
    logger.warn("Web transcription quality flags", { jobId: job.id, flags: quality.flags });
  }

  let translatedText: string | undefined;
  let translationError: string | undefined;
  if (targetLanguage && targetLanguage !== result.language && cleanedText) {
    try {
      const translation = await translateText({ text: cleanedText, targetLang: targetLanguage, sourceLang: result.language });
      translatedText = translation.translatedText;
    } catch (err) {
      translationError = err instanceof Error ? err.message : String(err);
      logger.error("Web auto-translation failed", { error: translationError, jobId: job.id });
    }
  }

  updateJob(job, {
    status: "completed",
    result: { ...result, text: cleanedText },
    cleanedText,
    translatedText,
    translatedLang: targetLanguage,
    translationError,
  });
}

// Expose job map for testing/inspection only.
export function getJobs(): Map<string, WebJob> {
  return jobs;
}
