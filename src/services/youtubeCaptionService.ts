import { spawn } from "child_process";
import { logger } from "../utils/logger";
import { readFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const FFMPEG_PATH = require("ffmpeg-static");
const PYTHON_PATH = process.platform === "win32" ? "python" : "python3";

/**
 * Extract the best available caption/subtitle text from a YouTube video using yt-dlp.
 * Tries the requested language first, then falls back to en/ru/auto-generated captions.
 */
export async function extractYouTubeCaptions(
  url: string,
  preferredLang?: string
): Promise<string | null> {
  const tmpBase = join(tmpdir(), `tiltab_captions_${Date.now()}`);
  const langList = preferredLang ? `${preferredLang},ru,en` : "ru,en";

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(PYTHON_PATH, [
        "-m",
        "yt_dlp",
        "--ffmpeg-location",
        FFMPEG_PATH,
        "--skip-download",
        "--write-auto-subs",
        "--sub-langs",
        langList,
        "--convert-subs",
        "srt",
        "-o",
        `${tmpBase}.%(ext)s`,
        url,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });

      let stderr = "";
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });
      proc.on("close", (code: number) => {
        if (code !== 0) {
          logger.warn("yt-dlp caption extraction failed", { code, stderr: stderr.slice(0, 500) });
          // We still try to read any partial output
          resolve();
        } else {
          resolve();
        }
      });
      proc.on("error", (err: Error) => {
        logger.warn("yt-dlp caption process error", { error: err.message });
        resolve();
      });
    });

    // Find the generated subtitle file
    const fs = await import("fs/promises");
    const files = await fs.readdir(tmpdir());
    const subFile = files
      .filter((f) => f.startsWith(`tiltab_captions_${tmpBase.split("_").pop()}`) && f.endsWith(".srt"))
      .sort()
      .pop();

    if (!subFile) return null;

    const content = await readFile(join(tmpdir(), subFile), "utf-8");
    await unlink(join(tmpdir(), subFile)).catch(() => {});

    return parseSrtText(content);
  } catch (err) {
    logger.error("Failed to extract YouTube captions", { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
    return null;
  }
}

function parseSrtText(srt: string): string {
  return srt
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.split("\n").filter((l) => l.trim() !== "");
      // Skip first line (index) and second line (timecode)
      return lines.slice(2).join(" ");
    })
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
