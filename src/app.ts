import express, { Request, Response, NextFunction } from "express";
import path from "path";
import swaggerUi from "swagger-ui-express";
import YAML from "yamljs";
import { logger } from "./utils/logger";
import { requestLogger } from "./middleware/requestLogger";
import webhookRoutes from "./routes/webhook";
import translateRoutes from "./routes/translate";
import { isDbHealthy } from "./db";

const app = express();

app.use(express.json());
app.use(requestLogger);

// Swagger docs
const swaggerDocument = YAML.load(path.join(process.cwd(), "swagger.yaml"));
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Health check
app.get("/health", async (_req, res) => {
  const dbHealthy = await isDbHealthy();
  res.status(dbHealthy ? 200 : 503).json({
    status: dbHealthy ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    database: dbHealthy ? "connected" : "disconnected",
  });
});

// Routes
app.use("/webhook", webhookRoutes);
app.use("/api/translate", translateRoutes);

// 404
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// Global error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error("Unhandled error", { error: err.message, stack: err.stack });
  res.status(500).json({ error: "Internal server error" });
});

export default app;
