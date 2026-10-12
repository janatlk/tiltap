import { logger } from "../utils/logger";
import { config } from "../config";
import { sendAdminAlert, resetAlertThrottle } from "./alertService";
import { checkYoutubeCookies } from "./youtubeService";

/**
 * Раз в сутки проверяет, живы ли cookies YouTube, и зовёт админа, пока не поздно.
 *
 * Cookies протухают примерно за месяц: Google меняет сессию, а у нас лежит
 * снимок. Раньше об этом узнавали по волне отказов у пользователей, да и общая
 * тревога "YouTube не отдаёт медиа" не говорила почему. Эта проверка называет
 * причину и приходит раньше, чем первый пользователь увидит ошибку.
 */

const ALERT_KEY = "youtube-cookies-invalid";
const DAY_MS = 24 * 60 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let lastStatus: "valid" | "invalid" | "unknown" | null = null;

async function runCheck(): Promise<void> {
  const { status, detail } = await checkYoutubeCookies(config.COBALT_HEALTHCHECK_URL);
  logger.info("YouTube cookies check", { status, detail });

  if (status === "invalid") {
    await sendAdminAlert(
      ALERT_KEY,
      "🍪 <b>Cookies YouTube больше не действуют</b>\n\n" +
        "Пока их не обновить, ролики с YouTube скачиваться не будут.\n\n" +
        "Выгрузите свежие cookies отдельного аккаунта из приватного окна и замените " +
        "<code>data/youtube_cookies.txt</code>.",
      20,
    );
  } else if (status === "valid" && lastStatus === "invalid") {
    resetAlertThrottle(ALERT_KEY);
    await sendAdminAlert(ALERT_KEY, "✅ Cookies YouTube снова действуют.", 0);
  }
  // "unknown" (сеть, таймаут, ролик недоступен) ничего не говорит о cookies —
  // молчим и не сбиваем прошлое состояние.
  if (status !== "unknown") lastStatus = status;
}

export function startYoutubeCookiesMonitor(): void {
  if (!config.COBALT_HEALTHCHECK_ENABLED || timer) return;
  // Первая проверка через несколько минут после старта, чтобы не мешать загрузке.
  setTimeout(() => {
    void runCheck();
    timer = setInterval(() => void runCheck(), DAY_MS);
  }, 5 * 60_000);
  logger.info("YouTube cookies monitor started");
}
