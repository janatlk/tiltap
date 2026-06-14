import { Request, Response } from "express";
import { logger } from "../utils/logger";
import { tmpdir } from "os";
import { join } from "path";
import type { TelegramUpdate, TelegramMessage, TranscriptionResult, InlineKeyboardButton } from "../types";
import { fetchTelegramFile } from "../services/fileDownloadService";
import { transcribeAudio, formatSubtitles } from "../services/transcriptionService";
import { translateText } from "../services/translationService";
import { cleanupTranscription } from "../services/cleanupService";
import { extractYouTubeCaptions } from "../services/youtubeCaptionService";
import { renderLoadingStages } from "../utils/progressBar";
import { createInterface } from "readline";
import { combinedAccuracy } from "../utils/textSimilarity";
import { getTestFixture, TEST_FIXTURES, type TestFixture } from "../utils/testFixtures";
import {
  sendTextMessage,
  sendDocument,
  editMessageText,
  answerCallbackQuery,
  createMainKeyboard,
  createSettingsMenuKeyboard,
  createInterfaceLanguageKeyboard,
  createSourceLanguageKeyboard,
  createTargetLanguageKeyboard,
  createConfirmationKeyboard,
  createTestLanguageKeyboard,
  createTranslationKeyboard,
  createStopKeyboard,
  createQuickActionsKeyboard,
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
  type UserPreferences,
  LANGUAGE_LABELS,
  LANGUAGE_FLAGS,
  TEXT_FILE_THRESHOLD,
} from "../services/telegramService";
import {
  createMessage,
  createTranscription,
  getLatestTranscription,
  saveTranslation,
  getTranslation,
} from "../db/repos";

const FFMPEG_PATH = require("ffmpeg-static");
const PYTHON_PATH = process.platform === "win32" ? "python" : "python3";
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

export async function handleTelegramWebhook(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();
  res.sendStatus(200);

  const update = req.body as TelegramUpdate;
  logger.debug("Received Telegram update", { updateId: update.update_id });

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
    logger.error("Failed to persist incoming message", { error: err, chatId });
  }

  // Handle commands
  if (text.startsWith("/")) {
    await handleCommand(chatId, text, msg, prefs);
    return;
  }

  // Check pending YouTube link request
  const pending = getPendingAction(chatId);
  if (pending?.type === "youtube" && !pending.url && text) {
    await handleYouTubeUrl(chatId, text, prefs);
    return;
  }

  // Plain text with no context — show help/main menu
  if (!media) {
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

  // Store pending action and show confirmation
  setPendingAction(chatId, {
    type: "media",
    buffer,
    filename,
    messageId: msg.message_id,
    dbMessageId,
    sourceLanguage: prefs.sourceLanguage,
    targetLanguage: prefs.targetLanguage,
    createdAt: Date.now(),
  });
  await sendConfirmationMessage(chatId, prefs);
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
        await handleYouTubeUrl(chatId, args, userPrefs);
      }
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

async function sendMainMenu(chatId: number, prefs: UserPreferences, isStart = false): Promise<void> {
  const lang = prefs.interfaceLanguage;
  const text = isStart ? t("welcome", lang) : `${t("welcome", lang)}\n\n${t("mainMenuHint", lang)}`;
  await sendTextMessage(chatId, text, { replyMarkup: createMainKeyboard(lang) });
}

async function sendSettingsMenu(chatId: number, prefs: UserPreferences): Promise<void> {
  const lang = prefs.interfaceLanguage;
  const sourceLabel = prefs.sourceLanguage === "auto" || prefs.sourceLanguage === "multi"
    ? t("autoDetect", lang)
    : `${LANGUAGE_FLAGS[prefs.sourceLanguage]} ${LANGUAGE_LABELS[prefs.sourceLanguage]}`;
  const targetLabel = prefs.targetLanguage === "none" ? t("noDefaultTarget", lang) : `${LANGUAGE_FLAGS[prefs.targetLanguage]} ${LANGUAGE_LABELS[prefs.targetLanguage]}`;

  const text = `${t("settingsMenu", lang)}\n\n` +
    `🌍 ${t("settingsInterfaceLanguage", lang)}: ${LANGUAGE_FLAGS[lang]} ${LANGUAGE_LABELS[lang]}\n` +
    `🎙️ ${t("settingsSourceLanguage", lang)}: ${sourceLabel}\n` +
    `🌐 ${t("settingsTargetLanguage", lang)}: ${targetLabel}`;

  await sendTextMessage(chatId, text, { replyMarkup: createSettingsMenuKeyboard(lang) });
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

async function handleYouTubeUrl(chatId: number, url: string, prefs: UserPreferences): Promise<void> {
  const lang = prefs.interfaceLanguage;

  if (!isValidYouTubeUrl(url)) {
    await sendTextMessage(chatId, t("invalidYoutube", lang), { replyMarkup: createMainKeyboard(lang) });
    return;
  }

  const validation = await validateYouTubeUrl(url);
  if (!validation.ok) {
    const msg = getYouTubeErrorMessage(validation.reason, lang);
    await sendTextMessage(chatId, msg, { replyMarkup: createMainKeyboard(lang) });
    return;
  }

  // Update existing pending YouTube action or create new one
  const pending = getPendingAction(chatId);
  if (pending?.type === "youtube") {
    updatePendingAction(chatId, { url, title: validation.title });
  } else {
    setPendingAction(chatId, {
      type: "youtube",
      url,
      title: validation.title,
      sourceLanguage: prefs.sourceLanguage,
      targetLanguage: prefs.targetLanguage,
      createdAt: Date.now(),
    });
  }

  await sendConfirmationMessage(chatId, prefs, validation.title);
}

function isValidYouTubeUrl(url: string): boolean {
  return /^(https?:\/\/)?(www\.|m\.)?(youtube\.com|youtu\.be)\/.+/.test(url);
}

function buildConfirmationText(lang: SupportedLanguage, sourceLang: SupportedLanguage | "auto" | "multi", targetLang: SupportedLanguage | "none", title?: string): string {
  const sourceLabel = sourceLang === "auto" || sourceLang === "multi"
    ? t("autoDetect", lang)
    : `${LANGUAGE_FLAGS[sourceLang]} ${LANGUAGE_LABELS[sourceLang]}`;
  const targetLabel = targetLang === "none"
    ? t("noDefaultTarget", lang)
    : `${LANGUAGE_FLAGS[targetLang]} ${LANGUAGE_LABELS[targetLang]}`;

  const confirmText = t(targetLang === "none" ? "confirmStartNoTranslation" : "confirmStart", lang, { source: sourceLabel, target: targetLabel });
  if (title) {
    return t("youtubePreview", lang, { title: escapeHtml(title) }) + "\n\n" + confirmText;
  }
  return confirmText;
}

async function sendConfirmationMessage(chatId: number, prefs: UserPreferences, title?: string): Promise<void> {
  const lang = prefs.interfaceLanguage;
  const pending = getPendingAction(chatId);
  if (!pending) return;

  const text = buildConfirmationText(lang, pending.sourceLanguage ?? prefs.sourceLanguage, pending.targetLanguage ?? prefs.targetLanguage, title);
  await sendTextMessage(chatId, text, { replyMarkup: createConfirmationKeyboard(pending.actionId, lang) });
}

async function editConfirmationMessage(chatId: number, messageId: number, prefs: UserPreferences): Promise<void> {
  const lang = prefs.interfaceLanguage;
  const pending = getPendingAction(chatId);
  if (!pending) return;

  const text = buildConfirmationText(lang, pending.sourceLanguage ?? prefs.sourceLanguage, pending.targetLanguage ?? prefs.targetLanguage, pending.type === "youtube" ? pending.title : undefined);
  await editMessageText(chatId, messageId, text, { replyMarkup: createConfirmationKeyboard(pending.actionId, lang) });
}

async function startPendingAction(chatId: number): Promise<void> {
  const pending = getPendingAction(chatId);
  if (!pending) {
    const prefs = await getUserPreferences(chatId);
    await sendTextMessage(chatId, t("sessionExpired", prefs.interfaceLanguage), {
      replyMarkup: createMainKeyboard(prefs.interfaceLanguage),
    });
    return;
  }

  clearPendingAction(chatId);
  const sourceLang = pending.sourceLanguage ?? "auto";
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
      logger.error("YouTube processing failed", { error: err, chatId, url: pending.url });
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

  try {
    const result = await transcribeAudio(
      buffer,
      filename,
      language,
      (pid) => {
        setActiveProcess(chatId, { pid, startTime: Date.now(), statusMessageId: statusMsgId, type: "media" });
      },
      onProgress
    );
    clearActiveProcess(chatId);

    if (result.segments.length === 0) {
      await editMessageText(chatId, statusMsgId, t("noSpeech", lang), removeKeyboard);
      return result;
    }

    await editMessageText(chatId, statusMsgId, t("improvingText", lang), { replyMarkup: stopKeyboard });
    const cleanup = await cleanupTranscription(result.text, result.language);
    const cleanedText = cleanup.cleanedText;

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
      logger.error("Failed to persist transcription", { error: err, chatId });
      transcriptionId = 0;
    }

    const keyboard = createTranslationKeyboard(transcriptionId);
    await editMessageText(chatId, statusMsgId, t("transcriptionComplete", lang), removeKeyboard);

    if (cleanedText.length > TEXT_FILE_THRESHOLD) {
      const txtBuffer = Buffer.from(cleanedText, "utf-8");
      await sendDocument(
        chatId,
        txtBuffer,
        `transcription_${Date.now()}.txt`,
        `📝 ${LANGUAGE_LABELS[result.language as SupportedLanguage] ?? result.language}`,
        keyboard
      );
    } else {
      const subtitles = formatSubtitles(result.segments);
      const fullText = `<b>📝 ${LANGUAGE_LABELS[result.language as SupportedLanguage] ?? result.language}</b>\n\n` + subtitles;
      await sendTextMessage(chatId, fullText, { replyMarkup: keyboard, replyToMessageId });
    }

    if (targetLanguage && targetLanguage !== result.language) {
      await sendTranslation(chatId, cleanedText, targetLanguage, transcriptionId);
    }

    return { ...result, text: cleanedText };
  } catch (err) {
    clearActiveProcess(chatId);
    logger.error("Transcription error", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    const msg = t("transcriptionFailed", lang, { error: err instanceof Error ? err.message : String(err) });
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
  const tmpWav = join(tmpdir(), `tiltab_yt_${Date.now()}.wav`);
  const statusMsgId = await sendTextMessage(
    chatId,
    renderLoadingStages(0, t("stageStarting", lang), url),
    { replyMarkup: createStopKeyboard(lang, String(chatId)) }
  );

  const removeKeyboard = { replyMarkup: { inline_keyboard: [] as InlineKeyboardButton[][] } };
  const stopKeyboard = createStopKeyboard(lang, String(chatId));

  try {
    const downloadProgress = createProgressUpdater(chatId, statusMsgId, lang, url);

    await new Promise<void>((resolve, reject) => {
      const { spawn } = require("child_process");
      const proc = spawn(PYTHON_PATH, ["download_youtube.py", url, FFMPEG_PATH, tmpWav], {
        cwd: process.cwd(),
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });

      setActiveProcess(chatId, { pid: proc.pid!, startTime: Date.now(), statusMessageId: statusMsgId, type: "youtube" });

      let stderr = "";
      const stdoutLines: string[] = [];

      const rl = createInterface({ input: proc.stdout });
      rl.on("line", (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        stdoutLines.push(trimmed);
        if (trimmed.startsWith("{")) {
          try {
            const data = JSON.parse(trimmed) as { type?: string; percent?: number; label?: string };
            if (data.type === "progress" && typeof data.percent === "number") {
              downloadProgress({ percent: data.percent, label: data.label ?? t("stageDownload", lang) });
            }
          } catch {
            // ignore non-JSON
          }
        }
      });

      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });

      const timeout = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error("Download timed out after 120 seconds. The video may be too long or unavailable."));
      }, 120_000);

      proc.on("close", (code: number) => {
        clearActiveProcess(chatId);
        clearTimeout(timeout);
        if (code !== 0) {
          const errMsg = stderr.trim() || stdoutLines.join("\n").trim() || `Download failed with code ${code}`;
          reject(new Error(errMsg));
        } else {
          resolve();
        }
      });
      proc.on("error", (err: Error) => {
        clearActiveProcess(chatId);
        clearTimeout(timeout);
        reject(new Error(`Download process error: ${err.message}`));
      });
    });

    await editMessageText(chatId, statusMsgId, renderLoadingStages(60, t("stageTranscribe", lang), url), { replyMarkup: stopKeyboard });

    const fs = await import("fs/promises");
    const audioBuffer = await fs.readFile(tmpWav);
    const transcribeProgress = createProgressUpdater(chatId, statusMsgId, lang, url);
    const result = await transcribeAudio(
      audioBuffer,
      "youtube_audio.wav",
      language,
      (pid) => {
        setActiveProcess(chatId, { pid, startTime: Date.now(), statusMessageId: statusMsgId, type: "youtube" });
      },
      transcribeProgress
    );
    await fs.unlink(tmpWav).catch(() => {});
    clearActiveProcess(chatId);

    await editMessageText(chatId, statusMsgId, renderLoadingStages(100, t("stageDone", lang), url), removeKeyboard);

    if (result.segments.length === 0) {
      await sendTextMessage(chatId, t("noSpeech", lang), { replyMarkup: createMainKeyboard(lang) });
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
      logger.error("Failed to persist YouTube transcription", { error: err, chatId });
      transcriptionId = 0;
    }

    const keyboard = createTranslationKeyboard(transcriptionId);

    if (cleanedText.length > TEXT_FILE_THRESHOLD) {
      const txtBuffer = Buffer.from(cleanedText, "utf-8");
      await sendDocument(
        chatId,
        txtBuffer,
        `youtube_transcription_${Date.now()}.txt`,
        `📝 YouTube — ${LANGUAGE_LABELS[result.language as SupportedLanguage] ?? result.language}`,
        keyboard
      );
    } else {
      const subtitles = formatSubtitles(result.segments);
      const header = `<b>📝 YouTube — ${LANGUAGE_LABELS[result.language as SupportedLanguage] ?? result.language}</b>\n\n`;
      await sendTextMessage(chatId, header + subtitles, { replyMarkup: keyboard });
    }

    if (targetLanguage && targetLanguage !== result.language) {
      await sendTranslation(chatId, cleanedText, targetLanguage, transcriptionId);
    }
  } catch (err) {
    clearActiveProcess(chatId);
    const fs = await import("fs/promises");
    await fs.unlink(tmpWav).catch(() => {});
    const msg = `❌ ${err instanceof Error ? err.message : String(err)}`;
    await editMessageText(chatId, statusMsgId, msg, removeKeyboard);
    throw err;
  }
}

async function validateYouTubeUrl(url: string): Promise<{ ok: boolean; title?: string; duration?: number; reason?: string }> {
  return new Promise((resolve) => {
    const { spawn } = require("child_process");
    const proc = spawn(PYTHON_PATH, ["validate_youtube.py", url], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({ ok: false, reason: "timeout" });
    }, 30_000);

    proc.on("close", (code: number) => {
      clearTimeout(timeout);
      if (code !== 0) {
        resolve({ ok: false, reason: "unknown" });
        return;
      }
      try {
        const data = JSON.parse(stdout.trim().split("\n").pop() || "{}") as {
          ok: boolean;
          title?: string;
          duration?: number;
          reason?: string;
        };
        resolve(data);
      } catch {
        resolve({ ok: false, reason: "unknown" });
      }
    });
    proc.on("error", () => {
      clearTimeout(timeout);
      resolve({ ok: false, reason: "unknown" });
    });
  });
}

function getYouTubeErrorMessage(reason: string | undefined, lang: SupportedLanguage): string {
  const messages: Record<string, Record<SupportedLanguage, string>> = {
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
    timeout: {
      ky: "❌ Видеону текшерүү өтө көп убакыт алды. Интернет же YouTube көйгөйлөрү мүмкүн.",
      tg: "❌ Санҷиши видео хеле тулонӣ шуд. Эҳтимол мушкилоти интернет ё YouTube.",
      uz: "❌ Videoni tekshirish juda uzoq davom etdi. Ehtimol internet yoki YouTube muammolari.",
      en: "❌ Video validation took too long. Possible network or YouTube issues.",
      ru: "❌ Проверка видео заняла слишком много времени. Возможны проблемы с сетью или YouTube.",
    },
    unknown: {
      ky: "❌ Видеону текшерүү мүмкүн болгон жок. Шилтеме туура эмес же видео жеткиликтүү эмес.",
      tg: "❌ Санҷиши видео иҷро нашуд. Эҳтимол пайванд нодуруст аст ё видео дастрас нест.",
      uz: "❌ Videoni tekshirish amalga oshmadi. Ehtimol havola noto'g'ri yoki video mavjud emas.",
      en: "❌ Could not validate the video. The link may be invalid or the video unavailable.",
      ru: "❌ Не удалось проверить видео. Возможно, ссылка неверная или видео недоступно.",
    },
  };

  return messages[reason ?? "unknown"][lang];
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
    process.kill(active.pid, "SIGTERM");
  } catch (err) {
    logger.warn("Failed to kill process", { error: err, pid: active.pid, chatId });
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

function buildTranslatedText(targetLang: string, translatedText: string): string {
  const labels: Record<string, string> = {
    ru: "🇷🇺 Русский",
    en: "🇬🇧 English",
    ky: "🇰🇬 Кыргызча",
    tg: "🇹🇯 Тоҷикӣ",
    uz: "🇺🇿 O'zbekcha",
  };
  return `<b>${labels[targetLang] ?? targetLang}:</b>\n\n${translatedText}`;
}

async function sendTranslatedResult(chatId: number, targetLang: string, translatedText: string): Promise<void> {
  await sendTextMessage(chatId, buildTranslatedText(targetLang, translatedText));
}

async function sendTranslation(
  chatId: number,
  sourceText: string,
  targetLang: string,
  transcriptionId?: number
): Promise<void> {
  const prefs = await getUserPreferences(chatId);
  const lang = prefs.interfaceLanguage;

  if (transcriptionId && transcriptionId > 0) {
    const cached = await getTranslation(transcriptionId, targetLang);
    if (cached) {
      await sendTranslatedResult(chatId, targetLang, cached.translated_text);
      return;
    }
  }

  const statusMsgId = await sendTextMessage(chatId, t("translating", lang));

  const translation = await translateText({ text: sourceText, targetLang });
  const translatedText = translation.translatedText;

  if (transcriptionId && transcriptionId > 0) {
    try {
      await saveTranslation({
        telegramChatId: chatId,
        transcriptionId,
        sourceText,
        targetLang,
        translatedText,
      });
    } catch (err) {
      logger.error("Failed to persist translation", { error: err, chatId, transcriptionId, targetLang });
    }
  }

  await editMessageText(chatId, statusMsgId, buildTranslatedText(targetLang, translatedText));
}

async function prepareTestAudio(fixture: TestFixture, tmpWav: string): Promise<{ source: string; captionPromise: Promise<string | null> }> {
  const fs = await import("fs/promises");
  if (fixture.source === "local") {
    const wavPath = join(process.cwd(), fixture.wavPath);
    await fs.copyFile(wavPath, tmpWav);
    return { source: fixture.wavPath, captionPromise: Promise.resolve(null) };
  }

  const captionPromise = extractYouTubeCaptions(fixture.url!, fixture.language).catch((err) => {
    logger.warn("Caption extraction failed, using fallback", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return null;
  });

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
    await sendTextMessage(chatId, t("sessionExpired", lang), { replyMarkup: createMainKeyboard(lang) });
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

  try {
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
        setActiveProcess(chatId, { pid, startTime: Date.now(), statusMessageId: statusMsgId, type: "test" });
      },
      (progress) => testProgress({ ...progress, label: `${progress.label} (${t("testRecognizing", lang)})` })
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
      logger.error("Failed to persist test transcription", { error: err, chatId });
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

    const keyboard = transcriptionId > 0 ? createTranslationKeyboard(transcriptionId) : undefined;

    await editMessageText(chatId, statusMsgId, summary, removeKeyboard);
    if (keyboard) {
      await sendTextMessage(chatId, t("wantTranslate", lang), { replyMarkup: keyboard });
    }
  } catch (err) {
    const fs = await import("fs/promises");
    await fs.unlink(tmpWav).catch(() => {});
    const msg = `❌ ${t("transcriptionFailed", lang, { error: err instanceof Error ? err.message : String(err) })}`;
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
    logger.error("Test command failed", { error: err, chatId, language });
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
          logger.error("Test failed for language", { error: err, chatId, language });
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
  await answerCallbackQuery(callbackQuery.id);

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
    await sendMainMenu(chatId, { ...prefs, interfaceLanguage: langCode });
    return;
  }

  // Source language selection
  if (data.startsWith("source:")) {
    const [, sourceLang, action, actionId] = data.split(":");
    const normalized = sourceLang as SupportedLanguage | "auto" | "multi";

    if (action === "default") {
      await setUserSourceLanguage(chatId, normalized);
      await sendTextMessage(
        chatId,
        t("sourceLanguageSet", lang, { lang: normalized === "auto" ? t("autoDetect", lang) : LANGUAGE_LABELS[normalized as SupportedLanguage] }),
        { replyMarkup: createSettingsMenuKeyboard(lang) }
      );
    } else if (action === "confirm" && actionId) {
      updatePendingAction(chatId, { sourceLanguage: normalized });
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
      await sendTextMessage(
        chatId,
        t("targetLanguageSet", lang, { lang: normalized === "none" ? t("noDefaultTarget", lang) : LANGUAGE_LABELS[normalized] }),
        { replyMarkup: createSettingsMenuKeyboard(lang) }
      );
    } else if (action === "confirm" && actionId) {
      updatePendingAction(chatId, { targetLanguage: normalized });
      await editConfirmationMessage(chatId, messageId, prefs);
    }
    return;
  }

  // Confirmation actions
  if (data.startsWith("confirm:")) {
    const [, action, actionId] = data.split(":");
    const pending = getPendingAction(chatId);

    if (!pending || pending.actionId !== actionId) {
      await sendTextMessage(chatId, t("sessionExpired", lang), { replyMarkup: createMainKeyboard(lang) });
      return;
    }

    if (action === "start") {
      await startPendingAction(chatId);
    } else if (action === "lang") {
      await editMessageText(
        chatId,
        messageId,
        t("chooseSourceLanguage", lang),
        { replyMarkup: createSourceLanguageKeyboard(`confirm:${actionId}`, `confirm:back:${actionId}`) }
      );
    } else if (action === "back") {
      await editConfirmationMessage(chatId, messageId, prefs);
    } else if (action === "cancel") {
      clearPendingAction(chatId);
      await sendMainMenu(chatId, prefs);
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

  // Main menu actions
  if (data === "action:youtube") {
    await askYouTubeLink(chatId, prefs);
    return;
  }

  if (data === "action:settings") {
    await sendSettingsMenu(chatId, prefs);
    return;
  }

  if (data === "action:settings:interface") {
    await sendTextMessage(chatId, t("chooseInterfaceLanguage", lang), {
      replyMarkup: createInterfaceLanguageKeyboard("action:settings"),
    });
    return;
  }

  if (data === "action:settings:source") {
    await sendTextMessage(chatId, t("chooseSourceLanguage", lang), {
      replyMarkup: createSourceLanguageKeyboard("default", "action:settings"),
    });
    return;
  }

  if (data === "action:settings:target") {
    await sendTextMessage(chatId, t("chooseTargetLanguage", lang), {
      replyMarkup: createTargetLanguageKeyboard("default", "action:settings"),
    });
    return;
  }

  if (data === "action:main") {
    await sendMainMenu(chatId, prefs);
    return;
  }

  if (data === "action:help") {
    await sendTextMessage(chatId, t("help", lang), { replyMarkup: createMainKeyboard(lang) });
    return;
  }

  if (data === "action:test") {
    await sendTextMessage(chatId, t("chooseTestLanguage", lang), { replyMarkup: createTestLanguageKeyboard() });
    return;
  }

  if (data === "action:stop" || data.startsWith("stop:")) {
    await stopActiveProcess(chatId);
    return;
  }

  // Translate existing transcription
  if (!data.startsWith("translate:")) return;

  const parts = data.split(":");
  if (parts.length !== 3) return;

  const targetLang = parts[1];
  const transcriptionId = parseInt(parts[2], 10);
  if (!Number.isFinite(transcriptionId) || transcriptionId <= 0) {
    await sendTextMessage(chatId, t("sessionExpired", lang));
    return;
  }

  const transcription = await getLatestTranscription(chatId);
  if (!transcription || transcription.id !== transcriptionId) {
    await sendTextMessage(chatId, t("sessionExpired", lang));
    return;
  }

  await sendTranslation(chatId, transcription.full_text, targetLang, transcriptionId);
}
