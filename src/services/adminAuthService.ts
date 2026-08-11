import { randomBytes, createHash, scrypt, timingSafeEqual } from "crypto";
import { promisify } from "util";
import type { Request, Response } from "express";
import { logger } from "../utils/logger";
import { config } from "../config";
import { query, queryOne } from "../db/connection";

/**
 * Password login with server-side sessions for the admin panel.
 *
 * Replaces a single static token that was typed into every request: that token
 * never expired, could not be revoked, and sat in the browser's localStorage
 * where any script on the page could read it. A session cookie is httpOnly, has
 * an expiry, and can be revoked by deleting one row.
 *
 * The token is still accepted for automation, but only when it is long enough
 * to be an actual secret rather than something a human invented.
 */

const scryptAsync = promisify(scrypt);

export const SESSION_COOKIE = "tiltab_admin";
const TOKEN_BYTES = 32;
/** Below this a static token is guessable; treat it as not configured. */
const MIN_MACHINE_TOKEN_LENGTH = 32;

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

/** Format: scrypt$<saltHex>$<keyHex>. Self-describing so it can change later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

/** Exported so the annotator accounts hash and check passwords the same way. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    logger.error("ADMIN_PASSWORD_HASH is malformed; expected scrypt$salt$key");
    return false;
  }
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  const actual = (await scryptAsync(password, salt, expected.length)) as Buffer;
  // Constant-time: a plain === leaks how much of the hash matched via timing.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
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

function clientIp(req: Request): string {
  // No reverse proxy in front yet, so socket address is the real client. Once
  // one is added, trust proxy must be configured before believing X-Forwarded-For.
  return req.socket.remoteAddress || "unknown";
}

export function loginLockRemainingMs(req: Request): number {
  const rec = attemptsByIp.get(clientIp(req));
  if (!rec) return 0;
  return Math.max(0, rec.lockedUntil - Date.now());
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
    logger.warn("Admin login locked out after repeated failures", {
      ip,
      minutes: config.TILTAB_ADMIN_LOGIN_LOCKOUT_MINUTES,
    });
  }
}

function clearFailures(req: Request): void {
  attemptsByIp.delete(clientIp(req));
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function createSession(req: Request): Promise<string> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const hours = config.TILTAB_ADMIN_SESSION_HOURS;
  await query(
    `INSERT INTO admin_sessions (token_hash, expires_at, ip, user_agent)
     VALUES ($1, NOW() + ($2 || ' hours')::interval, $3, $4)`,
    [hashToken(token), String(hours), clientIp(req), String(req.headers["user-agent"] || "").slice(0, 300)]
  );
  return token;
}

async function touchSession(token: string): Promise<boolean> {
  const row = await queryOne<{ token_hash: string }>(
    `UPDATE admin_sessions SET last_seen_at = NOW()
     WHERE token_hash = $1 AND expires_at > NOW()
     RETURNING token_hash`,
    [hashToken(token)]
  );
  return Boolean(row);
}

async function destroySession(token: string): Promise<void> {
  await query(`DELETE FROM admin_sessions WHERE token_hash = $1`, [hashToken(token)]);
}

export async function purgeExpiredSessions(): Promise<void> {
  try {
    await query(`DELETE FROM admin_sessions WHERE expires_at < NOW()`);
  } catch (err) {
    logger.warn("Failed to purge expired admin sessions", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Request authentication
// ---------------------------------------------------------------------------

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

/** True when a password is configured; the panel then requires a real login. */
export function passwordConfigured(): boolean {
  return Boolean(config.ADMIN_PASSWORD_HASH);
}

/**
 * Whether the static token may still be used.
 *
 * The length rule only bites once a password exists. Enforcing it earlier would
 * lock the admin out of the panel they need in order to set the password up —
 * the upgrade has to have a door open while you walk through it.
 */
function machineTokenUsable(): boolean {
  const token = config.TILTAB_ADMIN_TOKEN;
  if (!token) return false;
  if (!passwordConfigured()) return true;
  return token.length >= MIN_MACHINE_TOKEN_LENGTH;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Authenticate a request: a valid session cookie, or a long static token for
 * automation. Returns the reason on failure so the panel can tell "log in"
 * apart from "your session expired".
 */
export async function authenticate(req: Request): Promise<{ ok: boolean; via?: "session" | "token" }> {
  const cookie = readCookie(req, SESSION_COOKIE);
  if (cookie && (await touchSession(cookie))) {
    return { ok: true, via: "session" };
  }

  const provided = req.headers["x-admin-token"];
  if (typeof provided === "string" && config.TILTAB_ADMIN_TOKEN) {
    if (!machineTokenUsable()) {
      // A short token is exactly the weakness this replaced; once a password
      // exists, refusing it is what forces the upgrade instead of leaving a
      // quiet back door open next to the front one.
      logger.warn("Static admin token rejected: password login is configured and the token is under 32 characters");
      return { ok: false };
    }
    if (safeEqual(provided, config.TILTAB_ADMIN_TOKEN)) {
      return { ok: true, via: "token" };
    }
  }

  return { ok: false };
}

// ---------------------------------------------------------------------------
// Handlers
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
  // Secure would make the cookie undeliverable over plain HTTP, which is how
  // the panel is served until TLS is in front of it.
  if (config.TILTAB_ADMIN_COOKIE_SECURE) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export async function login(req: Request, res: Response): Promise<void> {
  if (!passwordConfigured()) {
    res.status(503).json({ error: "ADMIN_PASSWORD_HASH не задан на сервере" });
    return;
  }

  const lockMs = loginLockRemainingMs(req);
  if (lockMs > 0) {
    res.status(429).json({
      error: `Слишком много попыток. Подождите ${Math.ceil(lockMs / 60000)} мин.`,
    });
    return;
  }

  const { password } = req.body as { password?: string };
  if (!password) {
    res.status(400).json({ error: "password is required" });
    return;
  }

  const ok = await verifyPassword(password, config.ADMIN_PASSWORD_HASH as string);
  if (!ok) {
    recordFailure(req);
    logger.warn("Admin login failed", { ip: clientIp(req) });
    // Deliberately vague: naming the reason helps an attacker, not the admin.
    res.status(401).json({ error: "Неверный пароль" });
    return;
  }

  clearFailures(req);
  const token = await createSession(req);
  setSessionCookie(res, token);
  logger.info("Admin logged in", { ip: clientIp(req) });
  res.json({ ok: true, expiresInHours: config.TILTAB_ADMIN_SESSION_HOURS });
}

export async function logout(req: Request, res: Response): Promise<void> {
  const cookie = readCookie(req, SESSION_COOKIE);
  if (cookie) await destroySession(cookie);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`);
  res.json({ ok: true });
}

/** Lets the panel decide whether to show the login form or the data. */
export async function session(req: Request, res: Response): Promise<void> {
  const result = await authenticate(req);
  res.json({
    authenticated: result.ok,
    via: result.via ?? null,
    passwordConfigured: passwordConfigured(),
  });
}
