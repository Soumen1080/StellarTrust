/**
 * Postgres (Supabase) connection pool — lazily created so the app can boot for
 * local/dev and tests without a database. Financial writes use DB transactions
 * (Rules.md §2). Parameterized queries only (Rules.md §7).
 */
import pg from "pg";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!config.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not configured. Set it (via secret manager) before using the database.",
    );
  }
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
    pool.on("error", (err) => logger.error({ err }, "pg pool error"));
  }
  return pool;
}

export async function pingDatabase(): Promise<boolean> {
  if (!config.DATABASE_URL) return false;
  try {
    await getPool().query("select 1");
    return true;
  } catch (err) {
    logger.warn({ err }, "database ping failed");
    return false;
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
