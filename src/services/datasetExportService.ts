import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { logger } from "../utils/logger";
import { listApprovedSegments } from "../db/repos/datasetRepo";
import { datasetRoot, resolveInsideDataset } from "./datasetPipeline";

/**
 * Export the approved corpus.
 *
 * Two manifests describe the same files, because the two tools that will read
 * them disagree about format and neither conversion is worth doing by hand:
 * NeMo (what GigaAM trains under) wants JSON lines with absolute-ish paths,
 * HuggingFace datasets wants a CSV keyed by file name.
 */

export interface ExportSummary {
  clips: number;
  totalSeconds: number;
  archivePath: string | null;
  archiveBytes: number | null;
  builtAt: string;
}

function exportDir(): string {
  return path.join(datasetRoot(), "export");
}

function csvEscape(value: string): string {
  // A transcript can hold a comma or a quote; unescaped, either one silently
  // shifts every following column.
  return `"${value.replace(/"/g, '""')}"`;
}

/** Write manifest.jsonl and metadata.csv next to a clips/ directory. */
async function writeManifests(
  targetDir: string,
  rows: { clipFile: string; duration: number; text: string; language: string }[]
): Promise<void> {
  const manifest = rows
    .map((row) =>
      JSON.stringify({
        audio_filepath: `clips/${row.clipFile}`,
        duration: Number(row.duration.toFixed(3)),
        text: row.text,
        lang: row.language,
      })
    )
    .join("\n");
  await fs.writeFile(path.join(targetDir, "manifest.jsonl"), manifest + "\n", "utf-8");

  const csv = [
    "file_name,transcription,duration,lang",
    ...rows.map((row) =>
      [
        csvEscape(`clips/${row.clipFile}`),
        csvEscape(row.text),
        row.duration.toFixed(3),
        csvEscape(row.language),
      ].join(",")
    ),
  ].join("\n");
  await fs.writeFile(path.join(targetDir, "metadata.csv"), csv + "\n", "utf-8");
}

/** The manifests alone, for a quick look without moving gigabytes. */
export async function buildManifestsOnly(): Promise<{ dir: string; clips: number }> {
  const rows = await collectRows();
  const dir = exportDir();
  await fs.mkdir(dir, { recursive: true });
  await writeManifests(dir, rows);
  return { dir, clips: rows.length };
}

async function collectRows() {
  const segments = await listApprovedSegments();
  return segments.map((segment) => ({
    clipFile: path.basename(segment.audio_path),
    sourcePath: segment.audio_path,
    duration: Number(segment.duration_sec),
    text: segment.text.trim(),
    language: segment.language,
  }));
}

/**
 * Assemble the full dataset and tar it.
 *
 * Clips are hard-linked rather than copied: they sit on the same filesystem, so
 * the staging tree costs no extra disk and no copy time, which matters once the
 * corpus is measured in gigabytes.
 */
export async function buildArchive(): Promise<ExportSummary> {
  const rows = await collectRows();
  const root = exportDir();
  const staging = path.join(root, "tiltap_dataset");
  const clipsDir = path.join(staging, "clips");

  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(clipsDir, { recursive: true });

  let linked = 0;
  for (const row of rows) {
    const source = resolveInsideDataset(row.sourcePath);
    if (!source) continue;
    const target = path.join(clipsDir, row.clipFile);
    try {
      await fs.link(source, target);
      linked += 1;
    } catch {
      // Different device, or the clip vanished: fall back to a copy, and skip
      // it entirely if even that fails rather than shipping a broken manifest.
      try {
        await fs.copyFile(source, target);
        linked += 1;
      } catch (err) {
        logger.warn("Dataset export skipped a clip", {
          clip: row.clipFile,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const present = new Set(await fs.readdir(clipsDir));
  const usableRows = rows.filter((row) => present.has(row.clipFile));
  await writeManifests(staging, usableRows);
  await fs.writeFile(
    path.join(staging, "README.txt"),
    [
      "TilTap annotation corpus",
      "",
      `Клипов: ${usableRows.length}`,
      `Общая длительность: ${formatDuration(usableRows.reduce((sum, r) => sum + r.duration, 0))}`,
      "",
      "clips/          — аудио 16 кГц моно 16 бит PCM",
      "manifest.jsonl  — формат NeMo (audio_filepath, duration, text, lang)",
      "metadata.csv    — формат HuggingFace datasets (file_name, transcription)",
      "",
      "Тексты вычитаны лингвистами. В выгрузку попадают только подтверждённые фрагменты.",
    ].join("\n"),
    "utf-8"
  );

  const archivePath = path.join(root, "tiltap_dataset.tar.gz");
  await tarball(root, "tiltap_dataset", archivePath);
  await fs.rm(staging, { recursive: true, force: true });

  const stat = await fs.stat(archivePath);
  logger.info("Dataset archive built", { clips: linked, bytes: stat.size });

  return {
    clips: usableRows.length,
    totalSeconds: usableRows.reduce((sum, r) => sum + r.duration, 0),
    archivePath,
    archiveBytes: stat.size,
    builtAt: new Date().toISOString(),
  };
}

function tarball(cwd: string, folder: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("tar", ["-czf", outputPath, "-C", cwd, folder]);
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf-8");
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar failed (${code}): ${stderr.slice(0, 300)}`));
    });
  });
}

export async function existingArchive(): Promise<{ path: string; bytes: number; builtAt: string } | null> {
  const archivePath = path.join(exportDir(), "tiltap_dataset.tar.gz");
  try {
    const stat = await fs.stat(archivePath);
    return { path: archivePath, bytes: stat.size, builtAt: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h} ч ${m} мин` : m > 0 ? `${m} мин ${s} с` : `${s} с`;
}
