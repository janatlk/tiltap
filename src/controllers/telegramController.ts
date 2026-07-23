import { Request, Response } from "express";
import { logger } from "../utils/logger";
import { unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { TelegramUpdate, TelegramMessage, TranscriptionResult, TranscriptionSegment, InlineKeyboardButton } from "../types";
import { fetchTelegramFile } from "../services/fileDownloadService";
import { transcribeAudio, formatSubtitles } from "../services/transcriptionService";

import { cleanupTranscription, detectTranscriptionIssues } from "../services/cleanupService";
import { translateText } from "../services/translationService";
import {
  isSupportedMediaUrl,
  validateMediaUrl,
  downloadMediaAudio,
} from "../services/youtubeService";
import { renderLoadingStages } from "../utils/progressBar";

import { combinedAccuracy } from "../utils/textSimilarity";
import { getTestFixture, TEST_FIXTURES, type TestFixture } from "../utils/testFixtures";
import {
  sendTextMessage,
  sendDocument,
  editMessageText,
  deleteMessage,
  answerCallbackQuery,
  createMainKeyboard,
  createSettingsMenuKeyboard,
  createInterfaceLanguageKeyboard,
  createSourceLanguageKeyboard,
  createTargetLanguageKeyboard,
  createConfirmationKeyboard,
  createTestLanguageKeyboard,
  createStopKeyboard,
  createQuickActionsKeyboard,
  createBackToMenuKeyboard,
  ensureUserProfile,
  getUserPreferences,
  setUserInterfaceLanguage,
  setUserSourceLanguage,
  setUserTargetLanguage,
  getPendingAction,
  setPendingAction,
  updatePendingAction,
  clearPendingAction,
  getActiveProcess,
  setActiveProcess,
  clearActiveProcess,
  t,
  escapeHtml,
  type SupportedLanguage,
  type PendingAction,
  type PendingTranslateText,
  type UserPreferences,
  LANGUAGE_LABELS,
  LANGUAGE_FLAGS,
  TEXT_FILE_THRESHOLD,
} from "../services/telegramService";
import {
  createMessage,
  createTranscription,
  saveTranslation,
  type Transcription,
} from "../db/repos";

const FFMPEG_PATH = require("ffmpeg-static");
const PYTHON_PATH = process.platform === "win32" ? "python" : "python3";
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

// Simple in-memory deduplication for Telegram update_ids. Prevents duplicate
// processing when multiple poll forwarders or retries deliver the same update.
const UPDATE_DEDUP_TTL_MS = 5 * 60 * 1000;
const recentUpdateIds = new Map<number, number>();

function isDuplicateUpdate(updateId: number): boolean {
  const now = Date.now();
  // Clean old entries occasionally (simple sweep every ~100 checks)
  if (recentUpdateIds.size % 100 === 0) {
    for (const [id, ts] of recentUpdateIds.entries()) {
      if (now - ts > UPDATE_DEDUP_TTL_MS) recentUpdateIds.delete(id);
    }
  }
  if (recentUpdateIds.has(updateId)) return true;
  recentUpdateIds.set(updateId, now);
  return false;
}

export async function handleTelegramWebhook(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();
  res.sendStatus(200);

  const update = req.body as TelegramUpdate;
  logger.debug("Received Telegram update", { updateId: update.update_id });

  if (isDuplicateUpdate(update.update_id)) {
    logger.warn("Duplicate Telegram update ignored", { updateId: update.update_id });
    return;
  }

  try {
    if (update.message) {
      await handleMessage(update.message, update.update_id);
    } else if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    }
  } catch (err) {
    logger.error("Error processing Telegram update", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }

  const duration = Date.now() - startTime;
  logger.info("Webhook processed", { updateId: update.update_id, durationMs: duration });
}

async function handleMessage(msg: TelegramMessage, updateId: number): Promise<void> {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() ?? "";

  // Ensure user profile exists and detect language on first contact
  const prefs = await ensureUserProfile(chatId, msg.from?.language_code);
  const lang = prefs.interfaceLanguage;

  // Persist every incoming message
  const media = msg.video ?? msg.voice ?? msg.audio ?? msg.document;
  let dbMessageId = 0;
  try {
    const persistedMessage = await createMessage({
      telegramChatId: chatId,
      telegramMessageId: msg.message_id,
      updateId,
      messageType: media ? (msg.video ? "video" : msg.voice ? "voice" : msg.audio ? "audio" : "document") : "text",
      fileId: media?.file_id,
      fileSize: media?.file_size,
      mimeType: msg.document?.mime_type ?? (msg.video ? "video/mp4" : msg.voice ? "audio/ogg" : msg.audio ? "audio/mpeg" : undefined),
      rawPayload: msg as unknown as Record<string, unknown>,
    });
    dbMessageId = persistedMessage.id;
  } catch (err) {
    logger.error("Failed to persist incoming message", { error: err instanceof Error ? err.message : String(err), chatId });
  }

  // Handle commands
  if (text.startsWith("/")) {
    await handleCommand(chatId, text, msg, prefs);
    return;
  }

  // Auto-detect supported media links in plain text
  if (!media && text && isSupportedMediaUrl(text)) {
    await handleMediaLink(chatId, text, prefs);
    return;
  }

  // Plain text — check for an active translate-text action first
  if (!media) {
    const pending = getPendingAction(chatId);
    if (pending?.type === "translate_text") {
      clearPendingAction(chatId);
      await processTextTranslation(chatId, text, pending.targetLanguage, prefs);
      return;
    }
    await sendMainMenu(chatId, prefs);
    return;
  }

  // Validate document mime type
  if (msg.document && msg.document.mime_type) {
    const allowed = ["video/", "audio/"];
    if (!allowed.some((prefix) => msg.document!.mime_type!.startsWith(prefix))) {
      await sendTextMessage(chatId, t("unsupportedFileType", lang), { replyMarkup: createMainKeyboard(lang) });
      return;
    }
  }

  // Validate file size from Telegram metadata
  const knownSize = msg.video?.file_size ?? msg.voice?.file_size ?? msg.audio?.file_size ?? msg.document?.file_size;
  if (knownSize && knownSize > MAX_MEDIA_BYTES) {
    await sendTextMessage(
      chatId,
      t("fileTooLarge", lang, { size: (knownSize / 1024 / 1024).toFixed(1) }),
      { replyMarkup: createMainKeyboard(lang) }
    );
    return;
  }

  // Download and validate size
  const { buffer } = await fetchTelegramFile(media.file_id);
  const filename = msg.video?.file_name ?? msg.audio?.file_name ?? msg.document?.file_name ?? "media.mp4";

  if (buffer.length > MAX_MEDIA_BYTES) {
    await sendTextMessage(
      chatId,
      t("fileTooLarge", lang, { size: (buffer.length / 1024 / 1024).toFixed(1) }),
      { replyMarkup: createMainKeyboard(lang) }
    );
    return;
  }

  // Store pending action and ask for source language first
  const actionId = setPendingAction(chatId, {
    type: "media",
    buffer,
    filename,
    messageId: msg.message_id,
    dbMessageId,
    sourceLanguage: prefs.sourceLanguage,
    targetLanguage: prefs.targetLanguage,
    createdAt: Date.now(),
  });
  await sendTextMessage(chatId, t("chooseSourceLanguage", lang), {
    replyMarkup: createSourceLanguageKeyboard(`confirm:${actionId}`, lang, "action:main"),
  });
}

async function handleCommand(
  chatId: number,
  text: string,
  msg: TelegramMessage,
  prefs?: UserPreferences
): Promise<void> {
  const userPrefs = prefs ?? (await getUserPreferences(chatId));
  const lang = userPrefs.interfaceLanguage;
  const parts = text.split(" ");
  const command = parts[0].toLowerCase();
  const args = parts.slice(1).join(" ").trim();

  switch (command) {
    case "/start":
      await sendMainMenu(chatId, userPrefs, true);
      break;

    case "/help":
      await sendTextMessage(chatId, t("help", lang), { replyMarkup: createMainKeyboard(lang) });
      break;

    case "/settings":
    case "/lang":
      await sendSettingsMenu(chatId, userPrefs);
      break;

    case "/test":
      await sendTextMessage(chatId, t("chooseTestLanguage", lang), {
        replyMarkup: createTestLanguageKeyboard(),
      });
      break;

    case "/youtube":
      if (!args) {
        await askYouTubeLink(chatId, userPrefs);
      } else {
        await handleMediaLink(chatId, args, userPrefs);
      }
      break;

    case "/translate":
      await startTranslateTextFlow(chatId, userPrefs, args || undefined);
      break;

    case "/stop":
      await stopActiveProcess(chatId);
      break;

    default:
      await sendTextMessage(
        chatId,
        `${t("welcome", lang)}\n\n${t("mainMenuHint", lang)}`,
        { replyMarkup: createMainKeyboard(lang) }
      );
  }
}

function buildMainMenuText(lang: SupportedLanguage, isStart = false): string {
  return isStart ? t("welcome", lang) : `${t("welcome", lang)}\n\n${t("mainMenuHint", lang)}`;
}

async function sendMainMenu(chatId: number, prefs: UserPreferences, isStart = false): Promise<void> {
  const lang = prefs.interfaceLanguage;
  await sendTextMessage(chatId, buildMainMenuText(lang, isStart), { replyMarkup: createMainKeyboard(lang) });
}

async function editMainMenu(chatId: number, messageId: number, prefs: UserPreferences): Promise<void> {
  const lang = prefs.interfaceLanguage;
  await editMessageText(chatId, messageId, buildMainMenuText(lang), { replyMarkup: createMainKeyboard(lang) });
}

function buildSettingsMenuText(prefs: UserPreferences): string {
  const lang = prefs.interfaceLanguage;
  const sourceLabel = `${LANGUAGE_FLAGS[prefs.sourceLanguage]} ${LANGUAGE_LABELS[prefs.sourceLanguage]}`;
  const targetLabel = prefs.targetLanguage === "none" ? t("noDefaultTarget", lang) : `${LANGUAGE_FLAGS[prefs.targetLanguage]} ${LANGUAGE_LABELS[prefs.targetLanguage]}`;

  return `${t("settingsMenu", lang)}\n\n` +
    `${t("settingsInterfaceLanguage", lang)}: ${LANGUAGE_FLAGS[lang]} ${LANGUAGE_LABELS[lang]}\n` +
    `${t("settingsSourceLanguage", lang)}: ${sourceLabel}\n` +
    `${t("settingsTargetLanguage", lang)}: ${targetLabel}`;
}

async function sendSettingsMenu(chatId: number, prefs: UserPreferences): Promise<void> {
  const lang = prefs.interfaceLanguage;
  await sendTextMessage(chatId, buildSettingsMenuText(prefs), { replyMarkup: createSettingsMenuKeyboard(lang) });
}

async function editSettingsMenu(chatId: number, messageId: number, prefs: UserPreferences): Promise<void> {
  await editMessageText(chatId, messageId, buildSettingsMenuText(prefs), { replyMarkup: createSettingsMenuKeyboard(prefs.interfaceLanguage) });
}

async function askYouTubeLink(chatId: number, prefs: UserPreferences): Promise<void> {
  const lang = prefs.interfaceLanguage;
  setPendingAction(chatId, {
    type: "youtube",
    url: "",
    sourceLanguage: prefs.sourceLanguage,
    targetLanguage: prefs.targetLanguage,
    createdAt: Date.now(),
  });
  await sendTextMessage(chatId, t("sendYoutubeLink", lang), { replyMarkup: createMainKeyboard(lang) });
}

async function startTranslateTextFlow(chatId: number, prefs: UserPreferences, initialText?: string): Promise<void> {
  const lang = prefs.interfaceLanguage;
  const targetLang = prefs.targetLanguage === "none" ? undefined : prefs.targetLanguage;

  if (initialText && targetLang) {
    await processTextTranslation(chatId, initialText, targetLang, prefs);
    return;
  }

  const actionId = setPendingAction(chatId, {
    type: "translate_text",
    targetLanguage: targetLang ?? "ru",
    createdAt: Date.now(),
  });

  await sendTextMessage(chatId, t("chooseTranslationTargetLanguage", lang), {
    replyMarkup: createTargetLanguageKeyboard(`translate_text:${actionId}`, lang, "action:main"),
  });
}

async function processTextTranslation(
  chatId: number,
  text: string,
  targetLang: SupportedLanguage,
  prefs: UserPreferences
): Promise<void> {
  const lang = prefs.interfaceLanguage;
  const statusMessageId = await sendTextMessage(chatId, t("translating", lang), {
    replyMarkup: createMainKeyboard(lang),
  });

  try {
    const result = await translateText({
      text,
      targetLang,
      sourceUrl: undefined,
      sourceType: "telegram_text",
    });

    const caption = result.requestId ? `#${result.requestId}` : "";
    const outputText = result.translatedText;

    if (outputText.length > TEXT_FILE_THRESHOLD) {
      const fs = await import("fs/promises");
      const buffer = Buffer.from(outputText, "utf-8");
      await sendDocument(chatId, buffer, caption || "translation.txt", undefined, createMainKeyboard(lang));
    } else {
      await sendTextMessage(chatId, escapeHtml(outputText), { replyMarkup: createMainKeyboard(lang) });
    }

    if (statusMessageId) {
      try {
        await deleteMessage(chatId, statusMessageId);
      } catch (err) {
        logger.debug("Failed to delete translation status message", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  } catch (err) {
    logger.error("Text translation failed", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      chatId,
    });
    await sendTextMessage(
      chatId,
      t("translationFailed", lang, { error: err instanceof Error ? err.message : String(err) }),
      { replyMarkup: createMainKeyboard(lang) }
    );
  }
}

async function editYouTubeLinkPrompt(chatId: number, messageId: number, prefs: UserPreferences): Promise<void> {
  const lang = prefs.interfaceLanguage;
  setPendingAction(chatId, {
    type: "youtube",
    url: "",
    sourceLanguage: prefs.sourceLanguage,
    targetLanguage: prefs.targetLanguage,
    createdAt: Date.now(),
  });
  await editMessageText(chatId, messageId, t("sendYoutubeLink", lang), { replyMarkup: createMainKeyboard(lang) });
}

async function handleMediaLink(chatId: number, url: string, prefs: UserPreferences): Promise<void> {
  const lang = prefs.interfaceLanguage;

  if (!isSupportedMediaUrl(url)) {
    await sendTextMessage(chatId, t("invalidMedia", lang), { replyMarkup: createMainKeyboard(lang) });
    return;
  }

  const validation = await validateMediaUrl(url);
  if (!validation.ok) {
    const msg = getYouTubeErrorMessage(validation.reason, lang);
    await sendTextMessage(chatId, msg, { replyMarkup: createMainKeyboard(lang) });
    return;
  }

  // Update existing pending YouTube action or create new one
  const pending = getPendingAction(chatId);
  let actionId: string;
  if (pending?.type === "youtube") {
    actionId = pending.actionId;
    updatePendingAction(chatId, { url, title: validation.title });
  } else {
    actionId = setPendingAction(chatId, {
      type: "youtube",
      url,
      title: validation.title,
      sourceLanguage: prefs.sourceLanguage,
      targetLanguage: prefs.targetLanguage,
      createdAt: Date.now(),
    });
  }

  await sendTextMessage(
    chatId,
    t("mediaPreview", lang, { title: escapeHtml(validation.title || "") }),
    { replyMarkup: createSourceLanguageKeyboard(`confirm:${actionId}`, lang, "action:main") }
  );
}

function buildConfirmationText(lang: SupportedLanguage, sourceLang: SupportedLanguage, targetLang: SupportedLanguage | "none", title?: string): string {
  const sourceLabel = `${LANGUAGE_FLAGS[sourceLang]} ${LANGUAGE_LABELS[sourceLang]}`;
  const targetLabel = targetLang === "none"
    ? t("noDefaultTarget", lang)
    : `${LANGUAGE_FLAGS[targetLang]} ${LANGUAGE_LABELS[targetLang]}`;

  const confirmText = t(targetLang === "none" ? "confirmStartNoTranslation" : "confirmStart", lang, { source: sourceLabel, target: targetLabel });
  if (title) {
    return t("mediaPreview", lang, { title: escapeHtml(title) }) + "\n\n" + confirmText;
  }
  return confirmText;
}

async function editConfirmationMessage(chatId: number, messageId: number, prefs: UserPreferences): Promise<void> {
  const lang = prefs.interfaceLanguage;
  const pending = getPendingAction(chatId);
  if (!pending || pending.type === "translate_text") return;

  const text = buildConfirmationText(lang, pending.sourceLanguage ?? prefs.sourceLanguage, pending.targetLanguage ?? prefs.targetLanguage, pending.type === "youtube" ? pending.title : undefined);
  await editMessageText(chatId, messageId, text, { replyMarkup: createConfirmationKeyboard(pending.actionId, lang, pending.targetLanguage ?? prefs.targetLanguage) });
}

async function startPendingAction(chatId: number, force = false): Promise<void> {
  const prefs = await getUserPreferences(chatId);
  const lang = prefs.interfaceLanguage;
  const pending = getPendingAction(chatId);
  if (!pending) {
    await sendTextMessage(chatId, t("sessionExpired", lang), {
      replyMarkup: createMainKeyboard(lang),
    });
    return;
  }

  const active = getActiveProcess(chatId);
  if (active && !force) {
    await sendTextMessage(chatId, t("processAlreadyRunning", lang), {
      replyMarkup: {
        inline_keyboard: [
          [{ text: t("startNew", lang), callback_data: `force_start:yes:${pending.actionId}` }],
          [{ text: t("back", lang), callback_data: `force_start:no:${pending.actionId}` }],
        ],
      },
    });
    return;
  }

  if (pending.type === "translate_text") {
    clearPendingAction(chatId);
    await sendMainMenu(chatId, prefs);
    return;
  }

  if (!pending.sourceLanguage) {
    await sendTextMessage(chatId, t("chooseSourceLanguage", lang), {
      replyMarkup: createSourceLanguageKeyboard(`confirm:${pending.actionId}`, lang, "action:main"),
    });
    return;
  }

  clearPendingAction(chatId);
  const sourceLang = pending.sourceLanguage;
  const targetLang = pending.targetLanguage === "none" ? undefined : pending.targetLanguage;

  if (pending.type === "media") {
    await processAudio(
      chatId,
      pending.buffer,
      pending.filename,
      sourceLang,
      pending.dbMessageId,
      pending.messageId,
      targetLang
    );
  } else if (pending.type === "youtube") {
    try {
      await downloadAndTranscribeYouTube(chatId, pending.url, sourceLang, targetLang);
    } catch (err) {
      logger.error("YouTube processing failed", {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        chatId,
        url: pending.url,
      });
    }
  }
}

function createProgressUpdater(chatId: number, statusMsgId: number, lang: SupportedLanguage, details?: string) {
  let lastPercent = -1;
  let lastUpdate = 0;
  let lastLabel = "";
  const stopKeyboard = createStopKeyboard(lang, String(chatId));

  return async (progress: { percent: number; label: string }) => {
    lastLabel = progress.label || lastLabel;
    const now = Date.now();
    const isFirst = lastUpdate === 0;
    const percentChanged = progress.percent !== lastPercent;
    const significant = Math.abs(progress.percent - lastPercent) >= 3;
    const labelChanged = progress.label && progress.label !== lastLabel;
    const enoughTime = now - lastUpdate > 1000;

    if (
      progress.percent === 100 ||
      (percentChanged && (isFirst || significant || (labelChanged && enoughTime) || enoughTime))
    ) {
      lastPercent = progress.percent;
      lastUpdate = now;
      await editMessageText(
        chatId,
        statusMsgId,
        renderLoadingStages(progress.percent, lastLabel, details),
        { replyMarkup: stopKeyboard }
      ).catch((err) => logger.debug("Progress edit skipped", { error: err instanceof Error ? err.message : String(err) }));
    }
  };
}

async function processAudio(
  chatId: number,
  buffer: Buffer,
  filename: string,
  language: string,
  dbMessageId: number,
  replyToMessageId?: number,
  targetLanguage?: string
): Promise<TranscriptionResult | undefined> {
  const prefs = await getUserPreferences(chatId);
  const lang = prefs.interfaceLanguage;
  const statusMsgId = await sendTextMessage(
    chatId,
    renderLoadingStages(0, t("transcribing", lang), filename),
    { replyMarkup: createStopKeyboard(lang, String(chatId)) }
  );

  const removeKeyboard = { replyMarkup: { inline_keyboard: [] as InlineKeyboardButton[][] } };
  const stopKeyboard = createStopKeyboard(lang, String(chatId));
  const onProgress = createProgressUpdater(chatId, statusMsgId, lang, filename);
  const abortController = new AbortController();

  try {
    setActiveProcess(chatId, {
      abortController,
      startTime: Date.now(),
      statusMessageId: statusMsgId,
      type: "media",
      language,
      filename,
    });

    const result = await transcribeAudio(
      buffer,
      filename,
      language,
      (pid) => {
        setActiveProcess(chatId, {
          pid,
          abortController,
          startTime: Date.now(),
          statusMessageId: statusMsgId,
          type: "media",
          language,
          filename,
        });
      },
      onProgress,
      abortController.signal
    );
    clearActiveProcess(chatId);

    if (result.segments.length === 0) {
      await editMessageText(chatId, statusMsgId, t("noSpeech", lang), removeKeyboard);
      return result;
    }

    const cleanup = await cleanupTranscription(result.text, result.language);
    const cleanedText = cleanup.cleanedText;

    // Quality check before sending to user
    const quality = detectTranscriptionIssues(cleanedText, result.language, result.segments);
    if (quality.isSuspicious) {
      logger.warn("Transcription quality flags detected", {
        chatId,
        language: result.language,
        flags: quality.flags,
        meanConfidence: quality.meanConfidence,
      });
    }

    let transcriptionId: number;
    try {
      const persisted = await createTranscription({
        telegramChatId: chatId,
        messageId: dbMessageId || null,
        language: result.language,
        fullText: cleanedText,
        segments: result.segments,
      });
      transcriptionId = persisted.id;
    } catch (err) {
      logger.error("Failed to persist transcription", { error: err instanceof Error ? err.message : String(err), chatId });
      transcriptionId = 0;
    }

    const qualityWarning = quality.isSuspicious ? quality.flags.join(", ") : undefined;
    await sendResultDocument(
      chatId,
      result.language,
      cleanedText,
      result.segments,
      targetLanguage,
      transcriptionId,
      lang,
      replyToMessageId,
      qualityWarning,
      undefined,
      cleanup.warning,
      undefined,
      "telegram_media"
    );
    await deleteMessage(chatId, statusMsgId).catch(() => {});

    return { ...result, text: cleanedText };
  } catch (err) {
    clearActiveProcess(chatId);
    logger.error("Transcription error", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    const msg = t("transcriptionFailed", lang, { error: escapeHtml(err instanceof Error ? err.message : String(err)) });
    await editMessageText(chatId, statusMsgId, msg, removeKeyboard);
  }
}

async function downloadAndTranscribeYouTube(
  chatId: number,
  url: string,
  language: string,
  targetLanguage?: string
): Promise<void> {
  const prefs = await getUserPreferences(chatId);
  const lang = prefs.interfaceLanguage;
  let tmpWav = "";
  const statusMsgId = await sendTextMessage(
    chatId,
    renderLoadingStages(0, t("stageStarting", lang), url),
    { replyMarkup: createStopKeyboard(lang, String(chatId)) }
  );

  const removeKeyboard = { replyMarkup: { inline_keyboard: [] as InlineKeyboardButton[][] } };
  const stopKeyboard = createStopKeyboard(lang, String(chatId));
  const abortController = new AbortController();

  try {
    setActiveProcess(chatId, {
      abortController,
      startTime: Date.now(),
      statusMessageId: statusMsgId,
      type: "youtube",
      language,
      sourceUrl: url,
      filename: "youtube_audio.wav",
    });

    const downloadProgress = createProgressUpdater(chatId, statusMsgId, lang, url);

    const downloadResult = await downloadMediaAudio(
      url,
      (progress) => downloadProgress({ percent: progress.percent, label: progress.label ?? t("stageDownload", lang) }),
      abortController.signal
    );
    const audioBuffer = downloadResult.audioBuffer;
    tmpWav = downloadResult.tmpWav;

    await editMessageText(chatId, statusMsgId, renderLoadingStages(60, t("stageTranscribe", lang), url), { replyMarkup: stopKeyboard });

    const transcribeProgress = createProgressUpdater(chatId, statusMsgId, lang, url);
    const result = await transcribeAudio(
      audioBuffer,
      "youtube_audio.wav",
      language,
      (pid) => {
        setActiveProcess(chatId, {
          pid,
          abortController,
          startTime: Date.now(),
          statusMessageId: statusMsgId,
          type: "youtube",
          language,
          sourceUrl: url,
          filename: "youtube_audio.wav",
        });
      },
      transcribeProgress,
      abortController.signal
    );
    await unlink(tmpWav).catch(() => {});
    clearActiveProcess(chatId);

    if (result.segments.length === 0) {
      await deleteMessage(chatId, statusMsgId).catch(() => {});
      await sendTextMessage(chatId, t("noSpeech", lang), { replyMarkup: createBackToMenuKeyboard(lang) });
      return;
    }

    const cleanup = await cleanupTranscription(result.text, result.language);
    const cleanedText = cleanup.cleanedText;

    let transcriptionId: number;
    try {
      const persisted = await createTranscription({
        telegramChatId: chatId,
        messageId: null,
        language: result.language,
        fullText: cleanedText,
        segments: result.segments,
      });
      transcriptionId = persisted.id;
    } catch (err) {
      logger.error("Failed to persist YouTube transcription", { error: err instanceof Error ? err.message : String(err), chatId });
      transcriptionId = 0;
    }

    await sendResultDocument(
      chatId,
      result.language,
      cleanedText,
      result.segments,
      targetLanguage,
      transcriptionId,
      lang,
      undefined,
      undefined,
      "YouTube",
      cleanup.warning,
      url,
      "youtube"
    );
    await deleteMessage(chatId, statusMsgId).catch(() => {});
  } catch (err) {
    clearActiveProcess(chatId);
    await unlink(tmpWav).catch(() => {});
    const msg = `❌ ${escapeHtml(err instanceof Error ? err.message : String(err))}`;
    await editMessageText(chatId, statusMsgId, msg, removeKeyboard);
    throw err;
  }
}

function getYouTubeErrorMessage(reason: string | undefined, lang: SupportedLanguage): string {
  const messages: Record<string, Partial<Record<SupportedLanguage, string>>> = {
    not_available: {
      ky: "❌ Видео жеткиликтүү эмес. Ал жок кылынган, жашырылган же регионго блоктолгон болушу мүмкүн.",
      tg: "❌ Видео дастрас нест. Эҳтимол нест шудааст, пинҳон шудааст ё аз минтақаа манъ шудааст.",
      uz: "❌ Video mavjud emas. Ehtimol o'chirilgan, yashirilgan yoki mintaqaga bloklangan.",
      en: "❌ Video is not available. It may be deleted, private, or region-blocked.",
      ru: "❌ Видео недоступно. Возможно, оно удалено, скрыто или заблокировано в вашем регионе.",
    },
    sign_in_required: {
      ky: "❌ Бул видео YouTube'ко кириүүнү талап кылат. Бот мындай видеолорду жүктөй албайт.",
      tg: "❌ Ин видео талаб мекунад, ки дар YouTube ворид шавед. Бот чунин видеоҳоро боргирӣ карда наметавонад.",
      uz: "❌ Bu video YouTube'ga kirishni talab qiladi. Bot bunday videolarni yuklab ololmaydi.",
      en: "❌ This video requires YouTube sign-in. The bot cannot download such videos.",
      ru: "❌ Это видео требует входа в YouTube. Бот не может скачать такие видео.",
    },
    private: {
      ky: "❌ Бул жеке видео. Бот аны жүктөй албайт.",
      tg: "❌ Ин видеои шахсӣ аст. Бот онро боргирӣ карда наметавонад.",
      uz: "❌ Bu shaxsiy video. Bot uni yuklab ololmaydi.",
      en: "❌ This is a private video. The bot cannot download it.",
      ru: "❌ Это приватное видео. Бот не может его скачать.",
    },
    age_restricted: {
      ky: "❌ Видео жаш чектөөсү бар. Бот аны жүктөй албайт.",
      tg: "❌ Видео дорои маҳдудияти синну сол аст. Бот онро боргирӣ карда наметавонад.",
      uz: "❌ Videoda yosh chegaralashi bor. Bot uni yuklab ololmaydi.",
      en: "❌ The video is age-restricted. The bot cannot download it.",
      ru: "❌ Видео имеет возрастное ограничение. Бот не может его скачать.",
    },
    live_stream: {
      ky: "❌ Тике эфирди транскрипциялоого болбойт. Видео аяктаганда жаңы шилтеме жибериңиз.",
      tg: "❌ Пахши мустақимро транскрипция кардан мумкин нест. Лутфан, пас аз анҷоми видео пайванди нав фиристед.",
      uz: "❌ Jonli efirni transkripsiya qilish mumkin emas. Iltimos, video tugagach yangi havola yuboring.",
      en: "❌ Live streams cannot be transcribed. Please send a new link after the broadcast ends.",
      ru: "❌ Прямые трансляции нельзя расшифровать. Пожалуйста, пришлите новую ссылку после окончания эфира.",
    },
    timeout: {
      ky: "❌ Видеону текшерүү өтө көп убакыт алды. Интернет же YouTube көйгөйлөрү мүмкүн.",
      tg: "❌ Санҷиши видео хеле тулонӣ шуд. Эҳтимол мушкилоти интернет ё YouTube.",
      uz: "❌ Videoni tekshirish juda uzoq davom etdi. Ehtimol internet yoki YouTube muammolari.",
      en: "❌ Video validation took too long. Possible network or YouTube issues.",
      ru: "❌ Проверка видео заняла слишком много времени. Возможны проблемы с сетью или YouTube.",
    },
    missing_deps: {
      ky: "❌ Видеону текшерүүчү куралдар табылган жок. Администратор python3 жана requests орнотконун текшерсин.",
      tg: "❌ Воситаҳои санҷиши видео ёфт нашуданд. Администратор python3 ва requests-ро насб кардааст, тафтиш кунад.",
      uz: "❌ Video tekshirish vositalari topilmadi. Administrator python3 va requests o'rnatganini tekshirsin.",
      en: "❌ Video validation tools are missing. Please ask the admin to install python3 and requests.",
      ru: "❌ Не найдены инструменты для проверки видео. Попросите администратора установить python3 и requests.",
    },
    cobalt_auth_required: {
      ky: "❌ Көчүрүү кызматына кирүү үчүн аутентификация талап кылынат. Администраторго жеке Cobalt серверин орнотууну сураныңыз.",
      tg: "❌ Барои дастрасӣ ба хидмати боргирӣ аутентификатсия лозим аст. Администраторро барои насби сервери хусусии Cobalt дастгирӣ кунед.",
      uz: "❌ Yuklab olish xizmatiga kirish uchun autentifikatsiya talab qilinadi. Administratordan shaxsiy Cobalt serverini o'rnatishni so'rang.",
      en: "❌ The download service now requires authentication. Please ask the admin to deploy a private Cobalt server.",
      ru: "❌ Сервис скачивания теперь требует аутентификации. Попросите администратора развернуть приватный сервер Cobalt.",
    },
    unknown: {
      ky: "❌ Видеону текшерүү мүмкүн болгон жок. Шилтеме туура эмес же видео жеткиликтүү эмес.",
      tg: "❌ Санҷиши видео иҷро нашуд. Эҳтимол пайванд нодуруст аст ё видео дастрас нест.",
      uz: "❌ Videoni tekshirish amalga oshmadi. Ehtimol havola noto'g'ri yoki video mavjud emas.",
      en: "❌ Could not validate the video. The link may be invalid or the video unavailable.",
      ru: "❌ Не удалось проверить видео. Возможно, ссылка неверная или видео недоступно.",
    },
  };

  const entry = messages[reason ?? "unknown"];
  return entry[lang] ?? entry["uz"] ?? entry["ru"] ?? "Unknown error";
}

async function stopActiveProcess(chatId: number): Promise<void> {
  const prefs = await getUserPreferences(chatId);
  const lang = prefs.interfaceLanguage;
  const active = getActiveProcess(chatId);

  if (!active) {
    await sendTextMessage(chatId, t("nothingToStop", lang), { replyMarkup: createMainKeyboard(lang) });
    return;
  }

  try {
    active.abortController?.abort();
    if (active.pid) {
      process.kill(active.pid, "SIGTERM");
    }
  } catch (err) {
    logger.warn("Failed to kill process", { error: err instanceof Error ? err.message : String(err), pid: active.pid, chatId });
  }

  clearActiveProcess(chatId);

  if (active.statusMessageId) {
    await editMessageText(
      chatId,
      active.statusMessageId,
      `🛑 ${t("processingStopped", lang)}`,
      { replyMarkup: { inline_keyboard: [] } }
    ).catch(() => {});
  }

  await sendTextMessage(chatId, t("processingStopped", lang), { replyMarkup: createMainKeyboard(lang) });
}

async function sendResultDocument(
  chatId: number,
  sourceLang: string,
  cleanedText: string,
  segments: TranscriptionSegment[],
  targetLang: string | undefined,
  transcriptionId: number,
  lang: SupportedLanguage,
  replyToMessageId?: number,
  qualityWarning?: string,
  titlePrefix?: string,
  cleanupWarning?: string,
  sourceUrl?: string,
  sourceType?: string
): Promise<void> {
  const sourceLabel = LANGUAGE_LABELS[sourceLang as SupportedLanguage] ?? sourceLang;

  const backToMenuKeyboard = createBackToMenuKeyboard(lang);

  // If a target language is chosen and differs from the source, send only the translated file.
  if (targetLang && targetLang !== "none" && targetLang !== sourceLang && cleanedText.trim()) {
    try {
      const translation = await translateText({ text: cleanedText, targetLang, sourceLang: sourceLang, sourceUrl, sourceType });

      if (transcriptionId > 0) {
        await saveTranslation({
          telegramChatId: chatId,
          transcriptionId,
          sourceText: cleanedText,
          targetLang,
          translatedText: translation.translatedText,
        }).catch((err) => logger.error("Failed to persist translation", { error: err instanceof Error ? err.message : String(err), chatId }));
      }

      const targetLabel = LANGUAGE_LABELS[targetLang as SupportedLanguage] ?? targetLang;
      const title = `${targetLabel}`;
      const warnings = [
        cleanupWarning,
        translation.warning,
      ].filter(Boolean);
      const warningNote = warnings.length ? `\n\n⚠️ ${warnings.join(" ")}` : "";
      const caption = translation.requestId ? `${title} #${translation.requestId}` : title;
      await sendDocument(
        chatId,
        Buffer.from(`${title}${warningNote}\n\n${translation.translatedText}`, "utf-8"),
        `translation_${Date.now()}.txt`,
        caption,
        backToMenuKeyboard
      );
      return;
    } catch (err) {
      logger.error("Translation failed, falling back to transcription", {
        error: err instanceof Error ? err.message : String(err),
        chatId,
        targetLang,
      });
      await sendTextMessage(
        chatId,
        t("translationFailed", lang, { error: err instanceof Error ? err.message : String(err) }),
        { replyMarkup: backToMenuKeyboard }
      ).catch(() => {});
      // Fall through to send the original transcription file.
    }
  }

  const title = titlePrefix ? `${titlePrefix} — ${sourceLabel}` : `${sourceLabel}`;
  const subtitles = formatSubtitles(segments);
  const warningHeader = cleanupWarning ? `\n\n⚠️ ${cleanupWarning}` : "";
  const fileContent = `${title}${warningHeader}\n\n${cleanedText}\n\n---\n\n${subtitles}`;
  const caption = qualityWarning ? `${qualityWarning}` : title;
  await sendDocument(
    chatId,
    Buffer.from(fileContent, "utf-8"),
    `transcription_${Date.now()}.txt`,
    caption,
    backToMenuKeyboard
  );
}

async function prepareTestAudio(fixture: TestFixture, tmpWav: string): Promise<{ source: string; captionPromise: Promise<string | null> }> {
  const fs = await import("fs/promises");

  // Local fixtures (or cached hard fixtures with no URL) should be copied
  // directly instead of re-downloading from YouTube.
  const useLocalFile = fixture.source === "local" || (fixture.source === "youtube" && !fixture.url);
  if (useLocalFile && fixture.wavPath) {
    const wavPath = join(process.cwd(), fixture.wavPath);
    try {
      await fs.access(wavPath);
      await fs.copyFile(wavPath, tmpWav);
      return { source: fixture.wavPath, captionPromise: Promise.resolve(null) };
    } catch {
      // Cached/local file missing; fall through to download path for YouTube fixtures.
    }
  }

  // Caption extraction used yt-dlp, which was removed (Cobalt cannot fetch
  // subtitles). /test now always scores against the curated reference
  // transcripts in test_audio/ rather than YouTube's own captions.
  const captionPromise: Promise<string | null> = Promise.resolve(null);

  await new Promise<void>((resolve, reject) => {
    const { spawn } = require("child_process");
    const proc = spawn(PYTHON_PATH, ["download_youtube.py", fixture.url, FFMPEG_PATH, tmpWav], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });
    proc.on("close", (code: number) => {
      if (code !== 0) reject(new Error(`Download failed: ${stderr}`));
      else resolve();
    });
    proc.on("error", (err: Error) => reject(new Error(`Download process error: ${err.message}`)));
  });

  return { source: fixture.url!, captionPromise };
}

async function runAccuracyTest(chatId: number, language: string): Promise<void> {
  const prefs = await getUserPreferences(chatId);
  const lang = prefs.interfaceLanguage;
  const fixture = getTestFixture(language);
  if (!fixture) {
    await sendTextMessage(chatId, t("fixtureNotFound", lang), { replyMarkup: createMainKeyboard(lang) });
    return;
  }

  const testHeader = t("testHeader", lang);
  const statusMsgId = await sendTextMessage(
    chatId,
    renderLoadingStages(0, t("testPreparing", lang), fixture.title, testHeader),
    { replyMarkup: createStopKeyboard(lang, String(chatId)) }
  );
  const tmpWav = join(tmpdir(), `tiltab_test_${Date.now()}.wav`);
  const removeKeyboard = { replyMarkup: { inline_keyboard: [] as InlineKeyboardButton[][] } };
  const stopKeyboard = createStopKeyboard(lang, String(chatId));
  const testProgress = createProgressUpdater(chatId, statusMsgId, lang, fixture.title);
  const abortController = new AbortController();

  try {
    setActiveProcess(chatId, {
      abortController,
      startTime: Date.now(),
      statusMessageId: statusMsgId,
      type: "test",
      language,
      filename: fixture.title,
    });

    await editMessageText(chatId, statusMsgId, renderLoadingStages(30, t("testDownloading", lang), fixture.title, testHeader), { replyMarkup: stopKeyboard });

    const { captionPromise } = await prepareTestAudio(fixture, tmpWav);

    await editMessageText(chatId, statusMsgId, renderLoadingStages(60, t("testRecognizing", lang), fixture.title, testHeader), { replyMarkup: stopKeyboard });

    const fs = await import("fs/promises");
    const audioBuffer = await fs.readFile(tmpWav);
    const result = await transcribeAudio(
      audioBuffer,
      "test_audio.wav",
      language,
      (pid) => {
        setActiveProcess(chatId, {
          pid,
          abortController,
          startTime: Date.now(),
          statusMessageId: statusMsgId,
          type: "test",
          language,
          filename: fixture.title,
        });
      },
      (progress) => testProgress({ ...progress, label: `${progress.label} (${t("testRecognizing", lang)})` }),
      abortController.signal
    );
    await fs.unlink(tmpWav).catch(() => {});

    await editMessageText(chatId, statusMsgId, renderLoadingStages(100, t("testScoring", lang), fixture.title, testHeader), removeKeyboard);

    if (result.segments.length === 0 || !result.text.trim()) {
      await editMessageText(chatId, statusMsgId, `<b>🤷 ${t("noSpeech", lang)}</b>`, removeKeyboard);
      return;
    }

    const cleanup = await cleanupTranscription(result.text, result.language);
    const cleanedText = cleanup.cleanedText;

    let referenceText = await captionPromise;
    if (!referenceText || referenceText.trim().length < 10) {
      referenceText = fixture.referenceText;
    }

    const accuracy = combinedAccuracy(cleanedText, referenceText);

    let transcriptionId: number;
    try {
      const persisted = await createTranscription({
        telegramChatId: chatId,
        messageId: null,
        language: result.language,
        fullText: cleanedText,
        segments: result.segments,
      });
      transcriptionId = persisted.id;
    } catch (err) {
      logger.error("Failed to persist test transcription", { error: err instanceof Error ? err.message : String(err), chatId });
      transcriptionId = 0;
    }

    const langNames: Record<string, string> = {
      ky: "Кыргызча",
      tg: "Тоҷикӣ",
      uz: "O'zbekча",
      en: "English",
      ru: "Русский",
    };

    const header = `<b>${t("testCompleted", lang)}</b>\n<i>${fixture.title}</i>\n`;
    const accuracyLine = renderAccuracyLine(accuracy);
    const transcriptionSection = `\n<b>${t("recognizedText", lang)} (${langNames[result.language] ?? result.language}):</b>\n<code>${truncate(cleanedText, 900)}</code>`;
    const referenceSection = `\n<b>${t("referenceText", lang)}:</b>\n<code>${truncate(referenceText, 900)}</code>`;
    const summary = `${header}\n${accuracyLine}${transcriptionSection}${referenceSection}`;

    await editMessageText(chatId, statusMsgId, summary, removeKeyboard);
  } catch (err) {
    const fs = await import("fs/promises");
    await fs.unlink(tmpWav).catch(() => {});
    const msg = `❌ ${t("transcriptionFailed", lang, { error: escapeHtml(err instanceof Error ? err.message : String(err)) })}`;
    await editMessageText(chatId, statusMsgId, msg, removeKeyboard);
    throw err;
  }
}

function renderAccuracyLine(accuracy: number): string {
  const emoji = accuracy >= 90 ? "🟢" : accuracy >= 70 ? "🟡" : accuracy >= 50 ? "🟠" : "🔴";
  return `<b>${emoji} ${accuracy}%</b>\n`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

async function runSingleTest(chatId: number, language: string): Promise<void> {
  const originalLang = await getUserPreferences(chatId).then((p) => p.sourceLanguage);
  try {
    await setUserSourceLanguage(chatId, language as SupportedLanguage);
    await runAccuracyTest(chatId, language);
  } catch (err) {
    logger.error("Test command failed", { error: err instanceof Error ? err.message : String(err), chatId, language });
  } finally {
    if (originalLang) {
      await setUserSourceLanguage(chatId, originalLang);
    }
  }
}

async function runAllTests(chatId: number): Promise<void> {
  const originalLang = await getUserPreferences(chatId).then((p) => p.sourceLanguage);
  try {
    for (const language of ["ky", "tg", "uz", "en", "ru"]) {
      if (getTestFixture(language)) {
        try {
          await setUserSourceLanguage(chatId, language as SupportedLanguage);
          await runAccuracyTest(chatId, language);
        } catch (err) {
          logger.error("Test failed for language", { error: err instanceof Error ? err.message : String(err), chatId, language });
        }
      }
    }
  } finally {
    if (originalLang) {
      await setUserSourceLanguage(chatId, originalLang);
    }
  }
}

async function handleCallbackQuery(callbackQuery: {
  id: string;
  from: { id: number };
  message?: TelegramMessage;
  data: string;
}): Promise<void> {
  try {
    await answerCallbackQuery(callbackQuery.id);
  } catch (err) {
    logger.debug("answerCallbackQuery failed, continuing", { error: err instanceof Error ? err.message : String(err) });
  }

  const data = callbackQuery.data;
  const chatId = callbackQuery.message?.chat.id;
  const messageId = callbackQuery.message?.message_id;

  if (!chatId || !messageId) return;

  const prefs = await getUserPreferences(chatId);
  const lang = prefs.interfaceLanguage;

  // Interface language
  if (data.startsWith("ui_lang:")) {
    const langCode = data.split(":")[1] as SupportedLanguage;
    await setUserInterfaceLanguage(chatId, langCode);
    await editMainMenu(chatId, messageId, { ...prefs, interfaceLanguage: langCode });
    return;
  }

  // Source language selection
  if (data.startsWith("source:")) {
    const [, sourceLang, action, actionId] = data.split(":");
    const normalized = sourceLang as SupportedLanguage;

    if (action === "default") {
      await setUserSourceLanguage(chatId, normalized);
      const updatedPrefs = await getUserPreferences(chatId);
      await editSettingsMenu(chatId, messageId, updatedPrefs);
    } else if (action === "confirm" && actionId) {
      const pending = getPendingAction(chatId);
      if (pending && pending.actionId === actionId) {
        updatePendingAction(chatId, { sourceLanguage: normalized });
      }
      await editConfirmationMessage(chatId, messageId, prefs);
    }
    return;
  }

  // Target language selection
  if (data.startsWith("target:")) {
    const [, targetLang, action, actionId] = data.split(":");
    const normalized = targetLang as SupportedLanguage | "none";

    if (action === "default") {
      await setUserTargetLanguage(chatId, normalized);
      const updatedPrefs = await getUserPreferences(chatId);
      await editSettingsMenu(chatId, messageId, updatedPrefs);
    } else if (action === "confirm" && actionId) {
      const pending = getPendingAction(chatId);
      if (pending && pending.actionId === actionId) {
        updatePendingAction(chatId, { targetLanguage: normalized });
      }
      await setUserTargetLanguage(chatId, normalized);
      await editConfirmationMessage(chatId, messageId, prefs);
    } else if (action === "translate_text" && actionId) {
      const pending = getPendingAction(chatId);
      if (pending && pending.type === "translate_text" && pending.actionId === actionId) {
        if (normalized !== "none") {
          updatePendingAction(chatId, { targetLanguage: normalized });
        }
      }
      await sendTextMessage(chatId, t("sendTextToTranslate", lang), { replyMarkup: createMainKeyboard(lang) });
    }
    return;
  }

  // Confirmation actions
  if (data.startsWith("confirm:")) {
    const [, action, actionId] = data.split(":");
    const pending = getPendingAction(chatId);

    if (!pending || pending.actionId !== actionId) {
      await editMessageText(chatId, messageId, t("sessionExpired", lang), { replyMarkup: createMainKeyboard(lang) });
      return;
    }

    if (action === "start") {
      await startPendingAction(chatId);
    } else if (action === "lang") {
      await editMessageText(
        chatId,
        messageId,
        t("chooseSourceLanguage", lang),
        { replyMarkup: createSourceLanguageKeyboard(`confirm:${actionId}`, lang, `confirm:back:${actionId}`) }
      );
    } else if (action === "target") {
      await editMessageText(
        chatId,
        messageId,
        t("chooseTargetLanguage", lang),
        { replyMarkup: createTargetLanguageKeyboard(`confirm:${actionId}`, lang, `confirm:back:${actionId}`) }
      );
    } else if (action === "back") {
      await editConfirmationMessage(chatId, messageId, prefs);
    } else if (action === "cancel") {
      clearPendingAction(chatId);
      await editMainMenu(chatId, messageId, prefs);
    }
    return;
  }

  // Test language
  if (data.startsWith("test_lang:")) {
    const testLang = data.split(":")[1];
    if (testLang === "all") {
      await runAllTests(chatId);
    } else {
      await runSingleTest(chatId, testLang);
    }
    return;
  }

  // Force-start an action while another process is running
  if (data.startsWith("force_start:")) {
    const [, decision, actionId] = data.split(":");
    const pending = getPendingAction(chatId);
    if (!pending || pending.actionId !== actionId) {
      await editMessageText(chatId, messageId, t("sessionExpired", lang), { replyMarkup: createMainKeyboard(lang) });
      return;
    }
    if (decision === "yes") {
      const active = getActiveProcess(chatId);
      if (active) {
        try {
          active.abortController?.abort();
          if (active.pid) {
            process.kill(active.pid, "SIGTERM");
          }
        } catch (err) {
          logger.warn("Failed to kill active process", { error: err instanceof Error ? err.message : String(err), pid: active.pid, chatId });
        }
        clearActiveProcess(chatId);
      }
      await startPendingAction(chatId, true);
    } else {
      clearPendingAction(chatId);
      await editMainMenu(chatId, messageId, prefs);
    }
    return;
  }

  // Main menu actions
  if (data === "action:settings") {
    await editSettingsMenu(chatId, messageId, prefs);
    return;
  }

  if (data === "action:languages") {
    await editSettingsMenu(chatId, messageId, prefs);
    return;
  }

  if (data === "action:settings:interface") {
    await editMessageText(chatId, messageId, t("chooseInterfaceLanguage", lang), {
      replyMarkup: createInterfaceLanguageKeyboard(lang, "action:settings"),
    });
    return;
  }

  if (data === "action:settings:source") {
    await editMessageText(chatId, messageId, t("chooseSourceLanguage", lang), {
      replyMarkup: createSourceLanguageKeyboard("default", lang, "action:settings"),
    });
    return;
  }

  if (data === "action:settings:target") {
    await editMessageText(chatId, messageId, t("chooseTargetLanguage", lang), {
      replyMarkup: createTargetLanguageKeyboard("default", lang, "action:settings"),
    });
    return;
  }

  if (data === "action:main") {
    await editMainMenu(chatId, messageId, prefs);
    return;
  }

  if (data === "action:help") {
    await editMessageText(chatId, messageId, t("help", lang), { replyMarkup: createMainKeyboard(lang) });
    return;
  }

  if (data === "action:translate_text") {
    await startTranslateTextFlow(chatId, prefs);
    return;
  }

  if (data === "action:test") {
    await editMessageText(chatId, messageId, t("chooseTestLanguage", lang), { replyMarkup: createTestLanguageKeyboard() });
    return;
  }

  if (data === "action:stop" || data.startsWith("stop:")) {
    await stopActiveProcess(chatId);
    return;
  }

}
