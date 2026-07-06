import { logger } from "../utils/logger";
import { config } from "../config";
import type { TranscriptionResult } from "../types";

// Serialize remote STT requests so that only one heavy model is loaded in
// memory on the Hetzner server at a time. Even on CX43 (16 GB RAM), keeping
// two large models resident at once is unnecessary and wastes RAM; the queue
// also prevents CPU contention on the shared VPS.
let sttQueue: Promise<unknown> = Promise.resolve();
let pendingCount = 0;
let runningJob: { filename: string; language: string; startedAt: number } | null = null;

export interface RemoteSttQueueStatus {
  pending: number;
  running: boolean;
  current?: { filename: string; language: string; startedAt: number };
}

export function getRemoteSttQueueStatus(): RemoteSttQueueStatus {
  return {
    pending: pendingCount,
    running: runningJob !== null,
    current: runningJob ?? undefined,
  };
}

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
    pendingCount = Math.max(0, pendingCount - 1);
    runningJob = { filename, language, startedAt: Date.now() };
    try {
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
        provider: data.provider ?? "remote",
        model: data.model ?? "unknown",
      };
    } finally {
      runningJob = null;
    }
  };

  // Chain the new job after the current queue (success or failure).
  pendingCount += 1;
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
