import app from "./app";
import { config } from "./config";
import { logger } from "./utils/logger";
import { migrate, isDbHealthy } from "./db";
import { initPendingActions } from "./services/telegramService";
import { cleanupOldTempFiles } from "./utils/tempCleanup";

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
  });
}

start();
