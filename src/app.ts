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
import { adminListAnnotators, adminCreateAnnotator } from "./controllers/datasetController";
import { getProvidersHealth } from "./controllers/providersController";
import { currentAnnotator } from "./services/datasetAuthService";
import { isSuperAdmin } from "./services/datasetPermissions";
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

// Закрытые страницы отдаются только вошедшим.
//
// Раньше сама разметка была публичной: считалось, что страница без данных не
// опасна, ведь API всё равно спрашивает права. Это верно про утечку данных, но
// не про всё остальное — посторонним видно устройство админки, названия полей
// и действий, а поисковики такие страницы индексируют. Прятать нечего только
// тогда, когда прятать нечего.
//
// Переброс на клиенте (guard.js) остаётся: он показывает человеку страницу
// входа вместо голого отказа. Настоящая проверка теперь здесь.
const SUPER_ADMIN_PAGES = new Set(["/admin.html", "/admin-beta-test.html"]);
const DATASET_PAGES = new Set([
  "/dataset-tasks.html",
  "/dataset-task.html",
  "/dataset-users.html",
  "/dataset-export.html",
]);

app.use("/web", async (req: Request, res: Response, next: NextFunction) => {
  const page = req.path.toLowerCase();
  const needsSuperAdmin = SUPER_ADMIN_PAGES.has(page);
  if (!needsSuperAdmin && !DATASET_PAGES.has(page)) {
    next();
    return;
  }

  const annotator = await currentAnnotator(req).catch(() => null);
  const allowed = annotator !== null && (!needsSuperAdmin || isSuperAdmin(annotator));
  if (allowed) {
    next();
    return;
  }

  // Ведём на вход и запоминаем, куда человек шёл: после входа он попадёт
  // туда же, а не на общую страницу и заново искать нужное.
  const next_ = encodeURIComponent(req.originalUrl);
  res.redirect(302, `/web/dataset.html?next=${next_}`);
});

// Остальная разметка публична. Страница входа обязана быть открытой, иначе
// войти неоткуда.
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

// Учётки разметки заводит супер-админ на своей странице. Эти два маршрута —
// аварийный путь: если единственного супер-админа потеряли, восстановить
// доступ изнутри самой страницы уже нечем.
app.get("/api/admin/dataset/annotators", adminListAnnotators);
app.post("/api/admin/dataset/annotators", adminCreateAnnotator);

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
