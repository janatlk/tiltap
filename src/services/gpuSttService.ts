import { logger } from "../utils/logger";
import { config } from "../config";
import type { TranscriptionResult } from "../types";

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
  const maxWaitMs = 600_000; // 10 minutes
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

  const audioBase64 = audioBuffer.toString("base64");
  const baseUrl = getRunPodBaseUrl();

  logger.info("Starting GPU STT request", {
    endpoint,
    baseUrl,
    language,
    sizeBytes: audioBuffer.length,
  });

  const jobId = await submitGpuJob(baseUrl, audioBase64, language, filename, abortSignal);
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
