import { logger } from "../utils/logger";
import { config } from "../config";
import type { TranscriptionResult, TranscriptionSegment } from "../types";

const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";

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

export interface OpenAiSttProgress {
  percent: number;
  label: string;
}

export async function transcribeWithOpenAI(
  audioBuffer: Buffer,
  filename: string,
  language?: string,
  onProgress?: (progress: OpenAiSttProgress) => void
): Promise<TranscriptionResult> {
  const apiKey = config.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  logger.info("Running OpenAI Whisper transcription", { filename, sizeBytes: audioBuffer.length, language });

  onProgress?.({ percent: 10, label: "OpenAI: загрузка аудио..." });

  const mappedLang = language ? LANGUAGE_MAP[language] : undefined;

  const formData = new FormData();
  const bytes = new Uint8Array(audioBuffer);
  const blob = new Blob([bytes]);
  formData.append("file", new File([blob], filename, { type: "audio/wav" }));
  formData.append("model", "whisper-1");
  formData.append("response_format", "verbose_json");
  if (mappedLang) {
    formData.append("language", mappedLang);
  }

  onProgress?.({ percent: 50, label: "OpenAI: распознаю..." });

  const res = await fetch(OPENAI_TRANSCRIPTION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error("OpenAI transcription failed", { status: res.status, body: text });
    throw new Error(`OpenAI transcription failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    text: string;
    language?: string;
    segments?: Array<{ start: number; end: number; text: string }>;
    words?: Array<{ word: string; start: number; end: number }>;
  };

  onProgress?.({ percent: 90, label: "OpenAI: обработка результата..." });

  const segments: TranscriptionSegment[] = (data.segments ?? []).map((s, idx) => ({
    id: idx,
    start: s.start,
    end: s.end,
    text: s.text.trim(),
  }));

  // If verbose_json did not return segments, create a single segment for the whole text.
  if (segments.length === 0 && data.text) {
    segments.push({
      id: 0,
      start: 0,
      end: 0,
      text: data.text.trim(),
    });
  }

  const result: TranscriptionResult = {
    text: data.text?.trim() ?? "",
    language: mappedLang ?? data.language ?? language ?? "auto",
    segments,
  };

  onProgress?.({ percent: 100, label: "OpenAI: готово" });

  logger.info("OpenAI transcription complete", {
    language: result.language,
    segmentCount: result.segments.length,
    charCount: result.text.length,
    wordCount: result.text.split(/\s+/).filter(Boolean).length,
    filename,
    requestedLanguage: language,
  });

  return result;
}
