import { spawn } from "child_process";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { logger } from "../utils/logger";
import { config } from "../config";
import { translateText } from "./translationService";

/**
 * Перевод документов.
 *
 * Текст извлекается питоновским скриптом, переводится и — для форматов, где
 * структура значит не меньше слов, — собирается обратно в тот же формат.
 * Отдавать таблицу или субтитры простым текстом бессмысленно: пропадает ровно
 * то, ради чего файл и присылали.
 */

const PYTHON = process.platform === "win32" ? "python" : "python3";
const EXTRACTOR = join(process.cwd(), "scripts", "extract_document.py");
const EXTRACT_TIMEOUT_MS = 120_000;

/** Маркер между единицами перевода. Модель не должна принять его за текст. */
const UNIT_SEPARATOR = "\n@@@---@@@\n";
/** Сколько единиц отправлять за раз: пачка целиком уходит одним запросом. */
const UNITS_PER_BATCH = 40;

export const SUPPORTED_DOCUMENT_EXTENSIONS = [
  "txt", "md", "csv", "tsv", "srt", "vtt",
  "docx", "pptx", "xlsx", "odt", "pdf", "rtf", "html", "htm",
  "json", "xml", "yml", "yaml", "log",
] as const;

/** Форматы, которые возвращаются в своём виде, а не простым текстом. */
export const STRUCTURE_PRESERVED = ["csv", "tsv", "srt", "vtt"] as const;

export function isSupportedDocument(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return (SUPPORTED_DOCUMENT_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * Оценка в токенах. Для кириллицы это примерно два символа на токен; считаем
 * с запасом в свою сторону, чтобы ограничение не оказалось мягче обещанного.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 2);
}

interface ExtractResult {
  format: string;
  structured?: boolean;
  units?: string[];
  meta?: Record<string, unknown>;
  chars?: number;
  warning?: string;
  error?: string;
}

async function runExtractor(path: string, filename: string): Promise<ExtractResult> {
  return await new Promise<ExtractResult>((resolve, reject) => {
    const proc = spawn(PYTHON, [EXTRACTOR, path, "--filename", filename]);
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("Чтение файла заняло слишком долго"));
    }, EXTRACT_TIMEOUT_MS);

    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out) as ExtractResult);
      } catch {
        reject(new Error(err.trim().slice(0, 300) || "Не удалось разобрать файл"));
      }
    });
  });
}

/**
 * Переводит пачку коротких единиц одним запросом.
 *
 * Единицы склеиваются маркером и разделяются обратно. Если модель потеряла или
 * добавила маркер, счёт не сойдётся — тогда переводим по одной. Медленнее, зато
 * ячейки не разъедутся по соседним столбцам, что молча испортило бы таблицу.
 */
async function translateUnits(
  units: string[],
  sourceLang: string | undefined,
  targetLang: string,
  onProgress?: (fraction: number) => void
): Promise<{ translated: string[]; costUsd: number }> {
  const translated: string[] = [];
  let costUsd = 0;

  // Считаем в символах, а не в единицах: неструктурированный файл приходит
  // одной единицей на весь текст, и по единицам прогресс был бы 0 или 100.
  // Внутри перевода он режется на куски, и вот они дают настоящее движение.
  const totalChars = units.reduce((sum, u) => sum + u.length, 0) || 1;
  let charsDone = 0;

  for (let i = 0; i < units.length; i += UNITS_PER_BATCH) {
    const batch = units.slice(i, i + UNITS_PER_BATCH);
    const joined = batch.join(UNIT_SEPARATOR);
    const batchChars = batch.reduce((sum, u) => sum + u.length, 0);
    const result = await translateText({
      text: joined,
      sourceLang,
      targetLang,
      onChunk: (done, total) => {
        onProgress?.((charsDone + (batchChars * done) / total) / totalChars);
      },
    });
    charsDone += batchChars;
    costUsd += result.costUsd ?? 0;

    const parts = result.translatedText.split(/\n?@@@-*@@@\n?/);
    if (parts.length === batch.length) {
      translated.push(...parts.map((p) => p.trim()));
    } else {
      logger.warn("Batch translation lost its separators; falling back to one-by-one", {
        expected: batch.length,
        got: parts.length,
      });
      for (const unit of batch) {
        const single = await translateText({ text: unit, sourceLang, targetLang });
        costUsd += single.costUsd ?? 0;
        translated.push(single.translatedText.trim());
      }
    }

    onProgress?.(charsDone / totalChars);
  }

  return { translated, costUsd };
}

function rebuildCsv(meta: Record<string, unknown>, translated: string[]): string {
  const rows = (meta.rows as string[][]).map((r) => [...r]);
  const positions = meta.positions as number[][];
  const delimiter = (meta.delimiter as string) || ",";

  positions.forEach(([r, c], index) => {
    if (rows[r] && translated[index] !== undefined) rows[r][c] = translated[index];
  });

  return rows
    .map((row) =>
      row
        .map((cell) => (/[",\n\t]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
        .join(delimiter)
    )
    .join("\n");
}

function rebuildSubtitles(meta: Record<string, unknown>, translated: string[]): string {
  const blocks = meta.blocks as Array<{ head: string[]; has_body: boolean }>;
  const out: string[] = [];
  let index = 0;
  for (const block of blocks) {
    const lines = [...block.head];
    if (block.has_body) {
      lines.push(translated[index] ?? "");
      index += 1;
    }
    out.push(lines.join("\n"));
  }
  const body = out.join("\n\n");
  return meta.kind === "vtt" && !body.startsWith("WEBVTT") ? `WEBVTT\n\n${body}` : body;
}

export interface DocumentTranslation {
  text: string;
  format: string;
  structured: boolean;
  outputFilename: string;
  chars: number;
  costUsd: number;
  warning?: string;
}

export async function translateDocument(options: {
  buffer: Buffer;
  filename: string;
  sourceLang?: string;
  targetLang: string;
  /**
   * fraction — доля переведённого от 0 до 1, если она уже известна. На чтении
   * файла её нет: сколько там окажется текста, до разбора не знает никто.
   */
  onProgress?: (label: string, fraction?: number) => void;
}): Promise<DocumentTranslation> {
  const suffix = options.filename.includes(".") ? `.${options.filename.split(".").pop()}` : "";
  const tmpPath = join(tmpdir(), `tiltab_doc_${Date.now()}_${randomBytes(6).toString("hex")}${suffix}`);
  await writeFile(tmpPath, options.buffer);

  try {
    options.onProgress?.("Читаю файл...");
    const extracted = await runExtractor(tmpPath, options.filename);

    if (extracted.error) throw new Error(extracted.error);

    const units = extracted.units ?? [];
    const chars = extracted.chars ?? 0;
    if (chars === 0) {
      throw new Error(extracted.warning || "В файле не нашлось текста для перевода");
    }

    const tokens = estimateTokens(chars);
    if (tokens > config.TILTAB_MAX_DOCUMENT_TOKENS) {
      throw new Error(
        `Файл слишком большой: примерно ${tokens.toLocaleString("ru")} токенов, ` +
          `допустимо ${config.TILTAB_MAX_DOCUMENT_TOKENS.toLocaleString("ru")}. ` +
          `Разделите документ на части.`
      );
    }

    // Документ переводится пачками, поэтому доля готового известна честно.
    // Раньше сюда уходила одна строка на весь перевод, и полоса стояла на
    // месте до самого конца — на длинном файле это выглядит как зависание.
    options.onProgress?.(`Перевожу (${chars.toLocaleString("ru")} символов)...`, 0);
    const { translated, costUsd } = await translateUnits(
      units,
      options.sourceLang,
      options.targetLang,
      (fraction) => {
        const percent = Math.min(99, Math.round(fraction * 100));
        options.onProgress?.(`Перевожу (${percent}% из ${chars.toLocaleString("ru")} символов)...`, fraction);
      }
    );

    const structured = extracted.structured === true;
    let text: string;
    if (structured && (extracted.format === "csv" || extracted.format === "tsv")) {
      text = rebuildCsv(extracted.meta ?? {}, translated);
    } else if (structured) {
      text = rebuildSubtitles(extracted.meta ?? {}, translated);
    } else {
      text = translated.join("\n\n");
    }

    const base = options.filename.replace(/\.[^.]+$/, "");
    const outputExt = structured ? extracted.format : "txt";

    logger.info("Document translated", {
      format: extracted.format,
      chars,
      tokens,
      structured,
      costUsd,
    });

    return {
      text,
      format: extracted.format,
      structured,
      outputFilename: `${base}_${options.targetLang}.${outputExt}`,
      chars,
      costUsd,
      warning: extracted.warning,
    };
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}
