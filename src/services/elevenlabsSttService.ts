import { logger } from "../utils/logger";
import { config } from "../config";
import type { TranscriptionResult, TranscriptionSegment } from "../types";

const ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";

// ElevenLabs accepts ISO 639-1 or ISO 639-3 codes. We map our internal codes
// to the codes that are explicitly listed in the Scribe v2 documentation.
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

const LANGUAGE_MAP: Record<string, string | undefined> = {
  en: "en",
  ru: "ru",
  uz: "uz",
  uz_cyrl: "uz", // source transcription is the same Uzbek audio
  ky: "ky",
  tg: "tgk", // Tajik is listed as tgk (ISO 639-3); tg may also work but tgk is safer.
  auto: undefined,
  multi: undefined,
};

export interface ElevenLabsSttProgress {
  percent: number;
  label: string;
}

interface ElevenLabsWord {
  text: string;
  start: number;
  end: number;
  type: "word" | "spacing" | "audio_event";
  speaker_id?: string;
}

interface ElevenLabsResponse {
  language_code?: string;
  language_probability?: number;
  text?: string;
  words?: ElevenLabsWord[];
}

function mapLanguage(language?: string): string | undefined {
  if (!language) return undefined;
  return LANGUAGE_MAP[language] ?? LANGUAGE_MAP[language.split("+")[0]];
}

function wordsToSegments(words: ElevenLabsWord[]): TranscriptionSegment[] {
  const segments: TranscriptionSegment[] = [];
  let buffer = "";
  let start = 0;
  let end = 0;
  let id = 0;

  const flush = (forceEnd?: number) => {
    const text = buffer.trim();
    if (!text) return;
    segments.push({ id: id++, start, end: forceEnd ?? end, text });
    buffer = "";
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];

    if (w.type === "spacing") {
      buffer += w.text;
      continue;
    }

    if (w.type === "audio_event") {
      // Keep audio events as bracketed markers; post-processing can localize them.
      if (buffer.trim()) {
        flush(w.start);
      }
      buffer += `[${w.text}]`;
      flush(w.end);
      continue;
    }

    if (!buffer.trim()) {
      start = w.start;
    }

    buffer += w.text;
    end = w.end;

    const next = words[i + 1];
    const endsSentence = /[.!?]/.test(w.text);
    const longPause = next && next.type !== "spacing" && next.start - w.end > 1.5;

    if (endsSentence || longPause) {
      flush();
    }
  }

  flush();
  return segments;
}

export async function transcribeWithElevenLabs(
  audioBuffer: Buffer,
  filename: string,
  language?: string,
  onProgress?: (progress: ElevenLabsSttProgress) => void,
  abortSignal?: AbortSignal
): Promise<TranscriptionResult> {
  const apiKey = config.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY is not configured");
  }

  const mappedLang = mapLanguage(language);

  logger.info("Running ElevenLabs Scribe v2 transcription", {
    filename,
    sizeBytes: audioBuffer.length,
    requestedLanguage: language,
    mappedLanguage: mappedLang,
  });

  onProgress?.({ percent: 10, label: "ElevenLabs: загрузка аудио..." });

  const formData = new FormData();
  const blob = new Blob([new Uint8Array(audioBuffer)]);
  const mimeType = getMimeType(filename);
  formData.append("file", new File([blob], filename, { type: mimeType }));
  formData.append("model_id", config.ELEVENLABS_MODEL_ID || "scribe_v2");
  formData.append("tag_audio_events", "true");
  formData.append("timestamps_granularity", "word");
  if (mappedLang) {
    formData.append("language_code", mappedLang);
  }

  onProgress?.({ percent: 50, label: "ElevenLabs: распознаю..." });

  const res = await fetch(ELEVENLABS_STT_URL, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
    },
    body: formData,
    signal: abortSignal,
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error("ElevenLabs transcription failed", { status: res.status, body });
    throw new Error(`ElevenLabs transcription failed (${res.status}): ${body}`);
  }

  onProgress?.({ percent: 90, label: "ElevenLabs: обработка результата..." });

  const data = (await res.json()) as ElevenLabsResponse;
  const rawText = data.text?.trim() ?? "";
  const words = data.words ?? [];
  const segments = words.length > 0 ? wordsToSegments(words) : [{ id: 0, start: 0, end: 0, text: rawText }];

  onProgress?.({ percent: 100, label: "ElevenLabs: готово" });

  logger.info("ElevenLabs transcription complete", {
    detectedLanguage: data.language_code,
    languageProbability: data.language_probability,
    segmentCount: segments.length,
    charCount: rawText.length,
    wordCount: rawText.split(/\s+/).filter(Boolean).length,
    filename,
  });

  return {
    text: rawText,
    language: data.language_code ?? language ?? "auto",
    segments,
    provider: "elevenlabs",
    model: config.ELEVENLABS_MODEL_ID || "scribe_v2",
  };
}
