import { Pool, type PoolClient } from "pg";
import { PGlite } from "@electric-sql/pglite";
import { config } from "../config";
import { logger } from "../utils/logger";

type QueryResult<T> = T[];

let backend: "postgres" | "pglite" | null = null;
let pool: Pool | null = null;
let pglite: PGlite | null = null;

async function initBackend(): Promise<void> {
  if (backend) return;

  // Try real PostgreSQL first
  try {
    const testPool = new Pool({
      connectionString: config.DATABASE_URL,
      connectionTimeoutMillis: 3000,
    });
    const client = await testPool.connect();
    await client.query("SELECT 1");
    client.release();
    pool = testPool;
    backend = "postgres";
    logger.info("Connected to PostgreSQL", { databaseUrl: maskUrl(config.DATABASE_URL) });
    return;
  } catch (err) {
    logger.warn("PostgreSQL unreachable, falling back to embedded PGlite", { error: (err as Error).message });
  }

  // Fallback to embedded PGlite
  try {
    pglite = new PGlite(config.PGLITE_DATA_DIR);
    backend = "pglite";
    logger.info("Using embedded PGlite database");
  } catch (err) {
    logger.error("Failed to initialize PGlite", { error: (err as Error).message });
    throw err;
  }
}

export async function query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
  await initBackend();

  if (backend === "postgres" && pool) {
    const result = await pool.query(sql, params);
    return result.rows as T[];
  }

  if (backend === "pglite" && pglite) {
    const result = await pglite.query<T>(sql, params);
    return Array.isArray(result.rows) ? (result.rows as T[]) : [];
  }

  throw new Error("No database backend available");
}

export async function queryOne<T = unknown>(sql: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function isDbHealthy(): Promise<boolean> {
  try {
    await initBackend();
    await query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function getClient(): Promise<PoolClient | PGlite> {
  await initBackend();
  if (backend === "postgres" && pool) {
    return pool.connect();
  }
  if (backend === "pglite" && pglite) {
    return pglite;
  }
  throw new Error("No database backend available");
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
  if (pglite) {
    await pglite.close();
    pglite = null;
  }
  backend = null;
}

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<invalid-url>";
  }
}

export { pool, pglite };
