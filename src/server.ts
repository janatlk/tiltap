import app from "./app";
import { config } from "./config";
import { logger } from "./utils/logger";
import { migrate, isDbHealthy } from "./db";

const PORT = config.PORT;

async function start() {
  try {
    const healthy = await isDbHealthy();
    if (!healthy) {
      logger.error("PostgreSQL is not reachable. Check DATABASE_URL.");
      process.exit(1);
    }
    await migrate();
  } catch (err) {
    logger.error("Failed to start server due to DB issue", { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
    process.exit(1);
  }

  app.listen(PORT, () => {
    logger.info(`🚀 TilTap backend running on port ${PORT} in ${config.NODE_ENV} mode`);
  });
}

start();
