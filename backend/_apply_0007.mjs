import "dotenv/config";
import { readFileSync } from "node:fs";
import pg from "pg";

const sql = readFileSync(
  new URL("../infra/supabase/migrations/0007_dispute_persistence.sql", import.meta.url),
  "utf8",
);

// Use the session-mode (DIRECT_URL) connection for DDL when available.
const conn = process.env.DIRECT_URL || process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString: conn, max: 1 });

try {
  // Guard: only apply if the table is still missing (idempotent-safe).
  const { rows } = await pool.query(
    `select to_regclass('public.dispute_records') as t`,
  );
  if (rows[0].t) {
    console.log("dispute_records already exists — nothing to do.");
  } else {
    console.log("Applying 0007_dispute_persistence.sql ...");
    await pool.query(sql); // the file wraps its own begin/commit
    console.log("Applied. Verifying...");
    const check = await pool.query(
      `select to_regclass('public.dispute_records') as t`,
    );
    console.log("dispute_records present:", Boolean(check.rows[0].t));
  }
} catch (err) {
  console.error("APPLY ERROR:", err.code, "-", err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
