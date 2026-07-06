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

export function isGpuSttEnabled(): boolean {
  return Boolean(config.TILTAB_GPU_STT_URL);
}

export function isGpuSttLanguageSupported(language: string): boolean {
  return GPU_SUPPORTED_LANGUAGES.has(language.toLowerCase());
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

  logger.info("Starting GPU STT request", {
    endpoint,
    language,
    sizeBytes: audioBuffer.length,
  });

  const res = await fetch(endpoint, {
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

  const data = (await res.json()) as {
    output?: RunPodOutput;
    delayTime?: number;
    executionTime?: number;
    error?: string;
    id?: string;
    status?: string;
  };

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
