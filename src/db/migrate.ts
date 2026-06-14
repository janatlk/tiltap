import { getClient } from "./connection";
import { logger } from "../utils/logger";
import * as fs from "fs";
import * as path from "path";

function stripComments(sql: string): string {
  // Remove single-line comments
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

export async function migrate(): Promise<void> {
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf-8");

  const client = await getClient();
  try {
    const cleanSql = stripComments(sql);
    const statements = cleanSql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      await (client as { query: (sql: string) => Promise<unknown> }).query(stmt + ";");
    }

    logger.info("Database migration completed", { statements: statements.length });
  } catch (err) {
    logger.error("Database migration failed", { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
    throw err;
  } finally {
    // PGlite has no release(); PoolClient does
    if (typeof (client as { release?: () => void }).release === "function") {
      (client as { release: () => void }).release();
    }
  }
}
