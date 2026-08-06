import type { Request, Response } from "express";
import { logger } from "../utils/logger";
import { config } from "../config";
import * as translationRepo from "../db/repos/translationRepo";
import * as webJobRepo from "../db/repos/webJobRepo";
import * as feedbackRepo from "../db/repos/feedbackRepo";
import * as glossaryRepo from "../db/repos/glossaryRepo";
import { confirmTranslation, findGlossaryMatches } from "../services/translationService";
import { getActiveProcesses } from "../services/telegramService";
import { getRemoteSttQueueStatus } from "../services/remoteSttService";
import { replyToFeedback } from "../services/feedbackReplyService";
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

function mapFeedback(r: feedbackRepo.FeedbackEntry) {
  return {
    id: r.id,
    requestNumber: r.request_number,
    source: r.source,
    rating: r.rating,
    category: r.category,
    comment: r.comment,
    telegramChatId: r.telegram_chat_id,
    telegramUsername: r.telegram_username,
    telegramName: r.telegram_name,
    webClientId: r.web_client_id,
    jobId: r.job_id,
    sourceType: r.source_type,
    sourceUrl: r.source_url,
    sourceLang: r.source_lang,
    targetLang: r.target_lang,
    provider: r.provider,
    model: r.model,
    interfaceLang: r.interface_lang,
    createdAt: r.created_at,
    status: r.status || "new",
    adminReply: r.admin_reply,
    adminReplyAt: r.admin_reply_at,
    // Telegram reports can be answered directly; web reports have no push
    // channel, so the panel must show whether the answer actually went out.
    replyDelivered: r.reply_delivered,
  };
}

export async function listFeedbackEntries(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const ratingParam = String(req.query.rating || "");
    const rating =
      ratingParam === "up" || ratingParam === "down" || ratingParam === "issue"
        ? (ratingParam as feedbackRepo.FeedbackRating)
        : undefined;

    const [items, stats] = await Promise.all([
      feedbackRepo.listFeedback({ limit, rating }),
      feedbackRepo.getFeedbackStats(),
    ]);

    res.json({ count: items.length, stats, items: items.map(mapFeedback) });
  } catch (err) {
    logger.error("Admin list feedback error", { error: err instanceof Error ? err.message : String(err) });
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

// ---------------------------------------------------------------------------
// Translation glossary
// ---------------------------------------------------------------------------

export async function listGlossary(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { sourceLang, targetLang } = req.query as { sourceLang?: string; targetLang?: string };
  try {
    const [entries, directions] = await Promise.all([
      glossaryRepo.listAll(sourceLang, targetLang),
      glossaryRepo.listDirections(),
    ]);
    res.json({ entries, directions });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Failed to list glossary", { error: message });
    res.status(500).json({ error: message });
  }
}

export async function saveGlossaryEntry(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { sourceLang, targetLang, term, translation, note, enabled } = req.body as {
    sourceLang?: string;
    targetLang?: string;
    term?: string;
    translation?: string;
    note?: string;
    enabled?: boolean;
  };

  if (!sourceLang || !targetLang || !term?.trim() || !translation?.trim()) {
    res.status(400).json({ error: "sourceLang, targetLang, term and translation are required" });
    return;
  }
  if (sourceLang === targetLang) {
    res.status(400).json({ error: "sourceLang and targetLang must differ" });
    return;
  }

  try {
    const entry = await glossaryRepo.upsertEntry({ sourceLang, targetLang, term, translation, note, enabled });
    logger.info("Glossary entry saved", { sourceLang, targetLang, term });
    res.json({ entry });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Failed to save glossary entry", { error: message });
    res.status(500).json({ error: message });
  }
}

export async function deleteGlossaryEntry(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  try {
    const deleted = await glossaryRepo.deleteEntry(id);
    res.json({ deleted });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Failed to delete glossary entry", { error: message });
    res.status(500).json({ error: message });
  }
}

/**
 * Show which glossary terms a given text would trigger, without translating.
 * Matching is prefix-based to survive Kyrgyz and Uzbek suffixes, which makes
 * false positives possible — this is how an admin checks for them.
 */
export async function previewGlossaryMatches(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { text, sourceLang, targetLang } = req.body as {
    text?: string;
    sourceLang?: string;
    targetLang?: string;
  };
  if (!text?.trim() || !sourceLang || !targetLang) {
    res.status(400).json({ error: "text, sourceLang and targetLang are required" });
    return;
  }
  try {
    const entries = await glossaryRepo.listForDirection(sourceLang, targetLang);
    res.json({ available: entries.length, matches: findGlossaryMatches(text, entries) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
}

// ---------------------------------------------------------------------------
// Problem reports: reply and triage
// ---------------------------------------------------------------------------

export async function replyToFeedbackEntry(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const id = Number(req.params.id);
  const { reply } = req.body as { reply?: string };
  if (!Number.isInteger(id) || !reply?.trim()) {
    res.status(400).json({ error: "id and reply are required" });
    return;
  }
  try {
    const result = await replyToFeedback(id, reply.trim());
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Failed to reply to feedback", { id, error: message });
    res.status(500).json({ error: message });
  }
}

export async function setFeedbackStatus(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const id = Number(req.params.id);
  const { status } = req.body as { status?: string };
  if (!Number.isInteger(id) || !status || !["new", "resolved", "deferred"].includes(status)) {
    res.status(400).json({ error: "status must be one of: new, resolved, deferred" });
    return;
  }
  try {
    const entry = await feedbackRepo.setStatus(id, status as feedbackRepo.FeedbackStatus);
    logger.info("Feedback status changed", { id, status });
    res.json({ entry, counts: await feedbackRepo.countByStatus() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Failed to set feedback status", { id, error: message });
    res.status(500).json({ error: message });
  }
}
