import { logger } from "../utils/logger";
import { config } from "../config";
import type { TranscriptionResult } from "../types";

// Serialize remote STT requests so that only one heavy model is loaded in
// memory on the Hetzner server at a time. CPX22 has only 4 GB RAM and the
// Docker container is limited to 2.5 GB; running Kyrgyz Vosk large and Uzbek
// Rubai concurrently triggers OOM kills.
let sttQueue: Promise<unknown> = Promise.resolve();

export async function transcribeWithRemoteService(
  audioBuffer: Buffer,
  filename: string,
  language: string,
  abortSignal?: AbortSignal
): Promise<TranscriptionResult> {
  const baseUrl = config.TILTAB_STT_SERVICE_URL;
  if (!baseUrl) {
    throw new Error("TILTAB_STT_SERVICE_URL is not configured");
  }

  const run = async (): Promise<TranscriptionResult> => {
    const url = new URL("/transcribe", baseUrl).toString();
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audioBuffer)]), filename);
    form.append("language", language);

    logger.info("Starting remote STT request", {
      url: baseUrl,
      language,
      sizeBytes: audioBuffer.length,
    });

    const res = await fetch(url, {
      method: "POST",
      body: form,
      signal: abortSignal,
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
  };

  // Chain the new job after the current queue (success or failure).
  const queuedAt = Date.now();
  const job = sttQueue.then(run, run);
  sttQueue = job.catch(() => {
    // Swallow errors here so the queue itself never rejects; the caller
    // receives the rejection via `job`.
  });

  const logOnce = job.then(
    () => {
      logger.info("Remote STT job completed", {
        language,
        waitMs: Date.now() - queuedAt,
      });
    },
    () => {
      logger.warn("Remote STT job failed", {
        language,
        waitMs: Date.now() - queuedAt,
      });
    }
  );
  sttQueue = sttQueue.then(() => logOnce, () => logOnce);

  return job;
}
