import { randomBytes, createHash } from "crypto";
import type { Request, Response } from "express";
import { logger } from "../utils/logger";
import { config } from "../config";
import { hashPassword, verifyPassword } from "./adminAuthService";
import {
  type Annotator,
  createAnnotatorSession,
  destroyAnnotatorSession,
  findAnnotatorByUsername,
  resolveAnnotatorSession,
  touchAnnotatorLogin,
  purgeExpiredAnnotatorSessions,
} from "../db/repos/datasetRepo";

/**
 * Logins for the linguists working on the annotation corpus.
 *
 * Deliberately a separate identity from the admin panel: a linguist needs to
 * correct transcripts, not to read the request log, rotate provider keys, or
 * reply to user feedback. Reusing the admin password would hand out all of it.
 */

const SESSION_COOKIE = "tiltab_dataset";
const TOKEN_BYTES = 32;
const MIN_PASSWORD_LENGTH = 8;

export { SESSION_COOKIE as DATASET_SESSION_COOKIE };

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function clientIp(req: Request): string {
  return req.socket.remoteAddress || "unknown";
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Brute-force protection
// ---------------------------------------------------------------------------

interface Attempts {
  count: number;
  firstAt: number;
  lockedUntil: number;
}

const attemptsByIp = new Map<string, Attempts>();

function lockRemainingMs(req: Request): number {
  const rec = attemptsByIp.get(clientIp(req));
  return rec ? Math.max(0, rec.lockedUntil - Date.now()) : 0;
}

function recordFailure(req: Request): void {
  const ip = clientIp(req);
  const now = Date.now();
  const windowMs = config.TILTAB_ADMIN_LOGIN_WINDOW_MINUTES * 60_000;
  const rec = attemptsByIp.get(ip);

  if (!rec || now - rec.firstAt > windowMs) {
    attemptsByIp.set(ip, { count: 1, firstAt: now, lockedUntil: 0 });
    return;
  }
  rec.count += 1;
  if (rec.count >= config.TILTAB_ADMIN_LOGIN_MAX_ATTEMPTS) {
    rec.lockedUntil = now + config.TILTAB_ADMIN_LOGIN_LOCKOUT_MINUTES * 60_000;
    rec.count = 0;
    rec.firstAt = now;
    logger.warn("Dataset login locked out after repeated failures", { ip });
  }
}

// ---------------------------------------------------------------------------
// Password rules
// ---------------------------------------------------------------------------

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов`;
  }
  return null;
}

export { hashPassword };

// ---------------------------------------------------------------------------
// Session handling
// ---------------------------------------------------------------------------

function setSessionCookie(res: Response, token: string): void {
  const maxAge = config.TILTAB_ADMIN_SESSION_HOURS * 3600;
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ];
  if (config.TILTAB_ADMIN_COOKIE_SECURE) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

/** The annotator behind this request, or null. */
export async function currentAnnotator(req: Request): Promise<Annotator | null> {
  const cookie = readCookie(req, SESSION_COOKIE);
  if (!cookie) return null;
  return resolveAnnotatorSession(hashToken(cookie));
}

export async function loginAnnotator(req: Request, res: Response): Promise<void> {
  const lockMs = lockRemainingMs(req);
  if (lockMs > 0) {
    res.status(429).json({ error: `Слишком много попыток. Подождите ${Math.ceil(lockMs / 60000)} мин.` });
    return;
  }

  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    res.status(400).json({ error: "Введите логин и пароль" });
    return;
  }

  const annotator = await findAnnotatorByUsername(username);
  const ok = annotator?.active ? await verifyPassword(password, annotator.password_hash) : false;
  if (!annotator || !ok) {
    recordFailure(req);
    // One message for both cases: telling them the login exists is a free hint.
    res.status(401).json({ error: "Неверный логин или пароль" });
    return;
  }

  attemptsByIp.delete(clientIp(req));
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  await createAnnotatorSession(hashToken(token), annotator.id, config.TILTAB_ADMIN_SESSION_HOURS, clientIp(req));
  await touchAnnotatorLogin(annotator.id);
  setSessionCookie(res, token);
  logger.info("Annotator logged in", { username: annotator.username });

  res.json({ ok: true, annotator: publicAnnotator(annotator) });
}

export async function logoutAnnotator(req: Request, res: Response): Promise<void> {
  const cookie = readCookie(req, SESSION_COOKIE);
  if (cookie) await destroyAnnotatorSession(hashToken(cookie));
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`);
  res.json({ ok: true });
}

export async function annotatorSession(req: Request, res: Response): Promise<void> {
  const annotator = await currentAnnotator(req);
  res.json({
    authenticated: Boolean(annotator),
    annotator: annotator ? publicAnnotator(annotator) : null,
  });
}

/** Never let password_hash out of the service layer. */
export function publicAnnotator(annotator: Annotator) {
  return {
    id: annotator.id,
    username: annotator.username,
    displayName: annotator.display_name,
    isAdmin: annotator.is_admin,
    active: annotator.active,
    lastLoginAt: annotator.last_login_at,
  };
}

export async function purgeDatasetSessions(): Promise<void> {
  try {
    await purgeExpiredAnnotatorSessions();
  } catch (err) {
    logger.warn("Failed to purge expired dataset sessions", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
