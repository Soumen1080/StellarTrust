/**
 * Apply pending migrations (`npm run db:migrate`).
 *
 * Migrations here are hand-applied against a hosted Postgres and there is no
 * tracking table, so this runner does not guess what has run. It asks the
 * database what exists, applies only what is missing, and stops at the first
 * failure rather than pressing on into a half-migrated schema.
 *
 * Safety, in the order it matters:
 *
 *   - **Nothing runs without confirmation.** The default is a dry run that
 *     prints the plan; `--apply` is required to write.
 *   - **Each file runs in its own transaction.** Every migration is already
 *     wrapped in `begin; … commit;`, so a failure inside one rolls that file
 *     back whole. This adds no second transaction around them — nesting would
 *     turn their explicit COMMIT into a no-op and mask exactly the failure it
 *     is meant to catch.
 *   - **It stops on the first error.** Migrations depend on each other in
 *     order; continuing past a failure is how a schema ends up in a state no
 *     migration file describes.
 *   - **Already-applied files are skipped**, detected by probing for an object
 *     each one creates. Re-running a migration is usually harmless here
 *     (`if not exists`, `on conflict do nothing`) but "usually" is not a
 *     property to rely on with 93 rows of real data behind it.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../config/index.js";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../infra/supabase/migrations",
);

/**
 * One probe per migration: a query returning a row iff that file has run.
 *
 * Kept beside the runner rather than inferred from the SQL, because inferring
 * "what does this file create" from arbitrary DDL is a parser, and a wrong
 * answer here either skips a needed migration or re-runs an applied one.
 */
const APPLIED_PROBE: Record<string, string> = {
  "0016": `select 1 from information_schema.columns
           where table_name = 'tokenizations' and column_name = 'face_value_amount'`,
  "0017": `select 1 from information_schema.tables where table_name = 'domain_events'`,
  "0018": `select 1 from information_schema.columns
           where table_name = 'assets' and column_name = 'verification_status'`,
  "0019": `select 1 from ledger_accounts
           where owner_ref = 'system' and name = 'rwa_secondary_seller_payable' limit 1`,
  "0020": `select 1 from information_schema.views
           where table_name = 'ledger_account_balances'`,
  "0021": `select 1 from information_schema.tables where table_name = 'treasury_movements'`,
  "0022": `select 1 from information_schema.tables where table_name = 'verification_policies'`,
  "0023": `select 1 from information_schema.columns
           where table_name = 'users' and column_name = 'username'`,
};

/** Files this runner manages, oldest first. Order is load-bearing. */
const MIGRATIONS = [
  "0016_rwa_financing_economics.sql",
  "0017_domain_events_and_settlement_order_link.sql",
  "0018_rwa_asset_verification.sql",
  "0019_rwa_secondary_market.sql",
  "0020_user_ledger_accounts_and_money_invariants.sql",
  "0021_treasury_movements.sql",
  "0022_kyc_reputation_persistence_and_verification_policy.sql",
  "0023_user_usernames_and_avatars.sql",
];

function prefixOf(filename: string): string {
  return filename.slice(0, 4);
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  console.log("StellarTrust — migration runner\n");
  if (!config.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    ssl: config.DATABASE_URL.includes("localhost")
      ? undefined
      : { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
  });

  try {
    const { rows } = await pool.query<{ db: string }>(
      "select current_database() as db",
    );
    console.log(`  Database: ${rows[0]?.db}`);
  } catch (err) {
    console.error(`  Cannot connect: ${(err as Error).message}`);
    await pool.end();
    process.exit(1);
  }

  // Report what is at stake, so a dry run is also a reminder to take a backup.
  const { rows: counts } = await pool.query<{ n: string }>(
    `select coalesce(sum(n), 0)::text as n from (
       select count(*) n from ledger_entries
       union all select count(*) from orders
       union all select count(*) from tokenizations
     ) t`,
  );
  console.log(`  Existing rows in ledger/orders/tokenizations: ${counts[0]?.n}\n`);

  // ── Work out what is pending ─────────────────────────────────────────────
  const pending: string[] = [];
  for (const file of MIGRATIONS) {
    const probe = APPLIED_PROBE[prefixOf(file)];
    let applied = false;
    if (probe) {
      try {
        const { rowCount } = await pool.query(probe);
        applied = (rowCount ?? 0) > 0;
      } catch {
        // A probe that cannot run means the objects it references are absent,
        // which means the migration has not been applied.
        applied = false;
      }
    }
    console.log(`  ${applied ? "applied " : "PENDING "} ${file}`);
    if (!applied) pending.push(file);
  }

  if (pending.length === 0) {
    console.log("\nNothing to do — the schema is current.\n");
    await pool.end();
    return;
  }

  if (!apply) {
    console.log(
      `\n${pending.length} migration(s) pending.\n\n` +
        "This was a dry run; nothing was changed.\n\n" +
        "Take a database backup, then run:\n" +
        "  npm run db:migrate -- --apply\n",
    );
    await pool.end();
    return;
  }

  // ── Apply ────────────────────────────────────────────────────────────────
  console.log(`\nApplying ${pending.length} migration(s)…\n`);

  for (const file of pending) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    process.stdout.write(`  ${file} … `);
    // A dedicated client, so a failure cannot leave a pooled connection inside
    // an aborted transaction for the next statement to trip over.
    const client = await pool.connect();
    try {
      // Sent as one string: each file carries its own begin/commit, and
      // wrapping it in another transaction here would demote that COMMIT to a
      // savepoint release and hide a failure this is meant to surface.
      await client.query(sql);
      console.log("ok");
    } catch (err) {
      console.log("FAILED\n");
      console.error(`  ${(err as Error).message}\n`);
      console.error(
        "Stopped here. The file above rolled back whole (it is wrapped in\n" +
          "begin/commit), and later migrations were not attempted — they\n" +
          "depend on this one, and applying them now would leave the schema\n" +
          "in a state no migration file describes.\n",
      );
      client.release();
      await pool.end();
      process.exit(1);
    }
    client.release();
  }

  await pool.end();
  console.log(
    "\nDone. Verify with:\n  npm run db:readiness\n",
  );
}

main().catch((err: unknown) => {
  console.error(`\nmigration run failed: ${(err as Error).message}`);
  process.exit(1);
});
