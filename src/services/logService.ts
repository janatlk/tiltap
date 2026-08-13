import { spawn } from "child_process";
import { logger } from "../utils/logger";

/**
 * Последние записи журнала для админки.
 *
 * Читаем journalctl вместо файла: логи пишутся туда, и ротацию за нас делает
 * systemd. Вывод ограничен по количеству строк и по времени ожидания — админка
 * не должна уметь заказать себе весь журнал за месяц и подвесить бэкенд.
 */

const SERVICES = ["tiltab-backend", "tiltab-telegram-poll", "tiltab-gigaam"] as const;
export type LogService = (typeof SERVICES)[number];

const MAX_LINES = 1000;
const TIMEOUT_MS = 15_000;

export function isKnownService(name: string): name is LogService {
  return (SERVICES as readonly string[]).includes(name);
}

export function availableServices(): readonly string[] {
  return SERVICES;
}

export interface LogEntry {
  time: string;
  level: string;
  message: string;
  raw: string;
}

function parseLine(line: string): LogEntry {
  // Бэкенд пишет structured JSON, systemd — обычный текст. Разбираем первое,
  // второе показываем как есть: наполовину разобранный лог хуже неразобранного.
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (typeof parsed.message === "string") {
      const extras = Object.entries(parsed)
        .filter(([k]) => !["message", "level", "timestamp", "service"].includes(k))
        .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
        .join(" ");
      return {
        time: String(parsed.timestamp ?? ""),
        level: String(parsed.level ?? "info"),
        message: extras ? `${parsed.message} · ${extras}` : String(parsed.message),
        raw: line,
      };
    }
  } catch {
    // не JSON — ниже
  }
  return { time: "", level: "", message: line, raw: line };
}

export async function readLogs(options: {
  service: LogService;
  lines: number;
  level?: "error" | "warn" | "all";
  search?: string;
}): Promise<LogEntry[]> {
  const lines = Math.min(MAX_LINES, Math.max(10, options.lines || 200));
  const args = ["-u", options.service, "-n", String(lines), "--no-pager", "-o", "cat"];

  const raw = await new Promise<string>((resolve, reject) => {
    const proc = spawn("journalctl", args);
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("journalctl не ответил вовремя"));
    }, TIMEOUT_MS);

    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out) {
        reject(new Error(err.trim() || `journalctl завершился с кодом ${code}`));
        return;
      }
      resolve(out);
    });
  });

  let entries = raw
    .split("\n")
    .filter((l) => l.trim())
    .map(parseLine);

  if (options.level === "error") {
    entries = entries.filter((e) => e.level === "error");
  } else if (options.level === "warn") {
    entries = entries.filter((e) => e.level === "error" || e.level === "warn");
  }

  if (options.search) {
    const needle = options.search.toLowerCase();
    entries = entries.filter((e) => e.raw.toLowerCase().includes(needle));
  }

  logger.debug("Logs read for admin", { service: options.service, returned: entries.length });
  return entries.reverse();
}
