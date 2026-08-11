import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { config } from "../config";
import { logger } from "../utils/logger";
import { transcribeAudio } from "./transcriptionService";
import { downloadMediaAudio, cleanupTempFile } from "./youtubeService";
import {
  insertSegment,
  markTaskFailed,
  markTaskReady,
  nextClipNumber,
  updateTaskProgress,
  type DatasetTask,
} from "../db/repos/datasetRepo";

const FFMPEG_PATH = require("ffmpeg-static");
const PYTHON_PATH = process.platform === "win32" ? "python" : "python3";

/**
 * Turns one recording into reviewable clips.
 *
 * Download or accept an upload, normalise to 16 kHz mono, find the pauses,
 * cut on them, and transcribe each clip on its own. The clip has to be cut
 * before it is transcribed rather than after: GigaAM slices its input into
 * blind 24-second windows, so its own segment boundaries land mid-word and its
 * text cannot be redistributed onto shorter clips afterwards.
 */

export interface TaskSource {
  kind: "link" | "upload";
  url?: string;
  buffer?: Buffer;
  filename?: string;
}

export function datasetRoot(): string {
  return config.TILTAB_DATASET_DIR || path.join(process.cwd(), "data", "dataset");
}

export function taskDir(taskId: number): string {
  return path.join(datasetRoot(), "tasks", String(taskId));
}

export function clipFileName(language: string, clipNumber: number): string {
  const safeLang = language.replace(/[^a-z_]/gi, "").toLowerCase() || "xx";
  return `${safeLang}_${String(clipNumber).padStart(6, "0")}.wav`;
}

/**
 * Resolve a stored clip path and refuse anything outside the dataset tree.
 *
 * Paths come from the database, but the database is fed by this process and by
 * whoever can reach it later; a path check here costs nothing and stops a
 * stored "../../etc/passwd" from ever being served.
 */
export function resolveInsideDataset(storedPath: string): string | null {
  const root = path.resolve(datasetRoot());
  const resolved = path.resolve(storedPath);
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null;
}

// ---------------------------------------------------------------------------
// ffmpeg helpers
// ---------------------------------------------------------------------------

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", ...args]);
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf-8");
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (${code}): ${stderr.slice(0, 400)}`));
    });
  });
}

/** 16 kHz mono 16-bit PCM: what both Silero VAD and GigaAM expect. */
async function normalizeToWav(inputPath: string, outputPath: string): Promise<void> {
  await runFfmpeg(["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", outputPath]);
}

async function cutClip(sourceWav: string, start: number, end: number, outputPath: string): Promise<void> {
  await runFfmpeg([
    "-y",
    // Seeking before -i is far faster on a long file, and the source is
    // uncompressed PCM so there is no keyframe to land on inaccurately.
    "-ss", start.toFixed(3),
    "-to", end.toFixed(3),
    "-i", sourceWav,
    "-ar", "16000",
    "-ac", "1",
    "-c:a", "pcm_s16le",
    outputPath,
  ]);
}

// ---------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------

interface ClipPlan {
  start: number;
  end: number;
  forced: boolean;
}

interface SegmentationResult {
  clips: ClipPlan[];
  method: string;
  duration: number;
}

function planClips(wavPath: string): Promise<SegmentationResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_PATH, [path.join("scripts", "segment_audio.py"), wavPath], {
      cwd: process.cwd(),
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf-8");
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf-8");
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`segment_audio.py failed (${code}): ${stderr.slice(0, 400)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as SegmentationResult & { error?: string };
        if (parsed.error) reject(new Error(parsed.error));
        else resolve(parsed);
      } catch {
        reject(new Error(`segment_audio.py returned unparseable output: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/** Tasks currently being prepared, so a restart-safe status can be shown. */
const running = new Set<number>();

export function isTaskRunning(taskId: number): boolean {
  return running.has(taskId);
}

export async function prepareTask(task: DatasetTask, source: TaskSource): Promise<void> {
  running.add(task.id);
  const dir = taskDir(task.id);
  const clipsDir = path.join(dir, "clips");
  const owner = `dataset:${task.id}`;
  let downloadedTmp: string | null = null;

  try {
    await fs.mkdir(clipsDir, { recursive: true });

    // --- 1. Get the audio -------------------------------------------------
    await updateTaskProgress(task.id, { status: "processing", stage: "downloading", progress: 5 });

    let inputPath: string;
    if (source.kind === "link") {
      const result = await downloadMediaAudio(source.url as string, undefined, undefined, owner);
      downloadedTmp = result.tmpWav;
      inputPath = result.tmpWav;
    } else {
      inputPath = path.join(dir, `upload_${sanitizeExt(source.filename)}`);
      await fs.writeFile(inputPath, source.buffer as Buffer);
      downloadedTmp = inputPath;
    }

    // --- 2. Normalise -----------------------------------------------------
    await updateTaskProgress(task.id, { stage: "preparing", progress: 15 });
    const sourceWav = path.join(dir, "source.wav");
    await normalizeToWav(inputPath, sourceWav);

    // --- 3. Find the pauses ----------------------------------------------
    await updateTaskProgress(task.id, { stage: "segmenting", progress: 25 });
    const plan = await planClips(sourceWav);

    const maxSeconds = config.TILTAB_DATASET_MAX_DURATION_MINUTES * 60;
    if (plan.duration > maxSeconds) {
      throw new Error(
        `Запись длиннее ${config.TILTAB_DATASET_MAX_DURATION_MINUTES} мин (${Math.round(plan.duration / 60)} мин). Разбейте её на части.`
      );
    }
    if (plan.clips.length === 0) {
      throw new Error("В записи не найдено речи");
    }

    logger.info("Dataset task segmented", {
      taskId: task.id,
      clips: plan.clips.length,
      method: plan.method,
      durationSec: plan.duration,
    });

    // --- 4. Cut and transcribe each clip ---------------------------------
    for (let i = 0; i < plan.clips.length; i += 1) {
      const clip = plan.clips[i];
      const clipNumber = await nextClipNumber();
      const clipPath = path.join(clipsDir, clipFileName(task.language, clipNumber));

      await cutClip(sourceWav, clip.start, clip.end, clipPath);

      let asrText = "";
      try {
        const buffer = await fs.readFile(clipPath);
        // owner is per task, so the fair queue interleaves these clips with
        // live bot traffic instead of making a real user wait out the corpus.
        const result = await transcribeAudio(
          buffer,
          path.basename(clipPath),
          task.language,
          undefined,
          undefined,
          undefined,
          undefined,
          owner
        );
        asrText = (result.text || "").trim();
      } catch (err) {
        // One unreadable clip must not cost the linguist the other forty-four.
        // An empty transcript is honest: they type it from scratch.
        logger.warn("Dataset clip transcription failed", {
          taskId: task.id,
          clip: i,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      await insertSegment({
        taskId: task.id,
        idx: i,
        clipNumber,
        startSec: clip.start,
        endSec: clip.end,
        audioPath: clipPath,
        asrText,
        forcedCut: Boolean(clip.forced),
      });

      await updateTaskProgress(task.id, {
        stage: "transcribing",
        progress: 25 + Math.round((70 * (i + 1)) / plan.clips.length),
      });
    }

    await markTaskReady(task.id, {
      durationSec: plan.duration,
      audioPath: sourceWav,
      method: plan.method,
      segmentCount: plan.clips.length,
    });
    logger.info("Dataset task ready", { taskId: task.id, clips: plan.clips.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Dataset task failed", { taskId: task.id, error: message });
    await markTaskFailed(task.id, message).catch(() => {});
  } finally {
    running.delete(task.id);
    if (downloadedTmp) await cleanupTempFile(downloadedTmp).catch(() => {});
  }
}

function sanitizeExt(filename?: string): string {
  const ext = filename && filename.includes(".") ? filename.split(".").pop() ?? "" : "";
  const safe = ext.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  return safe ? `input.${safe}` : "input.bin";
}

/** Remove a task's audio from disk. Called when the task itself is deleted. */
export async function removeTaskFiles(taskId: number): Promise<void> {
  const dir = resolveInsideDataset(taskDir(taskId));
  if (!dir) return;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}
