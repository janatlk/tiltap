import { logger } from "../utils/logger";
import { config } from "../config";
import { getEffectiveCobaltUrls, testCobaltApiUrl, recordCobaltProbe } from "./cobaltConfigService";
import { sendAdminAlert, resetAlertThrottle } from "./alertService";
import { probeYtdlp } from "./youtubeService";

const ALERT_KEY = "cobalt-all-down";

/** Пауза перед повторной проверкой, когда первый обход не нашёл живых. */
const RECHECK_DELAY_MS = 60000;

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
  /** True when at least one engine can still deliver media. */
  healthy: boolean;
  workingUrl?: string;
  probes: ProbeResult[];
  /** The yt-dlp fallback, probed only when every Cobalt instance failed. */
  fallback?: ProbeResult;
}

/**
 * Probe every configured engine and report whether downloads still work at all.
 *
 * Every Cobalt instance is checked, not just up to the first success: a partial
 * outage is worth having in the log (and in the alert, when one eventually
 * fires) even though it is not itself alert-worthy. The yt-dlp fallback is
 * probed only when all of Cobalt is down, because that probe is expensive —
 * it solves JS challenges and can take minutes.
 *
 * Healthy therefore means "a link would still download", which is the only
 * condition worth waking someone up for.
 */
export async function checkCobaltHealth(): Promise<CobaltHealthResult> {
  const urls = getEffectiveCobaltUrls();
  const probes: ProbeResult[] = [];
  let workingUrl: string | undefined;

  for (const url of urls) {
    // Вторая попытка перед приговором. Наш инстанс отвечает то за 10 секунд,
    // то за минуту, и один и тот же запрос к нему то проходит, то падает.
    // Одиночная проба на таком инстансе — это подбрасывание монеты, и она уже
    // объявляла "ни один движок не отдаёт медиа" в момент, когда скачивание
    // работало.
    let result = await testCobaltApiUrl(url, config.COBALT_HEALTHCHECK_URL);
    if (!result.ok) {
      result = await testCobaltApiUrl(url, config.COBALT_HEALTHCHECK_URL);
    }
    recordCobaltProbe(url, result.ok);
    probes.push({ url, ok: result.ok, error: result.error });
    if (result.ok && !workingUrl) workingUrl = url;
  }

  if (workingUrl) return { healthy: true, workingUrl, probes };

  const ytdlp = await probeYtdlp(config.COBALT_HEALTHCHECK_URL);
  const fallback: ProbeResult = { url: "yt-dlp (fallback)", ok: ytdlp.ok, error: ytdlp.detail };
  return { healthy: ytdlp.ok, probes, fallback };
}

function buildDownMessage(result: CobaltHealthResult): string {
  const details = result.probes.map((p) => `• ${p.url} — ${p.error ?? "fail"}`).join("\n");
  const fallback = result.fallback
    ? `\n• ${result.fallback.url} — ${result.fallback.error ?? "fail"}`
    : "";
  return (
    // Раньше сообщение перечисляло все площадки, хотя проверка трогает только
    // ролик с YouTube. Именно YouTube и режет чаще всего — по общему для
    // многих адресу WARP, — а Facebook и TikTok в это же время скачиваются.
    // Обещать полную остановку, когда встала одна площадка, значит приучить
    // читать эти сообщения по диагонали.
    "🔴 <b>YouTube не отдаёт медиа</b>\n\n" +
    "Ни один движок не смог скачать проверочный ролик с YouTube. Ссылки с " +
    "других площадок (TikTok, Instagram, Facebook) при этом могут работать.\n\n" +
    "Проверено:\n" +
    details +
    fallback +
    "\n\n<b>Что сделать:</b>\n" +
    "1. Чаще всего проходит само за полчаса: наш инстанс выходит через общий " +
    "адрес WARP, и YouTube временами придерживает его. Пустой туннель " +
    "(<code>tunnel returned no data</code>) — это именно тот случай.\n" +
    "2. Если не проходит: обновить куки YouTube — свежий экспорт в " +
    "<code>data/youtube_cookies.txt</code>, затем " +
    "<code>python3 scripts/cookies_to_cobalt.py</code> и перезапуск " +
    "<code>cobalt2_api</code>.\n" +
    "3. Запасной вариант — рабочий публичный инстанс: https://instances.cobalt.best, " +
    "добавить в админке (Beta-test → Cobalt manager) и проверить кнопкой Test."
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

  const failed = result.probes.filter((p) => !p.ok);
  if (failed.length > 0) {
    // Not alert-worthy on its own — downloads still work — but it is the early
    // warning that shows up in the log before everything goes.
    logger.warn("Cobalt: some instances failing", {
      failed: failed.map((p) => `${p.url}: ${p.error ?? "fail"}`),
      total: result.probes.length,
    });
  }

  if (result.healthy) {
    if (lastState === "down") {
      logger.info("Downloads recovered", {
        via: result.workingUrl ?? "yt-dlp fallback",
      });
      // Bypass the throttle so the recovery notice is not suppressed by the
      // down-alert that was just sent.
      resetAlertThrottle(ALERT_KEY);
      await sendAdminAlert(
        `${ALERT_KEY}-recovery`,
        `🟢 <b>Скачивание снова работает</b>\n\nЧерез: ${result.workingUrl ?? "yt-dlp (запасной движок)"}`,
        0
      );
    }
    lastState = "healthy";
    return;
  }

  // Перед тем как поднимать тревогу, проверяем ещё раз через минуту.
  //
  // "Ни один движок не отдаёт медиа" — сообщение, ради которого человек бросает
  // дела. Оно уже приходило в минуту, когда скачивание работало: инстансы
  // отвечают неровно, и полный обход может не застать ни одного живого.
  // Минута задержки ничего не стоит на фоне получасового круга, а цена ложной
  // тревоги — доверие ко всем следующим.
  logger.warn("All download engines look down; re-checking before alerting", {
    probes: result.probes,
    fallback: result.fallback,
  });
  await new Promise((resolve) => setTimeout(resolve, RECHECK_DELAY_MS));

  let confirmation: CobaltHealthResult;
  try {
    confirmation = await checkCobaltHealth();
  } catch (err) {
    logger.error("Cobalt re-check crashed", { error: err instanceof Error ? err.message : String(err) });
    confirmation = result;
  }

  if (confirmation.healthy) {
    logger.info("Download engines answered on re-check; no alert sent", {
      via: confirmation.workingUrl ?? "yt-dlp fallback",
    });
    lastState = "healthy";
    return;
  }

  logger.error("All download engines down", {
    probes: confirmation.probes,
    fallback: confirmation.fallback,
  });
  await sendAdminAlert(ALERT_KEY, buildDownMessage(confirmation), config.COBALT_ALERT_THROTTLE_HOURS);
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
