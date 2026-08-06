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
  } catch (err) {
    logger.error("Failed to start server due to DB issue", { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
    process.exit(1);
  }

  app.listen(PORT, () => {
    logger.info(`🚀 TilTap backend running on port ${PORT} in ${config.NODE_ENV} mode`);
    startCobaltHealthMonitor();
    startFeedbackReminders();
    // Expired sessions are already refused on use; this only keeps the
    // table from growing forever.
    void purgeExpiredSessions();
    setInterval(() => void purgeExpiredSessions(), 24 * 60 * 60 * 1000);
  });
}

start();
