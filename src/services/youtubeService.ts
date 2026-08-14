import { spawn } from "child_process";
import { createInterface } from "readline";
import { tmpdir } from "os";
import { join } from "path";
import { logger } from "../utils/logger";
import { transcribeAudio, type TranscriptionProgress } from "./transcriptionService";
import { getCobaltApiUrlsEnv } from "./cobaltConfigService";
import { downloadGate } from "./concurrencyGate";
import type { TranscriptionResult } from "../types";
import { config } from "../config";

const FFMPEG_PATH = require("ffmpeg-static");
const PYTHON_PATH = process.platform === "win32" ? "python" : "python3";

export interface MediaValidation {
  ok: boolean;
  title?: string;
  duration?: number;
  reason?: string;
  error?: string;
}

function getCobaltEnv(): NodeJS.ProcessEnv {
  const cobaltUrls = getCobaltApiUrlsEnv();
  return {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    ...(cobaltUrls ? { COBALT_API_URLS: cobaltUrls } : {}),
    // Instances that need an operator key answer auth.jwt.missing without it,
    // so the key has to reach the Python downloader too, not just the monitor.
    ...(config.COBALT_API_KEYS ? { COBALT_API_KEYS: config.COBALT_API_KEYS } : {}),
  };
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

export type MediaSourceId = "youtube" | "tiktok" | "instagram" | "link";

/**
 * Which service a media link points at. We accept TikTok and Instagram as well
 * as YouTube, but every user-facing string used to say "YouTube" regardless,
 * down to the name of the produced file — so a TikTok link reported itself as a
 * YouTube download.
 */
export function detectMediaSource(url: string): MediaSourceId {
  if (/^(https?:\/\/)?(www\.|m\.)?(youtube\.com|youtu\.be)\//.test(url)) return "youtube";
  if (/^(https?:\/\/)?(www\.|m\.|vm\.|vt\.)?tiktok\.com\//.test(url)) return "tiktok";
  if (/^(https?:\/\/)?(www\.)?instagram\.com\//.test(url)) return "instagram";
  return "link";
}

const MEDIA_SOURCE_NAMES: Record<MediaSourceId, string> = {
  youtube: "YouTube",
  tiktok: "TikTok",
  instagram: "Instagram",
  link: "the link",
};

/** Human-readable name of the service, for progress labels. */
export function mediaSourceName(url: string): string {
  return MEDIA_SOURCE_NAMES[detectMediaSource(url)];
}

/** Name for the audio we extracted, so the file reflects where it came from. */
export function mediaAudioFilename(url: string): string {
  const id = detectMediaSource(url);
  return id === "link" ? "media_audio.wav" : `${id}_audio.wav`;
}

/** @deprecated Use isSupportedMediaUrl instead. */
export function isValidYouTubeUrl(url: string): boolean {
  return isSupportedMediaUrl(url);
}

/**
 * Liveness check for the yt-dlp fallback engine, used by the health monitor to
 * decide whether downloads are truly dead or merely down to the last engine.
 * The probe pulls real bytes and can take minutes (JS challenges), so it is
 * only worth running once Cobalt has already failed everywhere.
 */
export async function probeYtdlp(url: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const proc = spawn(PYTHON_PATH, ["youtube_ytdlp.py", "--probe", url], {
      cwd: process.cwd(),
      env: getCobaltEnv(),
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });

    let settled = false;
    const finish = (result: { ok: boolean; detail: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // Outer bound; the Python side has its own, tighter deadline.
    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      finish({ ok: false, detail: "probe timeout" });
    }, 300_000);

    proc.on("error", (err) => {
      clearTimeout(timeout);
      finish({ ok: false, detail: err.message });
    });

    proc.on("close", () => {
      clearTimeout(timeout);
      try {
        const data = JSON.parse(stdout.trim().split("\n").pop() || "{}") as { ok?: boolean; detail?: string };
        finish({ ok: Boolean(data.ok), detail: data.detail ?? "no detail" });
      } catch {
        finish({ ok: false, detail: stderr.trim().slice(-200) || "probe produced no result" });
      }
    });
  });
}

export async function validateMediaUrl(url: string): Promise<MediaValidation> {
  return new Promise((resolve) => {
    const proc = spawn(PYTHON_PATH, ["validate_youtube.py", url], {
      cwd: process.cwd(),
      env: getCobaltEnv(),
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
      logger.error("validateMediaUrl failed to spawn process", { url, error: err instanceof Error ? err.message : String(err) });
      resolve({ ok: false, reason: "unknown" });
    });
  });
}

export interface MediaDownloadResult {
  /**
   * Reads the downloaded audio into memory. Deliberately not a Buffer field:
   * the file may be a hundred megabytes for an hour-long video, and it used to
   * be read eagerly and then held for the entire transcription queue wait.
   * Call this at the point of use so the bytes live as briefly as possible.
   */
  readAudio: () => Promise<Buffer>;
  tmpWav: string;
  pid: number;
}

export async function downloadMediaAudio(
  url: string,
  onProgress?: (progress: TranscriptionProgress) => void,
  abortSignal?: AbortSignal,
  owner?: string
): Promise<MediaDownloadResult> {
  // Cap parallel downloads. Each one spawns Python and then ffmpeg, and
  // unbounded ffmpeg processes starve the transcription doing the real work.
  const ticket = downloadGate.take(owner);
  const queuedAt = Date.now();
  await ticket.wait(abortSignal);
  downloadGate.logWait(Date.now() - queuedAt, url);
  try {
    return await runDownload(url, onProgress, abortSignal);
  } finally {
    ticket.release();
  }
}

async function runDownload(
  url: string,
  onProgress?: (progress: TranscriptionProgress) => void,
  abortSignal?: AbortSignal
): Promise<MediaDownloadResult> {
  const tmpWav = join(tmpdir(), `tiltab_yt_${Date.now()}.wav`);

  const pid = await new Promise<number>((resolve, reject) => {
    const proc = spawn(PYTHON_PATH, ["download_youtube.py", url, FFMPEG_PATH, tmpWav], {
      cwd: process.cwd(),
      env: getCobaltEnv(),
    });

    if (abortSignal) {
      abortSignal.addEventListener("abort", () => {
        proc.kill("SIGTERM");
      });
    }

    let stderr = "";
    const stdoutLines: string[] = [];

    // Idle timeout: abort only if the download makes no progress (no stdout/stderr
    // output) for this long. This lets long videos download without a hard cap
    // while still catching genuinely stalled processes.
    const idleTimeoutMs = config.TILTAB_MEDIA_DOWNLOAD_IDLE_TIMEOUT_MS;
    let idleTimer: NodeJS.Timeout;
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(
          new Error(
            `Download stalled: no progress for ${Math.round(idleTimeoutMs / 1000)}s. The video may be unavailable.`
          )
        );
      }, idleTimeoutMs);
    };
    resetIdleTimer();

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line: string) => {
      resetIdleTimer();
      const trimmed = line.trim();
      if (!trimmed) return;
      stdoutLines.push(trimmed);
      if (trimmed.startsWith("{")) {
        try {
          const data = JSON.parse(trimmed) as { type?: string; percent?: number; label?: string };
          if (data.type === "progress" && typeof data.percent === "number") {
            onProgress?.({ percent: data.percent, label: data.label ?? `Downloading from ${mediaSourceName(url)}...` });
          }
        } catch {
          // ignore non-JSON
        }
      }
    });

    proc.stderr.on("data", (d: Buffer) => { resetIdleTimer(); stderr += d.toString("utf-8"); });

    proc.on("close", (code: number) => {
      clearTimeout(idleTimer);
      if (code !== 0) {
        const errMsg = stderr.trim() || stdoutLines.join("\n").trim() || `Download failed with code ${code}`;
        reject(new Error(errMsg));
      } else {
        resolve(proc.pid ?? 0);
      }
    });
    proc.on("error", (err: Error) => {
      clearTimeout(idleTimer);
      reject(new Error(`Download process error: ${err.message}`));
    });
  });

  const fs = await import("fs/promises");
  return { readAudio: () => fs.readFile(tmpWav), tmpWav, pid };
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
  abortSignal?: AbortSignal,
  onQueuePosition?: (position: number) => void,
  owner?: string
): Promise<TranscriptionResult> {
  // Скачивание и распознавание отчитываются каждое по своей шкале от нуля до
  // ста. На одной полосе это выглядело так: цифра доходила до сотни, а потом
  // падала обратно в ноль, и человек считал, что всё началось заново. Отводим
  // каждому этапу свою часть полосы, и она движется только вперёд.
  const band = (from: number, to: number) => (p: TranscriptionProgress) => {
    // Отрицательную долю проносим как есть: это не число на шкале, а признак
    // того, что доли нет вовсе. Пересчитать её в диапазон значило бы получить
    // осмысленное на вид число из отсутствия данных.
    if (p.percent < 0) {
      onProgress?.(p);
      return;
    }
    onProgress?.({ ...p, percent: from + (Math.max(0, Math.min(100, p.percent)) * (to - from)) / 100 });
  };
  const DOWNLOAD_SHARE_END = 35;

  const { readAudio, tmpWav, pid } = await downloadMediaAudio(
    url,
    onProgress ? band(0, DOWNLOAD_SHARE_END) : undefined,
    abortSignal,
    owner
  );
  if (onProcessStart && pid) {
    onProcessStart(pid);
  }
  try {
    const result = await transcribeAudio(
      readAudio,
      mediaAudioFilename(url),
      language,
      onProcessStart,
      onProgress ? band(DOWNLOAD_SHARE_END, 100) : undefined,
      abortSignal,
      onQueuePosition,
      owner
    );
    return result;
  } finally {
    await cleanupTempFile(tmpWav);
  }
}
