import { logger } from "../utils/logger";
import { config } from "../config";
import { getEffectiveCobaltUrls, testCobaltApiUrl } from "./cobaltConfigService";
import { sendAdminAlert, resetAlertThrottle } from "./alertService";

const ALERT_KEY = "cobalt-all-down";

let monitorTimer: ReturnType<typeof setInterval> | null = null;
// Track state so we only alert on the healthy→down transition (and re-alert
// per the throttle while it stays down), and send a recovery notice on down→healthy.
let lastState: "healthy" | "down" | "unknown" = "unknown";

interface ProbeResult {
  url: string;
  ok: boolean;
  error?: string;
}

export interface CobaltHealthResult {
  healthy: boolean;
  workingUrl?: string;
  probes: ProbeResult[];
}

/**
 * Probe the effective Cobalt instances in order and stop at the first one that
 * can resolve the test video. Healthy means at least one instance works.
 */
export async function checkCobaltHealth(): Promise<CobaltHealthResult> {
  const urls = getEffectiveCobaltUrls();
  const probes: ProbeResult[] = [];

  for (const url of urls) {
    const result = await testCobaltApiUrl(url, config.COBALT_HEALTHCHECK_URL);
    probes.push({ url, ok: result.ok, error: result.error });
    if (result.ok) {
      return { healthy: true, workingUrl: url, probes };
    }
  }

  return { healthy: false, probes };
}

function buildDownMessage(probes: ProbeResult[]): string {
  const details = probes.map((p) => `• ${p.url} — ${p.error ?? "fail"}`).join("\n");
  return (
    "🔴 <b>Cobalt: все инстансы недоступны</b>\n\n" +
    "Скачивание видео (YouTube / TikTok / Instagram) сейчас не работает — " +
    "yt-dlp удалён, Cobalt единственный путь.\n\n" +
    "Проверено:\n" +
    details +
    "\n\n<b>Что сделать:</b>\n" +
    "1. Найти рабочий публичный инстанс: https://instances.cobalt.best\n" +
    "2. Добавить его в админке (Beta-test → Cobalt manager) или в .env " +
    "COBALT_API_URLS через запятую и перезапустить бэкенд.\n" +
    "3. Проверить кнопкой Test в админке."
  );
}

async function runCheck(): Promise<void> {
  let result: CobaltHealthResult;
  try {
    result = await checkCobaltHealth();
  } catch (err) {
    logger.error("Cobalt health check crashed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (result.healthy) {
    if (lastState === "down") {
      logger.info("Cobalt recovered", { workingUrl: result.workingUrl });
      // Bypass the throttle so the recovery notice is not suppressed by the
      // down-alert that was just sent.
      resetAlertThrottle(ALERT_KEY);
      await sendAdminAlert(
        `${ALERT_KEY}-recovery`,
        `🟢 <b>Cobalt снова работает</b>\n\nРабочий инстанс: ${result.workingUrl}\nСкачивание видео восстановлено.`,
        0
      );
    }
    lastState = "healthy";
    return;
  }

  logger.warn("Cobalt health check: all instances down", {
    probes: result.probes,
  });
  await sendAdminAlert(ALERT_KEY, buildDownMessage(result.probes), config.COBALT_ALERT_THROTTLE_HOURS);
  lastState = "down";
}

/**
 * Start the periodic Cobalt health monitor. First run is delayed so it does not
 * fire during startup boot; then it repeats on the configured interval.
 */
export function startCobaltHealthMonitor(): void {
  if (!config.COBALT_HEALTHCHECK_ENABLED) {
    logger.info("Cobalt health monitor disabled (COBALT_HEALTHCHECK_ENABLED=false)");
    return;
  }
  if (monitorTimer) return;

  const intervalMs = Math.max(5, config.COBALT_HEALTHCHECK_INTERVAL_MINUTES) * 60_000;

  setTimeout(() => {
    void runCheck();
    monitorTimer = setInterval(() => void runCheck(), intervalMs);
  }, 30_000);

  logger.info("Cobalt health monitor started", {
    intervalMinutes: config.COBALT_HEALTHCHECK_INTERVAL_MINUTES,
    throttleHours: config.COBALT_ALERT_THROTTLE_HOURS,
    adminChatConfigured: Boolean(config.TILTAB_ADMIN_CHAT_ID),
  });
}

export function stopCobaltHealthMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}
