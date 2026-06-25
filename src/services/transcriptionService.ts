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

  // Priority local models hosted on the remote STT server (ky/uz are too heavy for Render/Starter RAM).
  const remoteSupported = new Set(["ky", "uz"]);
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
    return normalizeTranscriptionResult(result);
  }

  // Auto mode: cloud-first. ElevenLabs → OpenAI/Groq → local fallback only
  // when no cloud keys are configured (local models are deprecated in production).
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
  return normalizeTranscriptionResult(result);
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
  const tmpInput = join(tmpdir(), `tiltab_${Date.now()}_${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(tmpInput, audioBuffer);

  return new Promise((resolve, reject) => {
    const script = join(process.cwd(), "transcribe_hybrid.py");
    const proc = spawn(PYTHON_PATH, [script, tmpInput, FFMPEG_PATH, language ?? "auto"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
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
    language: normalizeLanguageCodeOrKeep(result.language) ?? "auto",
  };
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
