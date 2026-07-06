import express, { Request, Response, NextFunction } from "express";
import path from "path";
import swaggerUi from "swagger-ui-express";
import YAML from "yamljs";
import { logger } from "./utils/logger";
import { requestLogger } from "./middleware/requestLogger";
import webhookRoutes from "./routes/webhook";
import translateRoutes from "./routes/translate";
import webRoutes from "./routes/web";
import adminRoutes from "./routes/admin";
import betaTestRoutes from "./routes/betaTest";
import { getProvidersHealth } from "./controllers/providersController";
import { isDbHealthy } from "./db";
import { config } from "./config";

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
    sttProvider: config.TILTAB_STT_PROVIDER,
    remoteSttConfigured: Boolean(config.TILTAB_STT_SERVICE_URL),
    openaiConfigured: Boolean(config.OPENAI_API_KEY),
    groqConfigured: Boolean(config.GROQ_API_KEY),
    elevenlabsConfigured: Boolean(config.ELEVENLABS_API_KEY),
  });
});

// Provider health & billing snapshot
app.get("/health/providers", getProvidersHealth);

// Static web UI. The admin HTML shell is public so the token never has to
// appear in a URL; all admin API endpoints require the token via the
// X-Admin-Token header and the UI prompts for it.
app.use("/web", express.static(path.join(process.cwd(), "public/web")));
app.use(express.static(path.join(process.cwd(), "public")));

// Routes
app.use("/webhook", webhookRoutes);
app.use("/api/translate", translateRoutes);
app.use("/api/web", webRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin/beta", betaTestRoutes);

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
