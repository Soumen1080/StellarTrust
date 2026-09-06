/**
 * Is the database ready for this build? (`npm run db:readiness`)
 *
 * Migrations are applied by hand against a hosted Postgres, and there is no
 * migration tracking table — so the honest way to answer "is the schema up to
 * date" is to ask the database for the objects this build actually needs, not
 * to read a version number that could be wrong.
 *
 * Every check below names a real dependency: a table a repository queries, a
 * view a balance read selects from, a constraint a money invariant relies on.
 * A missing one is not a warning — it is a specific runtime failure, and the
 * output says which, because "purchases are refused" is a much harder thing to
 * debug than "ledger_account_balances does not exist".
 *
 * **Read-only.** It creates nothing and changes nothing; it is safe to run
 * against production.
 */
import pg from "pg";
import { config } from "../config/index.js";

interface Check {
  /** What breaks when this is missing, in the user's terms. */
  need: string;
  /** The migration that introduces it. */
  migration: string;
  sql: string;
  params?: unknown[];
}

/**
 * Objects this build depends on, oldest migration first.
 *
 * The range starts at 0016 rather than at the newest few. An earlier version
 * of this script checked only 0020–0022 and reported a database at 0015 as
 * needing three migrations when it needed seven — which is the worst kind of
 * wrong for a readiness check, because it is confidently specific. The rule
 * now is that every migration since the last one known to be universally
 * deployed gets a probe.
 *
 * Everything below 0016 is assumed present: the app could not have served a
 * single order without it.
 */
const CHECKS: Check[] = [
  {
    need: "Financing terms — face value, advance rate, yield, maturity",
    migration: "0016",
    sql: `select 1 from information_schema.columns
          where table_name = 'tokenizations' and column_name = 'face_value_amount'`,
  },
  {
    need: "The payout waterfall's fee and recovery accounts",
    migration: "0016",
    sql: `select 1 from ledger_accounts
          where owner_ref = 'system' and name = 'rwa_platform_fee_revenue' limit 1`,
  },
  {
    need: "The domain event spine — cross-domain reactions run through it",
    migration: "0017",
    sql: `select 1 from information_schema.tables
          where table_name = 'domain_events'`,
  },
  {
    need: "Handler de-duplication — stops an event paying out twice",
    migration: "0017",
    sql: `select 1 from information_schema.tables
          where table_name = 'domain_event_handled'`,
  },
  {
    need: "Settlement → escrow link, so a corridor can fund an order",
    migration: "0017",
    sql: `select 1 from information_schema.columns
          where table_name = 'settlements' and column_name = 'order_id'`,
  },
  {
    need: "Asset verification — only a verified asset may be tokenized",
    migration: "0018",
    sql: `select 1 from information_schema.columns
          where table_name = 'assets' and column_name = 'verification_status'`,
  },
  {
    need: "Secondary market seller proceeds",
    migration: "0019",
    sql: `select 1 from ledger_accounts
          where owner_ref = 'system' and name = 'rwa_secondary_seller_payable' limit 1`,
  },
  {
    need: "Per-user balances — every purchase, deposit and withdrawal reads this",
    migration: "0020",
    sql: `select 1 from information_schema.views
          where table_name = 'ledger_account_balances'`,
  },
  {
    need: "A user ledger account must be a liability",
    migration: "0020",
    sql: `select 1 from pg_constraint
          where conname = 'ledger_accounts_user_owned_is_liability'`,
  },
  {
    need: "owner_ref shape — stops a typo creating an unfindable account",
    migration: "0020",
    sql: `select 1 from pg_constraint
          where conname = 'ledger_accounts_owner_ref_shape'`,
  },
  {
    need: "A holding cannot exceed its tokenization's supply",
    migration: "0020",
    sql: `select 1 from pg_trigger
          where tgname = 'assert_holding_within_supply'`,
  },
  {
    need: "Payouts cannot exceed the collectible face value",
    migration: "0020",
    sql: `select 1 from pg_trigger
          where tgname = 'assert_payout_within_collection'`,
  },
  {
    need: "Deposits and withdrawals — the /wallet page and treasury API",
    migration: "0021",
    sql: `select 1 from information_schema.tables
          where table_name = 'treasury_movements'`,
  },
  {
    need: "A Stellar transaction can be credited only once",
    migration: "0021",
    sql: `select 1 from pg_indexes
          where indexname = 'treasury_movements_tx_hash_key'`,
  },
  {
    need: "KYC survives a restart",
    migration: "0022",
    sql: `select 1 from information_schema.tables
          where table_name = 'kyc_verification_records'`,
  },
  {
    need: "The KYC review queue survives a restart",
    migration: "0022",
    sql: `select 1 from information_schema.tables
          where table_name = 'kyc_reviews'`,
  },
  {
    need: "Reputation survives a restart",
    migration: "0022",
    sql: `select 1 from information_schema.tables
          where table_name = 'reputation_records'`,
  },
  {
    need: "The admin console's verification policy",
    migration: "0022",
    sql: `select 1 from information_schema.tables
          where table_name = 'verification_policies'`,
  },
  {
    need: "Usernames and profile pictures — the profile page and the admin queues",
    migration: "0023",
    sql: `select 1 from information_schema.columns
          where table_name = 'users' and column_name = 'username'`,
  },
  {
    need: "A username cannot be claimed twice",
    migration: "0023",
    sql: `select 1 from pg_indexes
          where indexname = 'users_username_lower_idx'`,
  },
];

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  console.log("StellarTrust — database readiness\n");

  if (!config.DATABASE_URL) {
    fail(
      "DATABASE_URL is not set.\n\n" +
        "Without it the backend runs entirely on in-memory stores: every\n" +
        "balance, order and KYC decision is lost when the process restarts.\n" +
        "That is fine for a unit test and wrong for anything you demo.",
    );
  }

  // `ssl` is what a hosted Postgres (Supabase, Neon, Render) requires and a
  // local one refuses. `rejectUnauthorized: false` accepts their managed
  // certificate chain, which is standard for these providers.
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    ssl: config.DATABASE_URL.includes("localhost")
      ? undefined
      : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
  });

  try {
    const { rows } = await pool.query<{ db: string; version: string }>(
      "select current_database() as db, version() as version",
    );
    const server = rows[0];
    console.log(`  Connected to: ${server?.db}`);
    console.log(`  ${server?.version?.split(",")[0]}\n`);
  } catch (err) {
    await pool.end().catch(() => undefined);
    fail(
      `Could not connect: ${(err as Error).message}\n\n` +
        "Check DATABASE_URL, and that this machine's IP is allowed by the\n" +
        "database's network rules.",
    );
  }

  const missing: Check[] = [];
  console.log("Schema objects this build needs:\n");

  for (const check of CHECKS) {
    let present = false;
    try {
      const { rowCount } = await pool.query(check.sql, check.params ?? []);
      present = (rowCount ?? 0) > 0;
    } catch {
      present = false;
    }
    console.log(
      `  ${present ? "OK  " : "MISS"}  [${check.migration}] ${check.need}`,
    );
    if (!present) missing.push(check);
  }

  await pool.end();

  if (missing.length === 0) {
    console.log("\nReady. Every object this build depends on is present.\n");
    return;
  }

  // Name the migrations rather than the objects: applying a migration is the
  // action available, and it is idempotent enough to re-run in order.
  const pending = [...new Set(missing.map((check) => check.migration))].sort();
  console.error("\n─────────────────────────────────────────────────────────");
  console.error("NOT READY\n");
  if (pending.length > 0) {
    console.error(`Apply these migrations, in order: ${pending.join(", ")}\n`);
    for (const migration of pending) {
      console.error(`  infra/supabase/migrations/${migration}_*.sql`);
    }
  }
  console.error(
    "\nUntil then: purchases are refused, deposits cannot be credited,\n" +
      "and KYC state is lost on every restart.",
  );
  console.error("─────────────────────────────────────────────────────────\n");
  process.exit(1);
}

main().catch((err: unknown) => {
  fail(`readiness check failed: ${(err as Error).message}`);
});
