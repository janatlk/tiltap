import type { Request, Response } from "express";
import { logger } from "../utils/logger";
import { config } from "../config";
import * as translationRepo from "../db/repos/translationRepo";
import * as webJobRepo from "../db/repos/webJobRepo";
import { confirmTranslation } from "../services/translationService";
import { getActiveProcesses } from "../services/telegramService";
import { getRemoteSttQueueStatus } from "../services/remoteSttService";
import { getJobs } from "./webController";

function isAuthorized(req: Request): boolean {
  const token = config.TILTAB_ADMIN_TOKEN;
  // Admin token is mandatory. Without it, no admin data is exposed.
  if (!token) {
    return false;
  }
  // Only accept the token via a custom header. Query-string tokens would leak
  // in browser history, server logs, and referrer headers.
  const provided = req.headers["x-admin-token"];
  return provided === token;
}

function mapEntry(r: translationRepo.TranslationCacheEntry) {
  return {
    id: r.id,
    sourceHash: r.source_hash,
    sourceText: r.source_text,
    sourceLang: r.source_lang,
    targetLang: r.target_lang,
    translatedText: r.translated_text,
    provider: r.provider,
    model: r.model,
    status: r.status,
    sourceUrl: r.source_url,
    sourceType: r.source_type,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    confirmedAt: r.confirmed_at,
    confirmedBy: r.confirmed_by,
    rejectedAt: r.rejected_at,
    rejectedBy: r.rejected_by,
    errorMessage: r.error_message,
    errorAt: r.error_at,
    requestNumber: r.request_number,
  };
}

export async function listPendingTranslations(_req: Request, res: Response): Promise<void> {
  if (!isAuthorized(_req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const limit = Math.min(Number(_req.query.limit) || 100, 500);
    const rows = await translationRepo.listPendingTranslations(limit);
    res.json({ count: rows.length, items: rows.map(mapEntry) });
  } catch (err) {
    logger.error("Admin pending translations error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function listConfirmedTranslations(_req: Request, res: Response): Promise<void> {
  if (!isAuthorized(_req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const limit = Math.min(Number(_req.query.limit) || 100, 500);
    const rows = await translationRepo.listConfirmedTranslations(limit);
    res.json({ count: rows.length, items: rows.map(mapEntry) });
  } catch (err) {
    logger.error("Admin confirmed translations error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function listRejectedTranslations(_req: Request, res: Response): Promise<void> {
  if (!isAuthorized(_req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const limit = Math.min(Number(_req.query.limit) || 100, 500);
    const rows = await translationRepo.listRejectedTranslations(limit);
    res.json({ count: rows.length, items: rows.map(mapEntry) });
  } catch (err) {
    logger.error("Admin rejected translations error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function listErrorTranslations(_req: Request, res: Response): Promise<void> {
  if (!isAuthorized(_req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const limit = Math.min(Number(_req.query.limit) || 100, 500);
    const rows = await translationRepo.listErrorTranslations(limit);
    res.json({ count: rows.length, items: rows.map(mapEntry) });
  } catch (err) {
    logger.error("Admin error translations error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function confirmTranslationEntry(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const sourceHash = String(req.params.hash || req.body.sourceHash || "");
    const targetLang = String(req.params.lang || req.body.targetLang || "");
    const translatedText = req.body.translatedText;
    const confirmedBy = req.body.confirmedBy || req.headers["x-admin-user"] || "admin";

    if (!sourceHash || !targetLang) {
      res.status(400).json({ error: "Missing sourceHash or targetLang" });
      return;
    }

    const entry = await confirmTranslation({
      sourceHash,
      targetLang,
      confirmedBy: String(confirmedBy),
      translatedText: typeof translatedText === "string" ? translatedText : undefined,
    });

    if (!entry) {
      res.status(404).json({ error: "Translation entry not found" });
      return;
    }

    res.json({ success: true, entry: mapEntry(entry) });
  } catch (err) {
    logger.error("Admin confirm translation error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function rejectTranslationEntry(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const sourceHash = String(req.params.hash || "");
    const targetLang = String(req.params.lang || "");
    const rejectedBy = req.body.rejectedBy || req.headers["x-admin-user"] || "admin";

    if (!sourceHash || !targetLang) {
      res.status(400).json({ error: "Missing sourceHash or targetLang" });
      return;
    }

    const entry = await translationRepo.rejectTranslationCache({
      sourceHash,
      targetLang,
      rejectedBy: String(rejectedBy),
    });

    if (!entry) {
      res.status(404).json({ error: "Translation entry not found" });
      return;
    }

    res.json({ success: true, entry: mapEntry(entry) });
  } catch (err) {
    logger.error("Admin reject translation error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function deleteTranslationEntry(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const sourceHash = String(req.params.hash || "");
    const targetLang = String(req.params.lang || "");
    if (!sourceHash || !targetLang) {
      res.status(400).json({ error: "Missing sourceHash or targetLang" });
      return;
    }
    await translationRepo.deleteTranslationCache(sourceHash, targetLang);
    res.json({ success: true, message: "Translation entry deleted" });
  } catch (err) {
    logger.error("Admin delete translation error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function getTranslationEntry(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const sourceHash = String(req.params.hash || "");
    const targetLang = String(req.params.lang || "");
    if (!sourceHash || !targetLang) {
      res.status(400).json({ error: "Missing sourceHash or targetLang" });
      return;
    }
    const entry = await translationRepo.getTranslationCache(sourceHash, targetLang);
    if (!entry) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(mapEntry(entry));
  } catch (err) {
    logger.error("Admin get translation error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function searchTranslationByRequestNumber(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const requestNumber = Number(req.params.number);
    if (!Number.isFinite(requestNumber) || requestNumber <= 0) {
      res.status(400).json({ error: "Invalid request number" });
      return;
    }

    let entry = await translationRepo.findTranslationByRequestNumber(requestNumber);
    if (!entry) {
      entry = await translationRepo.findTranslationRequestByNumber(requestNumber);
    }

    if (!entry) {
      res.status(404).json({ error: "Request not found" });
      return;
    }

    res.json({ found: true, entry: mapEntry(entry) });
  } catch (err) {
    logger.error("Admin search by request number error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}

function mapWebJobEntry(r: webJobRepo.WebJobEntry) {
  return {
    id: r.id,
    requestNumber: r.request_number,
    jobId: r.job_id,
    type: r.type,
    status: r.status,
    sourceLang: r.source_lang,
    targetLang: r.target_lang,
    sourceUrl: r.source_url,
    sourceType: r.source_type,
    filename: r.filename,
    fullText: r.full_text,
    segments: r.segments_json,
    provider: r.provider,
    model: r.model,
    gpu: r.gpu,
    errorMessage: r.error_message,
    progressPercent: r.progress_percent,
    progressLabel: r.progress_label,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  };
}

export async function listWebJobs(_req: Request, res: Response): Promise<void> {
  if (!isAuthorized(_req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const limit = Math.min(Number(_req.query.limit) || 100, 500);
    const rows = await webJobRepo.listWebJobs(limit);
    res.json({ count: rows.length, items: rows.map(mapWebJobEntry) });
  } catch (err) {
    logger.error("Admin list web jobs error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function getWebJobByRequestNumber(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const requestNumber = Number(req.params.number);
    if (!Number.isFinite(requestNumber) || requestNumber <= 0) {
      res.status(400).json({ error: "Invalid request number" });
      return;
    }

    const entry = await webJobRepo.getWebJobByRequestNumber(requestNumber);
    if (!entry) {
      res.status(404).json({ error: "STT job not found" });
      return;
    }

    res.json({ found: true, entry: mapWebJobEntry(entry) });
  } catch (err) {
    logger.error("Admin get web job by request number error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function getLiveProcesses(_req: Request, res: Response): Promise<void> {
  if (!isAuthorized(_req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const jobs = getJobs();
    const webJobs = Array.from(jobs.values()).map((job) => ({
      id: job.id,
      requestNumber: job.requestNumber,
      type: job.type,
      status: job.status,
      progress: job.progress,
      sourceLang: job.sourceLang ?? job.result?.language,
      targetLang: job.targetLang,
      sourceUrl: job.sourceUrl,
      filename: job.filename,
      pid: job.pid,
      provider: job.result?.provider,
      model: job.result?.model,
      gpu: job.result?.gpu,
      createdAt: job.createdAt,
    }));

    const telegramProcesses = Array.from(getActiveProcesses().entries()).map(([chatId, proc]) => ({
      chatId,
      type: proc.type,
      pid: proc.pid,
      language: proc.language,
      filename: proc.filename,
      sourceUrl: proc.sourceUrl,
      startTime: proc.startTime,
      durationMs: Date.now() - proc.startTime,
    }));

    const remoteStt = getRemoteSttQueueStatus();

    res.json({
      webJobs,
      telegramProcesses,
      remoteStt,
      timestamp: Date.now(),
    });
  } catch (err) {
    logger.error("Admin live processes error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}

import {
  getConfiguredCobaltUrls,
  setConfiguredCobaltUrls,
  testCobaltApiUrl,
} from "../services/cobaltConfigService";

export async function getCobaltConfig(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const urls = getConfiguredCobaltUrls();
    res.json({ urls, configured: urls.length > 0 });
  } catch (err) {
    logger.error("Admin get cobalt config error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function saveCobaltConfig(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const urls = Array.isArray(req.body.urls) ? req.body.urls : [];
    const saved = setConfiguredCobaltUrls(urls);
    logger.info("Cobalt API URLs updated", { count: saved.length, urls: saved });
    res.json({ urls: saved, configured: saved.length > 0 });
  } catch (err) {
    logger.error("Admin save cobalt config error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function testCobaltConfig(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const url = String(req.body.url || "");
    const testUrl = req.body.testUrl ? String(req.body.testUrl) : undefined;
    if (!url) {
      res.status(400).json({ error: "Missing url" });
      return;
    }
    const result = await testCobaltApiUrl(url, testUrl);
    res.json(result);
  } catch (err) {
    logger.error("Admin test cobalt config error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}
