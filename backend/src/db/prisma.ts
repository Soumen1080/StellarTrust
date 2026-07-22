/**
 * Prisma Client (Postgres/Supabase) via the `pg` driver adapter — Prisma 7
 * requires an explicit driver adapter; there is no built-in query engine.
 * Lazily created so the app can boot for local/dev and tests without a
 * database (mirrors src/db/index.ts). Uses DATABASE_URL — the Supabase
 * *transaction*-mode pooler (pgbouncer, port 6543) — for runtime queries.
 * Migrations/introspection use DIRECT_URL (session pooler) via
 * prisma.config.ts, never this pool.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { config } from "../config/index.js";
import { PrismaClient } from "../generated/prisma/client.js";
import { logger } from "../lib/logger.js";

let pool: pg.Pool | undefined;
let client: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  if (!config.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not configured. Set it (via secret manager) before using Prisma.",
    );
  }
  if (!client) {
    pool = new pg.Pool({
      connectionString: config.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
    pool.on("error", (err) => logger.error({ err }, "prisma pg pool error"));

    const adapter = new PrismaPg(pool);
    client = new PrismaClient({
      adapter,
      log: config.isProduction ? ["error", "warn"] : ["error", "warn"],
    });
  }
  return client;
}

export async function pingPrisma(): Promise<boolean> {
  if (!config.DATABASE_URL) return false;
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return true;
  } catch (err) {
    logger.warn({ err }, "prisma ping failed");
    return false;
  }
}

export async function closePrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
