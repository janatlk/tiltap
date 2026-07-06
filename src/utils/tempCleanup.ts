import { tmpdir } from "os";
import { readdir, unlink, stat } from "fs/promises";
import { join } from "path";
import { logger } from "./logger";

const TEMP_FILE_PREFIXES = ["tiltab_", "tiltab_yt_", "tiltab_test_"];
const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Remove orphaned temporary files created by the STT pipeline, YouTube
 * downloader, and test runner. This runs once at startup so crashes/SIGKILL
 * from previous runs don't leave garbage in /tmp forever.
 */
export async function cleanupOldTempFiles(): Promise<void> {
  const tmpDir = tmpdir();
  try {
    const entries = await readdir(tmpDir);
    const now = Date.now();
    let removed = 0;
    let errors = 0;

    for (const name of entries) {
      const matches = TEMP_FILE_PREFIXES.some((prefix) => name.startsWith(prefix));
      if (!matches) continue;

      const fullPath = join(tmpDir, name);
      try {
        const info = await stat(fullPath);
        if (!info.isFile()) continue;
        if (now - info.mtime.getTime() > MAX_AGE_MS) {
          await unlink(fullPath);
          removed += 1;
        }
      } catch (err) {
        errors += 1;
        logger.debug("Failed to stat/unlink temp file", { path: fullPath, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (removed > 0 || errors > 0) {
      logger.info("Temporary file cleanup completed", { removed, errors, tmpDir });
    }
  } catch (err) {
    logger.warn("Failed to read temp directory for cleanup", { tmpDir, error: err instanceof Error ? err.message : String(err) });
  }
}
