import { logger } from "../utils/logger";
import { config } from "../config";
import type { TranscriptionResult } from "../types";

export async function transcribeWithRemoteService(
  audioBuffer: Buffer,
  filename: string,
  language: string
): Promise<TranscriptionResult> {
  const baseUrl = config.TILTAB_STT_SERVICE_URL;
  if (!baseUrl) {
    throw new Error("TILTAB_STT_SERVICE_URL is not configured");
  }

  const url = new URL("/transcribe", baseUrl).toString();
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audioBuffer)]), filename);
  form.append("language", language);

  logger.info("Sending transcription request to remote STT service", {
    url: baseUrl,
    language,
    sizeBytes: audioBuffer.length,
  });

  const res = await fetch(url, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Remote STT service returned ${res.status}: ${text}`);
  }

  const data = (await res.json()) as TranscriptionResult & {
    error?: string;
    type?: string;
  };

  if (data.error) {
    throw new Error(`Remote STT service error: ${data.error}`);
  }

  logger.info("Remote STT service response received", {
    language: data.language,
    textLength: data.text?.length,
    segmentCount: data.segments?.length,
  });

  return {
    text: data.text ?? "",
    language: data.language ?? language,
    segments: data.segments ?? [],
  };
}
