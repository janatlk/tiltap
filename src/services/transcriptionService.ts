import { logger } from "../utils/logger";
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createInterface } from "readline";
import { config } from "../config";
import { transcribeWithOpenAI } from "./openaiSttService";
import { transcribeWithElevenLabs } from "./elevenlabsSttService";
import type { TranscriptionResult, TranscriptionSegment } from "../types";
import { normalizeLanguageCodeOrKeep } from "../utils/languageCodes";
import { transcribeWithRemoteService } from "./remoteSttService";
import { isGpuSttEnabled, isGpuSttLanguageSupported, transcribeWithGpu } from "./gpuSttService";

const FFMPEG_PATH = require("ffmpeg-static");
const PYTHON_PATH = process.platform === "win32" ? "python" : "python3";

export interface TranscriptionProgress {
  percent: number;
  label: string;
}

export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string,
  language?: string,
  onProcessStart?: (pid: number) => void,
  onProgress?: (progress: TranscriptionProgress) => void,
  abortSignal?: AbortSignal
): Promise<TranscriptionResult> {
  const provider = config.TILTAB_STT_PROVIDER;
  const normalizedLang = language ? normalizeLanguageCodeOrKeep(language) : undefined;

  // GPU offloading for supported languages (ru/en/uz/tg/ky/auto/multi). GPU is
  // cheaper and faster than CPU inference on the Hetzner box for heavy files.
  if (isGpuSttEnabled() && normalizedLang && isGpuSttLanguageSupported(normalizedLang)) {
    try {
      const result = await transcribeWithGpu(audioBuffer, filename, normalizedLang, abortSignal);
      return normalizeTranscriptionResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("GPU STT failed, falling back to local hybrid", {
        error: msg,
        language: normalizedLang,
        filename,
      });
      const result = await runHybridTranscription(
        audioBuffer,
        filename,
        language,
        onProcessStart,
        onProgress,
        abortSignal
      );
      return normalizeTranscriptionResult({
        ...result,
        provider: "local",
        model: getLocalModelName(language),
      });
    }
  }

  // Historically uz was offloaded to the remote STT service (Rubai CT2) because
  // it was too heavy for Render's RAM. It now runs through the local hybrid,
  // where gigaam_or_fallback routes uz to GigaAM Multilingual CTC (~22x realtime
  // on CPU, higher accuracy than Rubai) with Rubai kept as the in-process
  // fallback. No language uses the remote service by default anymore; add codes
  // to this set to re-enable per-language offloading to TILTAB_STT_SERVICE_URL.
  const remoteSupported = new Set<string>([]);
  if (config.TILTAB_STT_SERVICE_URL && normalizedLang && remoteSupported.has(normalizedLang)) {
    const result = await transcribeWithRemoteService(audioBuffer, filename, normalizedLang, abortSignal);
    return normalizeTranscriptionResult(result);
  }

  const useCloud = provider === "openai" || provider === "elevenlabs" || (provider === "auto" && (config.ELEVENLABS_API_KEY || config.OPENAI_API_KEY || config.GROQ_API_KEY));

  // Cloud STT providers accept compressed audio, but we normalize to a small mono MP3
  // so that video files have their audio extracted and all providers see a consistent format.
  const cloudBuffer = useCloud
    ? await convertToAudio(audioBuffer, filename).catch((err) => {
        logger.warn("Failed to normalize audio, using original buffer", { error: err.message, filename });
        return audioBuffer;
      })
    : audioBuffer;
  const cloudFilename = filename.replace(/\.[^.]+$/, ".mp3") || "audio.mp3";

  let result: TranscriptionResult;

  if (provider === "openai") {
    result = await transcribeWithOpenAI(cloudBuffer, cloudFilename, language, onProgress, abortSignal);
    return normalizeTranscriptionResult(result);
  }

  if (provider === "elevenlabs") {
    result = await transcribeWithElevenLabs(cloudBuffer, cloudFilename, language, onProgress, abortSignal);
    return normalizeTranscriptionResult(result);
  }

  if (provider === "local") {
    result = await runHybridTranscription(audioBuffer, filename, language, onProcessStart, onProgress, abortSignal);
    return normalizeTranscriptionResult({
      ...result,
      provider: "local",
      model: getLocalModelName(language),
    });
  }

  // Auto mode: cloud-first. ElevenLabs → OpenAI/Groq → local fallback only
  // when no cloud keys are configured. Use provider=local to stay offline.
  const hasCloudKey = Boolean(config.ELEVENLABS_API_KEY || config.OPENAI_API_KEY || config.GROQ_API_KEY);
  const cloudErrors: string[] = [];

  if (config.ELEVENLABS_API_KEY) {
    try {
      result = await transcribeWithElevenLabs(cloudBuffer, cloudFilename, language, onProgress, abortSignal);
      return normalizeTranscriptionResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cloudErrors.push(`ElevenLabs: ${msg}`);
      logger.warn("ElevenLabs transcription failed, falling back", { error: msg });
    }
  }

  if (config.OPENAI_API_KEY || config.GROQ_API_KEY) {
    try {
      result = await transcribeWithOpenAI(cloudBuffer, cloudFilename, language, onProgress, abortSignal);
      return normalizeTranscriptionResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cloudErrors.push(`OpenAI/Groq: ${msg}`);
      logger.warn("OpenAI/Groq transcription failed, falling back", { error: msg });
    }
  }

  if (hasCloudKey) {
    throw new Error(`All configured cloud STT providers failed:\n${cloudErrors.join("\n")}`);
  }

  result = await runHybridTranscription(audioBuffer, filename, language, onProcessStart, onProgress, abortSignal);
  return normalizeTranscriptionResult({
    ...result,
    provider: "local",
    model: getLocalModelName(language),
  });
}

async function convertToAudio(inputBuffer: Buffer, _filename: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, [
      "-hide_banner",
      "-loglevel", "error",
      "-i", "pipe:0",
      "-ar", "16000",
      "-ac", "1",
      "-c:a", "libmp3lame",
      "-b:a", "64k",
      "-f", "mp3",
      "pipe:1",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString("utf-8"); });

    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg normalization failed (code ${code}): ${stderr}`));
      }
      resolve(Buffer.concat(chunks));
    });

    proc.on("error", (err) => reject(err));

    proc.stdin.write(inputBuffer, (err) => {
      if (err) {
        reject(err);
      } else {
        proc.stdin.end();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Legacy hybrid local transcription
// ---------------------------------------------------------------------------

async function runHybridTranscription(
  audioBuffer: Buffer,
  filename: string,
  language?: string,
  onProcessStart?: (pid: number) => void,
  onProgress?: (progress: TranscriptionProgress) => void,
  abortSignal?: AbortSignal
): Promise<TranscriptionResult> {
  logger.info("Running hybrid transcription", { filename, sizeBytes: audioBuffer.length, language });

  // Use a short, safe temp filename. Original filenames (especially from
  // Telegram/web uploads or YouTube titles) can be very long and contain
  // non-ASCII characters that exceed the filesystem's byte limit.
  // Preserve the original extension so ffmpeg can detect the container reliably.
  const originalExt = filename.includes(".") ? `.${filename.split(".").pop()}` : "";
  const safeExt = originalExt.replace(/[^a-zA-Z0-9.]/g, "").slice(0, 10);
  const tmpInput = join(tmpdir(), `tiltab_${Date.now()}_${randomBytes(6).toString("hex")}${safeExt || ".tmp"}`);
  await writeFile(tmpInput, audioBuffer);

  return new Promise((resolve, reject) => {
    const script = join(process.cwd(), "transcribe_hybrid.py");
    // Avoid paying twice for LLM cleanup: the backend runs cleanupService.ts after
    // transcription, so disable the Python-side cleanup in this process.
    const pythonCleanupProvider = config.TILTAB_CLEANUP_PROVIDER === "none" ? undefined : "none";
    const proc = spawn(PYTHON_PATH, [script, tmpInput, FFMPEG_PATH, language ?? "auto"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        ...(pythonCleanupProvider ? { TILTAB_CLEANUP_PROVIDER: pythonCleanupProvider } : {}),
      },
    });

    if (onProcessStart && proc.pid) {
      onProcessStart(proc.pid);
    }

    if (abortSignal) {
      abortSignal.addEventListener("abort", () => {
        proc.kill("SIGTERM");
      });
    }

    let stderr = "";
    const stdoutLines: string[] = [];
    let finalResult: TranscriptionResult | undefined;

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      stdoutLines.push(trimmed);

      if (!trimmed.startsWith("{")) return;

      try {
        const data = JSON.parse(trimmed) as {
          type?: string;
          percent?: number;
          label?: string;
          text?: string;
          language?: string;
          segments?: Array<{ id: number; start: number; end: number; text: string; confidence?: number }>;
        };

        if (data.type === "progress" && typeof data.percent === "number") {
          onProgress?.({ percent: data.percent, label: data.label ?? "" });
          return;
        }

        if (typeof data.text === "string" && Array.isArray(data.segments)) {
          finalResult = parseTranscriptionResult(data);
        }
      } catch {
        // Not JSON, ignore
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString("utf-8");
    });

    proc.on("close", (code) => {
      import("fs/promises").then((fs) => fs.unlink(tmpInput).catch(() => {}));

      if (code !== 0) {
        logger.error("Transcription failed", { code, stderr });
        reject(new Error(`Transcription failed (code ${code}): ${stderr}`));
        return;
      }

      if (!finalResult) {
        finalResult = parseTranscriptionResultFromLines(stdoutLines);
      }

      if (!finalResult) {
        logger.error("Failed to parse transcription output", { stdout: stdoutLines.join("\n"), stderr });
        reject(new Error("Failed to parse transcription output"));
        return;
      }

      logger.info("Transcription complete", {
        language: finalResult.language,
        segmentCount: finalResult.segments.length,
        charCount: finalResult.text.length,
        wordCount: finalResult.text.split(/\s+/).filter(Boolean).length,
        filename,
        requestedLanguage: language,
      });

      resolve(finalResult);
    });

    proc.on("error", (err) => {
      import("fs/promises").then((fs) => fs.unlink(tmpInput).catch(() => {}));
      reject(err);
    });
  });
}

function normalizeTranscriptionResult(result: TranscriptionResult): TranscriptionResult {
  return {
    ...result,
    text: collapseRepeatedWords(result.text),
    segments: result.segments?.map((s) => ({ ...s, text: collapseRepeatedWords(s.text) })),
    language: normalizeLanguageCodeOrKeep(result.language) ?? "auto",
  };
}

// Whisper decode loops occasionally emit the same word dozens of times in a
// row ("жарандарыбыздын" × 25). No natural speech repeats one word more than
// a few times, so runs beyond MAX_WORD_RUN are collapsed.
const MAX_WORD_RUN = 3;

export function collapseRepeatedWords(text: string): string {
  if (!text) return text;
  const words = text.split(/\s+/);
  const out: string[] = [];
  let run = 0;
  for (const word of words) {
    const prev = out[out.length - 1];
    const bare = word.replace(/[.,!?;:]+$/u, "").toLowerCase();
    const prevBare = prev?.replace(/[.,!?;:]+$/u, "").toLowerCase();
    if (bare && bare === prevBare) {
      run += 1;
      if (run >= MAX_WORD_RUN) continue;
    } else {
      run = 0;
    }
    out.push(word);
  }
  return out.join(" ");
}

function getLocalModelName(language?: string): string {
  const lang = normalizeLanguageCodeOrKeep(language) ?? "auto";
  switch (lang) {
    case "tg":
      return "whisper-tajik-finetuned-ct2";
    case "uz":
      return process.env.TILTAB_LOCAL_WHISPER_MODEL_UZ || "rubai-ct2-int8";
    case "ky":
      return process.env.TILTAB_LOCAL_WHISPER_MODEL_KY || "kyrgyz-whisper-small-ct2";
    case "ru":
    case "en":
    case "auto":
    case "multi":
    default:
      return process.env.TILTAB_LOCAL_WHISPER_MODEL || "whisper-large-v3-turbo-ct2";
  }
}

function parseTranscriptionResult(data: {
  text?: string;
  language?: string;
  segments?: Array<{ id: number; start: number; end: number; text: string; confidence?: number }>;
}): TranscriptionResult {
  const segments: TranscriptionSegment[] = (data.segments ?? []).map((s) => ({
    id: s.id,
    start: s.start,
    end: s.end,
    text: s.text.trim(),
  }));

  return {
    text: data.text?.trim() ?? "",
    language: data.language ?? "auto",
    segments,
  };
}

function parseTranscriptionResultFromLines(lines: string[]): TranscriptionResult | undefined {
  const jsonLine = lines.find((l) => l.startsWith("{")) ?? lines[lines.length - 1];
  if (!jsonLine) return undefined;
  try {
    const data = JSON.parse(jsonLine) as {
      text: string;
      language: string;
      segments: Array<{ id: number; start: number; end: number; text: string; confidence?: number }>;
    };
    return parseTranscriptionResult(data);
  } catch {
    return undefined;
  }
}

export function formatSubtitles(segments: TranscriptionSegment[]): string {
  return segments
    .map((seg) => {
      const start = formatTime(seg.start);
      const end = formatTime(seg.end);
      return `[${start} → ${end}] ${seg.text}`;
    })
    .join("\n\n");
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}
