import { registerBotCommands } from "./services/telegramService";
import dns from "dns";

// Prefer IPv4 for every outgoing connection.
//
// Node resolves AAAA first by default, and this host has both. That cost us
// twice: YouTube demands sign-in far more readily from the Cloudflare WARP
// IPv6 ranges than from its IPv4 egress, and an operator API key issued
// against our IPv4 address is rejected as ip_not_allowed when the request
// leaves over IPv6. Both failures looked like "the instance is broken".
dns.setDefaultResultOrder("ipv4first");

import app from "./app";
import { config } from "./config";
import { logger } from "./utils/logger";
import { migrate, isDbHealthy } from "./db";
import { failOrphanedJobs } from "./db/repos/webJobRepo";
import { initPendingActions } from "./services/telegramService";
import { cleanupOldTempFiles } from "./utils/tempCleanup";
import { startCobaltHealthMonitor } from "./services/cobaltHealthService";
import { startFeedbackReminders } from "./services/feedbackReplyService";
import { purgeExpiredSessions } from "./services/adminAuthService";

const PORT = config.PORT;

async function start() {
  // Clean up orphaned temp files from previous runs before doing anything else.
  await cleanupOldTempFiles().catch((err) => {
    logger.warn("Temp cleanup failed during startup", { error: err instanceof Error ? err.message : String(err) });
  });

  try {
    const healthy = await isDbHealthy();
    if (!healthy) {
      logger.error("PostgreSQL is not reachable. Check DATABASE_URL.");
      process.exit(1);
    }
    await migrate();
    await initPendingActions();

    // Ни одно задание не переживает перезапуск: они живут в памяти процесса.
    // Оставлять их "выполняющимися" — врать и людям, и сводке.
    const orphaned = await failOrphanedJobs();
    if (orphaned > 0) {
      logger.warn("Брошенные задания помечены неудачными", { count: orphaned });
    }
  } catch (err) {
    logger.error("Failed to start server due to DB issue", { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
    process.exit(1);
  }

  // Слушаем только петлю: снаружи стоит nginx с шифрованием, и открытый порт
  // рядом с ним — это дверь мимо замка. Кто знал адрес с портом, ходил бы по
  // http как раньше, и HTTPS оставался бы украшением.
  //
  // Адрес можно переопределить через TILTAB_BIND_HOST — например, "0.0.0.0",
  // если сервис поднимают без прокси перед ним.
  const HOST = process.env.TILTAB_BIND_HOST || "127.0.0.1";

  app.listen(PORT, HOST, () => {
    logger.info(`🚀 TilTap backend running on ${HOST}:${PORT} in ${config.NODE_ENV} mode`);
    startCobaltHealthMonitor();
    // Список команд в меню бота — единственный способ найти /language
    // тому, кто не читает язык интерфейса.
    void registerBotCommands();
    startFeedbackReminders();
    // Expired sessions are already refused on use; this only keeps the
    // table from growing forever.
    void purgeExpiredSessions();
    setInterval(() => void purgeExpiredSessions(), 24 * 60 * 60 * 1000);
  });
}

start();
