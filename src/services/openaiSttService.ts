import { logger } from "../utils/logger";
import { config } from "../config";
import type { TranscriptionResult, TranscriptionSegment } from "../types";

const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

const MIME_TYPES: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".webm": "audio/webm",
  ".flac": "audio/flac",
};

function getMimeType(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return MIME_TYPES[ext] ?? "audio/mpeg";
}

// OpenAI Whisper supports: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm.
// Map our language codes to the closest supported ISO-639-1 code. For languages
// Whisper does not support natively we omit the language hint and let it auto-detect.
const LANGUAGE_MAP: Record<string, string | undefined> = {
  en: "en",
  ru: "ru",
  uz: "uz",
  tg: undefined, // Tajik is not supported; auto-detect tends to pick Persian/Arabic, so we omit it
  ky: undefined, // Kyrgyz is not supported
  auto: undefined,
  multi: undefined,
};

// Groq Whisper supports the same language hints as OpenAI Whisper.
const GROQ_LANGUAGE_MAP: Record<string, string | undefined> = LANGUAGE_MAP;

export interface OpenAiSttProgress {
  percent: number;
  label: string;
}

function buildFormData(
  audioBuffer: Buffer,
  filename: string,
  mappedLang: string | undefined,
  model: string
): FormData {
  const formData = new FormData();
  const bytes = new Uint8Array(audioBuffer);
  const blob = new Blob([bytes]);
  formData.append("file", new File([blob], filename, { type: getMimeType(filename) }));
  formData.append("model", model);
  formData.append("response_format", "verbose_json");
  if (mappedLang) {
    formData.append("language", mappedLang);
  }
  return formData;
}

async function parseTranscriptionResponse(res: Response, fallbackLanguage: string): Promise<TranscriptionResult> {
  const data = (await res.json()) as {
    text: string;
    language?: string;
    segments?: Array<{ start: number; end: number; text: string }>;
    words?: Array<{ word: string; start: number; end: number }>;
  };

  const segments: TranscriptionSegment[] = (data.segments ?? []).map((s, idx) => ({
    id: idx,
    start: s.start,
    end: s.end,
    text: s.text.trim(),
  }));

  if (segments.length === 0 && data.text) {
    segments.push({
      id: 0,
      start: 0,
      end: 0,
      text: data.text.trim(),
    });
  }

  return {
    text: data.text?.trim() ?? "",
    language: data.language ?? fallbackLanguage,
    segments,
  };
}

async function callSttProvider(
  url: string,
  apiKey: string,
  audioBuffer: Buffer,
  filename: string,
  mappedLang: string | undefined,
  model: string,
  providerName: string,
  onProgress?: (progress: OpenAiSttProgress) => void
): Promise<TranscriptionResult> {
  logger.info(`Running ${providerName} Whisper transcription`, { filename, sizeBytes: audioBuffer.length, language: mappedLang });

  onProgress?.({ percent: 10, label: `${providerName}: загрузка аудио...` });

  const formData = buildFormData(audioBuffer, filename, mappedLang, model);

  onProgress?.({ percent: 50, label: `${providerName}: распознаю...` });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error(`${providerName} transcription failed`, { status: res.status, body: text });
    throw new Error(`${providerName} transcription failed (${res.status}): ${text}`);
  }

  onProgress?.({ percent: 90, label: `${providerName}: обработка результата...` });

  const result = await parseTranscriptionResponse(res, mappedLang ?? "auto");

  onProgress?.({ percent: 100, label: `${providerName}: готово` });

  logger.info(`${providerName} transcription complete`, {
    language: result.language,
    segmentCount: result.segments.length,
    charCount: result.text.length,
    wordCount: result.text.split(/\s+/).filter(Boolean).length,
    filename,
    requestedLanguage: mappedLang,
  });

  return result;
}

function isRetryableError(status: number, body: string): boolean {
  if (status === 429) return true;
  if (status === 401 || status === 403) return true;
  if (status >= 500) return true;
  if (body.toLowerCase().includes("quota")) return true;
  if (body.toLowerCase().includes("insufficient_quota")) return true;
  return false;
}

export async function transcribeWithOpenAI(
  audioBuffer: Buffer,
  filename: string,
  language?: string,
  onProgress?: (progress: OpenAiSttProgress) => void
): Promise<TranscriptionResult> {
  const openaiKey = config.OPENAI_API_KEY;
  const groqKey = config.GROQ_API_KEY;
  const mappedLang = language ? LANGUAGE_MAP[language] : undefined;

  if (!openaiKey && !groqKey) {
    throw new Error("Neither OPENAI_API_KEY nor GROQ_API_KEY is configured for STT");
  }

  // Try OpenAI first if a key is configured.
  let openaiError: Error | undefined;
  if (openaiKey) {
    try {
      return await callSttProvider(
        OPENAI_TRANSCRIPTION_URL,
        openaiKey,
        audioBuffer,
        filename,
        mappedLang,
        config.OPENAI_STT_MODEL || "whisper-1",
        "OpenAI",
        onProgress
      );
    } catch (err) {
      openaiError = err instanceof Error ? err : new Error(String(err));
      const isRetryable = isRetryableError(0, openaiError.message);
      logger.warn("OpenAI STT failed", { error: openaiError.message, fallbackToGroq: Boolean(groqKey) && isRetryable });

      if (!groqKey || !isRetryable) {
        throw openaiError;
      }
      // Fall through to Groq.
    }
  }

  // Fallback to Groq Whisper API.
  if (!groqKey) {
    throw openaiError ?? new Error("OpenAI STT failed and no GROQ_API_KEY is configured for fallback");
  }

  const allowedGroqLanguages = new Set(config.TILTAB_GROQ_WHISPER_LANGUAGES);
  const requestedLang = language?.toLowerCase() ?? "auto";
  if (!allowedGroqLanguages.has(requestedLang)) {
    logger.warn("Groq Whisper is not enabled for this language by default, trying anyway as a fallback", {
      requestedLang,
      allowedLanguages: config.TILTAB_GROQ_WHISPER_LANGUAGES,
    });
  }

  return await callSttProvider(
    GROQ_TRANSCRIPTION_URL,
    groqKey,
    audioBuffer,
    filename,
    mappedLang,
    "whisper-large-v3",
    "Groq",
    onProgress
  );
}
