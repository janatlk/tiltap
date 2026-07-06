import type { Request, Response } from "express";
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { writeFile, unlink, readdir, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { logger } from "../utils/logger";
import { config } from "../config";
import { isSupportedMediaUrl, validateMediaUrl, downloadMediaAudio, cleanupTempFile } from "../services/youtubeService";

const PYTHON_PATH = process.platform === "win32" ? "python" : "python3";
const FFMPEG_PATH = require("ffmpeg-static");
const MODELS_DIR = join(process.cwd(), "models");

interface LocalModelInfo {
  name: string;
  path: string;
  type: "whisper" | "vosk";
  api: boolean;
}

// Models that are baked into the RunPod Serverless GPU endpoint. These are the
// models the GPU worker can actually load, regardless of local Hetzner copies.
const RUNPOD_GPU_MODEL_DIRS = new Set([
  "whisper-large-v3-turbo-ct2",
  "rubai-ct2-int8",
  "muhtasham-whisper-tg-ct2",
  "kyrgyz-whisper-small-ct2",
]);

function isApiModel(name: string): boolean {
  return RUNPOD_GPU_MODEL_DIRS.has(name);
}

interface BetaJob {
  id: string;
  status: "pending" | "running" | "completed" | "error" | "aborted";
  progress: number;
  label: string;
  sourceLang?: string;
  sourceUrl?: string;
  filename?: string;
  pid?: number;
  modelName?: string;
  createdAt: number;
  updatedAt: number;
  proc?: ReturnType<typeof spawn>;
}

const betaJobs = new Map<string, BetaJob>();
let betaJobCounter = 0;

function createBetaJob(meta: {
  sourceLang?: string;
  sourceUrl?: string;
  filename?: string;
  modelName?: string;
}): BetaJob {
  const id = `beta-${Date.now()}-${++betaJobCounter}`;
  const job: BetaJob = {
    id,
    status: "pending",
    progress: 0,
    label: "Waiting…",
    ...meta,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  betaJobs.set(id, job);
  return job;
}

function updateBetaJob(job: BetaJob, patch: Partial<BetaJob>) {
  Object.assign(job, patch);
  job.updatedAt = Date.now();
}

export function getBetaJobs(): Map<string, BetaJob> {
  return betaJobs;
}

export async function getBetaJob(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const job = betaJobs.get(String(req.params.jobId));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json({ job });
}

export async function abortBetaJob(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const job = betaJobs.get(String(req.params.jobId));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  try {
    if (job.proc && !job.proc.killed) {
      job.proc.kill("SIGTERM");
    }
    updateBetaJob(job, { status: "aborted", label: "Aborted by user" });
    res.json({ ok: true, job });
  } catch (err) {
    logger.error("Abort beta job error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to abort job" });
  }
}

function isAuthorized(req: Request): boolean {
  const token = config.TILTAB_ADMIN_TOKEN;
  if (!token) return false;
  return req.headers["x-admin-token"] === token;
}

export async function listBetaModels(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const models: LocalModelInfo[] = [];
    const entries = await readdir(MODELS_DIR).catch(() => [] as string[]);

    for (const entry of entries) {
      const fullPath = join(MODELS_DIR, entry);
      const info = await stat(fullPath).catch(() => null);
      if (!info || !info.isDirectory()) continue;

      const lower = entry.toLowerCase();
      let type: "whisper" | "vosk" | undefined;
      if (lower.includes("vosk")) {
        type = "vosk";
      } else if (
        lower.includes("whisper") ||
        lower.includes("ct2") ||
        lower.includes("rubai") ||
        lower.includes("tajik") ||
        lower.includes("distil")
      ) {
        type = "whisper";
      }
      if (type) {
        models.push({ name: entry, path: fullPath, type, api: isApiModel(entry) });
      }
    }

    res.json({ models });
  } catch (err) {
    logger.error("Beta models list error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function handleBetaTranscribe(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const model = typeof req.body.model === "string" ? req.body.model : "";
    const language = typeof req.body.language === "string" && req.body.language !== "auto" ? req.body.language : undefined;

    if (!model) {
      res.status(400).json({ error: "Model is required" });
      return;
    }

    const result = await runBetaStt(file.buffer, file.originalname, model, language);
    res.json(result);
  } catch (err) {
    logger.error("Beta transcribe error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" });
  }
}

export async function handleBetaLink(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const { url, model, language } = req.body as { url?: string; model?: string; language?: string };

    if (!url || !isSupportedMediaUrl(url)) {
      res.status(400).json({ error: "Missing or invalid media URL" });
      return;
    }
    if (!model) {
      res.status(400).json({ error: "Model is required" });
      return;
    }

    const validation = await validateMediaUrl(url);
    if (!validation.ok) {
      res.status(400).json({ error: validation.reason ?? "unknown", details: validation });
      return;
    }

    const { audioBuffer, tmpWav } = await downloadMediaAudio(url);
    try {
      const result = await runBetaStt(
        audioBuffer,
        "youtube_audio.wav",
        model,
        language && language !== "auto" ? language : undefined,
        { sourceUrl: url },
      );
      res.json({ ...result, title: validation.title });
    } finally {
      await cleanupTempFile(tmpWav);
    }
  } catch (err) {
    logger.error("Beta link error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" });
  }
}

async function runBetaStt(
  buffer: Buffer,
  filename: string,
  model: string,
  language?: string,
  meta?: { sourceUrl?: string; modelName?: string },
): Promise<Record<string, unknown>> {
  const tmpInput = join(tmpdir(), `tiltab_beta_${Date.now()}_${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(tmpInput, buffer);

  const modelName = meta?.modelName || model.split("/").pop() || model;
  const job = createBetaJob({
    sourceLang: language,
    sourceUrl: meta?.sourceUrl,
    filename,
    modelName,
  });

  return new Promise((resolve, reject) => {
    const proc = spawn(
      PYTHON_PATH,
      [join(process.cwd(), "transcribe_hybrid.py"), tmpInput, FFMPEG_PATH, language ?? "auto"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          TILTAB_BETA_MODEL: model,
          TILTAB_SKIP_POSTPROCESS: "1",
        },
      }
    );

    job.proc = proc;
    job.pid = proc.pid;
    updateBetaJob(job, { status: "running", label: "Transcribing…" });

    let stderr = "";
    const stdoutLines: string[] = [];
    let finalResult: Record<string, unknown> | undefined;

    proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString("utf-8");
      stdoutLines.push(text);
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("{")) continue;
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          if (typeof parsed.text === "string" && Array.isArray(parsed.segments)) {
            finalResult = parsed;
          }
        } catch {
          // ignore
        }
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString("utf-8");
    });

    proc.on("close", async (code) => {
      await unlink(tmpInput).catch(() => {});
      if (code !== 0) {
        updateBetaJob(job, { status: "error", label: `Failed (code ${code})` });
        reject(new Error(`Beta STT failed (code ${code}): ${stderr}`));
        return;
      }
      if (!finalResult) {
        finalResult = parseLastJsonLine(stdoutLines);
      }
      if (!finalResult) {
        updateBetaJob(job, { status: "error", label: "No result" });
        reject(new Error("Failed to parse beta STT output"));
        return;
      }
      updateBetaJob(job, { status: "completed", progress: 100, label: "Completed" });
      resolve(finalResult);
    });

    proc.on("error", async (err) => {
      await unlink(tmpInput).catch(() => {});
      updateBetaJob(job, { status: "error", label: err.message });
      reject(err);
    });
  });
}

function parseLastJsonLine(lines: string[]): Record<string, unknown> | undefined {
  const all = lines.join("");
  const jsonLine = all
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .reverse()
    .find((l) => l.startsWith("{"));
  if (!jsonLine) return undefined;
  try {
    return JSON.parse(jsonLine) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

interface BetaProgressEvent {
  type: "progress";
  key: "a" | "b";
  model: string;
  percent: number;
  label: string;
}

interface BetaResultEvent {
  type: "result";
  key: "a" | "b";
  model: string;
  data: Record<string, unknown>;
}

interface BetaErrorEvent {
  type: "error";
  key: "a" | "b";
  model: string;
  error: string;
}

type BetaStreamEvent = BetaProgressEvent | BetaResultEvent | BetaErrorEvent;

async function runBetaSttStream(
  buffer: Buffer,
  filename: string,
  model: string,
  language: string | undefined,
  key: "a" | "b",
  modelName: string,
  onEvent: (event: BetaStreamEvent) => void,
): Promise<Record<string, unknown>> {
  const tmpInput = join(tmpdir(), `tiltab_beta_${Date.now()}_${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(tmpInput, buffer);

  const job = createBetaJob({
    sourceLang: language,
    filename,
    modelName,
  });

  return new Promise((resolve, reject) => {
    const proc = spawn(
      PYTHON_PATH,
      [join(process.cwd(), "transcribe_hybrid.py"), tmpInput, FFMPEG_PATH, language ?? "auto"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          TILTAB_BETA_MODEL: model,
          TILTAB_SKIP_POSTPROCESS: "1",
        },
      },
    );

    job.proc = proc;
    job.pid = proc.pid;
    updateBetaJob(job, { status: "running", label: `Running ${modelName}…` });

    let stderr = "";
    let bufferData = "";
    let finalResult: Record<string, unknown> | undefined;

    proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString("utf-8");
      bufferData += text;
      const lines = bufferData.split("\n");
      bufferData = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("{")) continue;
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          if (typeof parsed.text === "string" && Array.isArray(parsed.segments)) {
            finalResult = parsed;
          } else if (typeof parsed.percent === "number") {
            const percent = parsed.percent as number;
            const label = String(parsed.label || "");
            updateBetaJob(job, { progress: percent, label });
            onEvent({
              type: "progress",
              key,
              model: modelName,
              percent,
              label,
            });
          }
        } catch {
          // ignore malformed JSON lines
        }
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString("utf-8");
    });

    proc.on("close", async (code) => {
      await unlink(tmpInput).catch(() => {});
      if (code !== 0) {
        updateBetaJob(job, { status: "error", label: `Failed (code ${code})` });
        reject(new Error(`Beta STT failed (code ${code}): ${stderr}`));
        return;
      }
      if (!finalResult) {
        finalResult = parseLastJsonLine([bufferData]);
      }
      if (!finalResult) {
        updateBetaJob(job, { status: "error", label: "No result" });
        reject(new Error("Failed to parse beta STT output"));
        return;
      }
      updateBetaJob(job, { status: "completed", progress: 100, label: "Completed" });
      resolve(finalResult);
    });

    proc.on("error", async (err) => {
      await unlink(tmpInput).catch(() => {});
      updateBetaJob(job, { status: "error", label: err.message });
      reject(err);
    });
  });
}

export async function handleBetaCompare(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const body = req.body as {
    modelA?: string;
    modelB?: string;
    language?: string;
    url?: string;
  };
  const modelA = typeof body.modelA === "string" ? body.modelA : "";
  const modelB = typeof body.modelB === "string" ? body.modelB : "";
  const language = typeof body.language === "string" && body.language !== "auto" ? body.language : undefined;

  if (!modelA || !modelB) {
    res.status(400).json({ error: "Both modelA and modelB are required" });
    return;
  }

  let audioBuffer: Buffer;
  let filename: string;
  let tmpWav: string | undefined;
  let title: string | undefined;

  try {
    if (req.file) {
      audioBuffer = req.file.buffer;
      filename = req.file.originalname;
    } else if (body.url && isSupportedMediaUrl(body.url)) {
      const validation = await validateMediaUrl(body.url);
      if (!validation.ok) {
        res.status(400).json({ error: validation.reason ?? "unknown", details: validation });
        return;
      }
      const download = await downloadMediaAudio(body.url);
      audioBuffer = download.audioBuffer;
      tmpWav = download.tmpWav;
      filename = "youtube_audio.wav";
      title = validation.title;
    } else {
      res.status(400).json({ error: "Upload a file or provide a supported media URL" });
      return;
    }

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const modelNames = await getModelNames();
    const nameA = modelNames.get(modelA) || modelA;
    const nameB = modelNames.get(modelB) || modelB;

    function send(event: BetaStreamEvent | { type: "done"; title?: string }) {
      res.write(JSON.stringify(event) + "\n");
    }

    try {
      const resultA = await runBetaSttStream(audioBuffer, filename, modelA, language, "a", nameA, send);
      send({ type: "result", key: "a", model: nameA, data: resultA });

      const resultB = await runBetaSttStream(audioBuffer, filename, modelB, language, "b", nameB, send);
      send({ type: "result", key: "b", model: nameB, data: resultB });

      send({ type: "done", title });
      res.end();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error("Beta compare error", { error });
      send({ type: "error", key: "b", model: "", error });
      res.end();
    }
  } catch (err) {
    logger.error("Beta compare setup error", { error: err instanceof Error ? err.message : String(err) });
    if (!res.headersSent) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" });
    } else {
      res.end();
    }
  } finally {
    if (tmpWav) {
      await cleanupTempFile(tmpWav).catch(() => {});
    }
  }
}

async function getModelNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const entries = await readdir(MODELS_DIR).catch(() => [] as string[]);
  for (const entry of entries) {
    const fullPath = join(MODELS_DIR, entry);
    const info = await stat(fullPath).catch(() => null);
    if (!info || !info.isDirectory()) continue;
    const lower = entry.toLowerCase();
    if (lower.includes("vosk")) {
      names.set(fullPath, entry);
    } else if (
      lower.includes("whisper") ||
      lower.includes("ct2") ||
      lower.includes("rubai") ||
      lower.includes("tajik") ||
      lower.includes("distil")
    ) {
      names.set(fullPath, entry);
    }
  }
  return names;
}
