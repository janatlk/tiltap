import { spawn } from "child_process";
import { createInterface } from "readline";
import { tmpdir } from "os";
import { join } from "path";
import { logger } from "../utils/logger";
import { transcribeAudio, type TranscriptionProgress } from "./transcriptionService";
import type { TranscriptionResult } from "../types";

const FFMPEG_PATH = require("ffmpeg-static");
const PYTHON_PATH = process.platform === "win32" ? "python" : "python3";

export interface MediaValidation {
  ok: boolean;
  title?: string;
  duration?: number;
  reason?: string;
  error?: string;
}

function detectMissingDependency(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return (
    text.includes("modulenotfounderror") ||
    text.includes("no module named") ||
    text.includes("command not found") ||
    text.includes("'python' is not recognized") ||
    text.includes("'python3' is not recognized")
  );
}

export function isSupportedMediaUrl(url: string): boolean {
  return (
    /^(https?:\/\/)?(www\.|m\.)?(youtube\.com|youtu\.be)\/.+/.test(url) ||
    /^(https?:\/\/)?(www\.|m\.|vm\.|vt\.)?tiktok\.com\/.+/.test(url) ||
    /^(https?:\/\/)?(www\.)?instagram\.com\/(reel|p|stories|tv)\/.+/.test(url)
  );
}

/** @deprecated Use isSupportedMediaUrl instead. */
export function isValidYouTubeUrl(url: string): boolean {
  return isSupportedMediaUrl(url);
}

export async function validateMediaUrl(url: string): Promise<MediaValidation> {
  return new Promise((resolve) => {
    const proc = spawn(PYTHON_PATH, ["validate_youtube.py", url], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });

    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      // Give the Python process a moment to clean up, then force-kill if needed.
      proc.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 5_000);
      proc.on("exit", () => clearTimeout(killTimer));
      resolve({ ok: false, reason: "timeout" });
    }, 60_000);

    proc.on("close", (code: number) => {
      clearTimeout(timeout);
      if (settled) return;
      if (code !== 0) {
        const reason = detectMissingDependency(stderr) ? "missing_deps" : "unknown";
        logger.warn("validateMediaUrl process exited with non-zero code", {
          url,
          code,
          reason,
          stderr: stderr.trim(),
          stdoutTail: stdout.trim().slice(-500),
        });
        resolve({ ok: false, reason });
        return;
      }
      try {
        const data = JSON.parse(stdout.trim().split("\n").pop() || "{}") as MediaValidation;
        if (!data.ok) {
          logger.warn("validateMediaUrl validation failed", {
            url,
            reason: data.reason,
            error: data.error,
            stderr: stderr.trim(),
          });
        }
        resolve(data);
      } catch (parseErr) {
        logger.warn("validateMediaUrl failed to parse JSON", {
          url,
          code,
          stdout,
          stderr: stderr.trim(),
          error: parseErr,
        });
        resolve({ ok: false, reason: "unknown" });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      if (settled) return;
      logger.error("validateMediaUrl failed to spawn process", { url, error: err });
      resolve({ ok: false, reason: "unknown" });
    });
  });
}

export interface MediaDownloadResult {
  audioBuffer: Buffer;
  tmpWav: string;
  pid: number;
}

export async function downloadMediaAudio(
  url: string,
  onProgress?: (progress: TranscriptionProgress) => void,
  abortSignal?: AbortSignal
): Promise<MediaDownloadResult> {
  const tmpWav = join(tmpdir(), `tiltab_yt_${Date.now()}.wav`);

  const pid = await new Promise<number>((resolve, reject) => {
    const proc = spawn(PYTHON_PATH, ["download_youtube.py", url, FFMPEG_PATH, tmpWav], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    if (abortSignal) {
      abortSignal.addEventListener("abort", () => {
        proc.kill("SIGTERM");
      });
    }

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
            onProgress?.({ percent: data.percent, label: data.label ?? "Downloading from YouTube..." });
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
      clearTimeout(timeout);
      if (code !== 0) {
        const errMsg = stderr.trim() || stdoutLines.join("\n").trim() || `Download failed with code ${code}`;
        reject(new Error(errMsg));
      } else {
        resolve(proc.pid ?? 0);
      }
    });
    proc.on("error", (err: Error) => {
      clearTimeout(timeout);
      reject(new Error(`Download process error: ${err.message}`));
    });
  });

  const fs = await import("fs/promises");
  const audioBuffer = await fs.readFile(tmpWav);
  return { audioBuffer, tmpWav, pid };
}

export async function cleanupTempFile(tmpWav: string): Promise<void> {
  const fs = await import("fs/promises");
  await fs.unlink(tmpWav).catch(() => {});
}

export async function transcribeMediaLink(
  url: string,
  language: string,
  onProgress?: (progress: TranscriptionProgress) => void,
  onProcessStart?: (pid: number) => void,
  abortSignal?: AbortSignal
): Promise<TranscriptionResult> {
  const { audioBuffer, tmpWav, pid } = await downloadMediaAudio(url, onProgress, abortSignal);
  if (onProcessStart && pid) {
    onProcessStart(pid);
  }
  try {
    const result = await transcribeAudio(
      audioBuffer,
      "youtube_audio.wav",
      language,
      onProcessStart,
      onProgress,
      abortSignal
    );
    return result;
  } finally {
    await cleanupTempFile(tmpWav);
  }
}
