import { spawn, type ChildProcess } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { extname, join } from "path";
import { logger } from "../utils/logger";
import { config } from "../config";
import type { TranscriptionResult } from "../types";

const FFMPEG_PATH = require("ffmpeg-static");

// Languages supported by the GPU RunPod worker are controlled by
// TILTAB_GPU_STT_LANGUAGES.
const GPU_SUPPORTED_LANGUAGES = new Set(config.TILTAB_GPU_STT_LANGUAGES);

interface RunPodOutput {
  text?: string;
  language?: string;
  segments?: Array<{ start: number; end: number; text: string }>;
  model?: string;
  gpu?: string;
  error?: string;
}

interface RunPodJobResponse {
  id?: string;
  status?: string;
  output?: RunPodOutput;
  error?: string;
  delayTime?: number;
  executionTime?: number;
}

export function isGpuSttEnabled(): boolean {
  return Boolean(config.TILTAB_GPU_STT_URL);
}

export function isGpuSttLanguageSupported(language: string): boolean {
  return GPU_SUPPORTED_LANGUAGES.has(language.toLowerCase());
}

function getRunPodBaseUrl(): string {
  const url = config.TILTAB_GPU_STT_URL ?? "";
  // TILTAB_GPU_STT_URL usually ends with /runsync; strip it to get the base.
  if (url.endsWith("/runsync")) {
    return url.slice(0, -"/runsync".length);
  }
  if (url.endsWith("/run")) {
    return url.slice(0, -"/run".length);
  }
  return url.replace(/\/$/, "");
}

async function submitGpuJob(
  baseUrl: string,
  audioBase64: string,
  language: string,
  filename: string,
  abortSignal?: AbortSignal
): Promise<string> {
  const res = await fetch(`${baseUrl}/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.TILTAB_GPU_STT_API_KEY
        ? { Authorization: `Bearer ${config.TILTAB_GPU_STT_API_KEY}` }
        : {}),
    },
    body: JSON.stringify({
      input: {
        audio_base64: audioBase64,
        language: language.toLowerCase(),
        filename,
      },
    }),
    signal: abortSignal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GPU STT service returned ${res.status}: ${text}`);
  }

  const data = (await res.json()) as RunPodJobResponse;
  if (!data.id) {
    throw new Error("GPU STT service did not return a job id");
  }
  return data.id;
}

async function pollGpuJob(
  baseUrl: string,
  jobId: string,
  abortSignal?: AbortSignal
): Promise<RunPodJobResponse> {
  const startTime = Date.now();
  const maxWaitMs = config.TILTAB_GPU_STT_TIMEOUT_MS;
  let intervalMs = 2_000;

  while (Date.now() - startTime < maxWaitMs) {
    if (abortSignal?.aborted) {
      throw new Error("GPU STT request aborted");
    }

    const res = await fetch(`${baseUrl}/status/${jobId}`, {
      method: "GET",
      headers: {
        ...(config.TILTAB_GPU_STT_API_KEY
          ? { Authorization: `Bearer ${config.TILTAB_GPU_STT_API_KEY}` }
          : {}),
      },
      signal: abortSignal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GPU STT status check returned ${res.status}: ${text}`);
    }

    const data = (await res.json()) as RunPodJobResponse;
    const status = data.status?.toUpperCase();

    if (status === "COMPLETED") {
      return data;
    }
    if (status === "FAILED" || status === "CANCELLED" || status === "TIMED_OUT") {
      throw new Error(`GPU STT job ${jobId} ended with status ${status}: ${data.error ?? ""}`);
    }

    // Job is still IN_QUEUE or IN_PROGRESS; wait and poll again.
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    intervalMs = Math.min(intervalMs + 1_000, 10_000);
  }

  logger.warn(`GPU STT job ${jobId} timed out after ${maxWaitMs / 1000}s`);
  throw new Error(`GPU STT job ${jobId} timed out after ${maxWaitMs / 1000}s`);
}

export async function transcribeWithGpu(
  audioBuffer: Buffer,
  filename: string,
  language: string,
  abortSignal?: AbortSignal
): Promise<TranscriptionResult> {
  const endpoint = config.TILTAB_GPU_STT_URL;
  if (!endpoint) {
    throw new Error("TILTAB_GPU_STT_URL is not configured");
  }

  const baseUrl = getRunPodBaseUrl();

  // RunPod /run has a 10 MiB body limit. Long WAV files (e.g. 40 min) exceed
  // that easily. Compress to MP3 (mono, 32 kbps) before sending; this
  // keeps a 40-minute file under ~10 MiB base64 while remaining speech-quality.
  // MP3 is universally supported by ffmpeg without extra codecs.
  //
  // Compression uses temporary files rather than pipes because MP4/M4A
  // containers often have their metadata (moov atom) at the end and cannot be
  // reliably demuxed from a non-seekable pipe. With a real file ffmpeg can seek
  // and produces a valid MP3 every time.
  let gpuBuffer = audioBuffer;
  let gpuFilename = filename || "audio.bin";
  if (audioBuffer.length >= 6 * 1024 * 1024) {
    gpuBuffer = await compressAudioForGpu(audioBuffer, filename, abortSignal);
    gpuFilename = "audio.mp3";
  }
  const audioBase64 = gpuBuffer.toString("base64");

  logger.info("Starting GPU STT request", {
    endpoint,
    baseUrl,
    language,
    originalSizeBytes: audioBuffer.length,
    gpuSizeBytes: gpuBuffer.length,
    gpuFilename,
  });

  const jobId = await submitGpuJob(baseUrl, audioBase64, language, gpuFilename, abortSignal);
  logger.info("GPU STT job submitted", { jobId });

  const data = await pollGpuJob(baseUrl, jobId, abortSignal);

  if (data.error) {
    throw new Error(`GPU STT service error: ${data.error}`);
  }

  const output = data.output;
  if (!output) {
    throw new Error("GPU STT service returned no output");
  }

  if (output.error) {
    throw new Error(`GPU STT inference error: ${output.error}`);
  }

  logger.info("GPU STT service response received", {
    language: output.language ?? language,
    textLength: output.text?.length,
    segmentCount: output.segments?.length,
    model: output.model,
    gpu: output.gpu,
  });

  return {
    text: output.text ?? "",
    language: output.language ?? language,
    segments: output.segments ?? [],
    provider: "gpu",
    model: output.model ?? "unknown",
    // Preserve GPU name on result so UI can display it.
    ...(output.gpu ? { gpu: output.gpu } : {}),
  } as TranscriptionResult;
}

async function compressAudioForGpu(
  inputBuffer: Buffer,
  filename: string,
  abortSignal?: AbortSignal
): Promise<Buffer> {
  // If the buffer is already small enough that base64 won't exceed ~6 MiB raw
  // (~8 MiB base64), skip compression to save a few hundred milliseconds.
  if (inputBuffer.length < 6 * 1024 * 1024) {
    return inputBuffer;
  }

  const tmpDir = await mkdtemp(join(tmpdir(), "tiltap-gpu-"));
  const inputExt = extname(filename) || ".bin";
  const inputPath = join(tmpDir, `input${inputExt}`);
  const outputPath = join(tmpDir, "output.mp3");
  let proc: ChildProcess | null = null;

  const cleanup = async () => {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  };

  try {
    await writeFile(inputPath, inputBuffer);

    proc = spawn(FFMPEG_PATH, [
      "-hide_banner",
      "-loglevel", "error",
      "-i", inputPath,
      "-ar", "16000",
      "-ac", "1",
      "-c:a", "libmp3lame",
      "-b:a", "32k",
      "-f", "mp3",
      outputPath,
    ]);

    const abortListener = () => {
      proc?.kill("SIGTERM");
    };
    if (abortSignal) {
      abortSignal.addEventListener("abort", abortListener);
    }

    let stderr = "";
    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf-8");
    });

    const code = await new Promise<number | null>((resolve, reject) => {
      proc!.on("error", reject);
      proc!.on("close", resolve);
    });

    if (abortSignal) {
      abortSignal.removeEventListener("abort", abortListener);
    }

    if (code !== 0) {
      throw new Error(`GPU audio compression failed (code ${code}): ${stderr}`);
    }

    const outputBuffer = await readFile(outputPath);
    if (outputBuffer.length < 1024) {
      throw new Error(
        `GPU audio compression produced tiny output (${outputBuffer.length} bytes); ` +
          `input format may be unsupported. stderr: ${stderr}`
      );
    }
    return outputBuffer;
  } catch (err) {
    logger.error("GPU audio compression error", {
      error: err instanceof Error ? err.message : String(err),
      filename,
      inputSizeBytes: inputBuffer.length,
    });
    throw err;
  } finally {
    await cleanup();
  }
}
