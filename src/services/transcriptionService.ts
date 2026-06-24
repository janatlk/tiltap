import { logger } from "../utils/logger";
import { spawn } from "child_process";
import { writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createInterface } from "readline";
import { config } from "../config";
import { transcribeWithOpenAI } from "./openaiSttService";
import type { TranscriptionResult, TranscriptionSegment } from "../types";

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
  onProgress?: (progress: TranscriptionProgress) => void
): Promise<TranscriptionResult> {
  // Priority Turkic languages need local models/Vosk/ElevenLabs for quality.
  // OpenAI/Groq Whisper mislabels Kyrgyz as Kazakh and returns Persian-script Tajik.
  const priorityLanguages = new Set(["ky", "tg", "uz"]);
  const isPriorityLanguage = language !== undefined && priorityLanguages.has(language);

  const useOpenAI =
    config.TILTAB_STT_PROVIDER === "openai" ||
    (config.TILTAB_STT_PROVIDER === "auto" &&
      config.NODE_ENV === "production" &&
      Boolean(config.OPENAI_API_KEY) &&
      !isPriorityLanguage);

  if (useOpenAI) {
    return transcribeWithOpenAI(audioBuffer, filename, language, onProgress);
  }

  logger.info("Running hybrid transcription", { filename, sizeBytes: audioBuffer.length, language });

  const tmpInput = join(tmpdir(), `tiltab_${Date.now()}_${filename}`);
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
