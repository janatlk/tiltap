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
import { requireAdmin } from "./middleware/requireAdmin";
import { login, logout, session } from "./services/adminAuthService";
import betaTestRoutes from "./routes/betaTest";
import datasetRoutes from "./routes/dataset";
import {
  adminListAnnotators,
  adminCreateAnnotator,
  adminSetAnnotatorPassword,
  adminSetAnnotatorActive,
} from "./controllers/datasetController";
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
// Annotation workspace. Its own logins, deliberately not the admin password:
// a linguist needs to fix transcripts, not to read the request log.
app.use("/api/dataset", datasetRoutes);
// Login endpoints sit in front of the gate, or nobody could ever log in.
app.post("/api/admin/login", login);
app.post("/api/admin/logout", logout);
app.get("/api/admin/session", session);

// Everything else under /api/admin requires a session or a machine token.
app.use("/api/admin", requireAdmin);
app.use("/api/admin", adminRoutes);
app.use("/api/admin/beta", betaTestRoutes);

// Creating and disabling linguist accounts belongs to the site admin, not to
// the linguists themselves — so it lives behind requireAdmin, above.
app.get("/api/admin/dataset/annotators", adminListAnnotators);
app.post("/api/admin/dataset/annotators", adminCreateAnnotator);
app.post("/api/admin/dataset/annotators/:id/password", adminSetAnnotatorPassword);
app.post("/api/admin/dataset/annotators/:id/active", adminSetAnnotatorActive);

// 404
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// Global error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  // An oversized body is the caller's problem, not ours. Reported as 500 it
  // reads as "the service is broken" and invites a retry that cannot succeed.
  const status = (err as { status?: number; statusCode?: number }).status
    ?? (err as { statusCode?: number }).statusCode;
  if (err.name === "PayloadTooLargeError" || status === 413) {
    logger.warn("Request body too large", { error: err.message });
    res.status(413).json({ error: "payload_too_large" });
    return;
  }

  logger.error("Unhandled error", { error: err.message, stack: err.stack });
  res.status(500).json({ error: "Internal server error" });
});

export default app;
