import { logger } from "../utils/logger";
import { randomBytes } from "crypto";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { config } from "../config";
import type { TranscriptionResult } from "../types";

const FFMPEG_PATH = require("ffmpeg-static");

const GIGAAM_SERVER_LANGUAGES = new Set(config.TILTAB_GIGAAM_SERVER_LANGUAGES);

export function isGigaamServerEnabled(): boolean {
  return Boolean(config.TILTAB_GIGAAM_SERVER_URL);
}

export function isGigaamServerLanguage(language: string): boolean {
  return GIGAAM_SERVER_LANGUAGES.has(language.toLowerCase());
}

/**
 * Transcribe via the persistent GigaAM worker (gigaam_server.py). The worker
 * keeps the model resident, so this avoids the ~2.8s per-request model reload
 * of the spawn path. Audio is passed by file path because the worker runs on
 * the same host. Throws on any failure so the caller can fall back to spawning
 * transcribe_hybrid.py.
 */
export async function transcribeWithGigaamServer(
  audioBuffer: Buffer,
  filename: string,
  language: string,
  abortSignal?: AbortSignal
): Promise<TranscriptionResult> {
  const baseUrl = config.TILTAB_GIGAAM_SERVER_URL;
  if (!baseUrl) {
    throw new Error("TILTAB_GIGAAM_SERVER_URL is not configured");
  }

  const originalExt = filename.includes(".") ? `.${filename.split(".").pop()}` : "";
  const safeExt = originalExt.replace(/[^a-zA-Z0-9.]/g, "").slice(0, 10);
  const tmpInput = join(tmpdir(), `tiltab_gigaam_${Date.now()}_${randomBytes(6).toString("hex")}${safeExt || ".tmp"}`);
  await writeFile(tmpInput, audioBuffer);

  const timeoutMs = config.TILTAB_GIGAAM_SERVER_TIMEOUT_MS;
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const onExternalAbort = () => timeoutController.abort();
  if (abortSignal) {
    if (abortSignal.aborted) timeoutController.abort();
    else abortSignal.addEventListener("abort", onExternalAbort);
  }

  try {
    const res = await fetch(new URL("/transcribe", baseUrl).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input_path: tmpInput, ffmpeg_path: FFMPEG_PATH, language }),
      signal: timeoutController.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GigaAM server returned ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = (await res.json()) as TranscriptionResult & { error?: string };
    if (data.error) {
      throw new Error(`GigaAM server error: ${data.error}`);
    }

    logger.info("GigaAM server response received", {
      language: data.language,
      textLength: data.text?.length,
      segmentCount: data.segments?.length,
      model: data.model,
    });

    return {
      text: data.text ?? "",
      language: data.language ?? language,
      segments: data.segments ?? [],
      provider: data.provider ?? "gigaam-server",
      model: data.model ?? "gigaam-multilingual-ctc",
    };
  } finally {
    clearTimeout(timer);
    if (abortSignal) abortSignal.removeEventListener("abort", onExternalAbort);
    await unlink(tmpInput).catch(() => {});
  }
}
