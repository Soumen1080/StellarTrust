// TEMP read-only diagnostic: which tables/columns exist in the DB?
import "dotenv/config";
import pg from "pg";

const conn = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!conn) {
  console.error("No DIRECT_URL/DATABASE_URL in env");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: conn, max: 2 });

const EXPECTED_TABLES = [
  "users", "wallets", "businesses", "kyc_verifications",
  "ledger_accounts", "ledger_transactions", "ledger_entries",
  "orders", "escrows",
  "stellar_transactions", "payment_transitions", "reconciliation_mismatches",
  "disputes", "dispute_evidence", "dispute_records",
  "assets", "tokenizations", "token_holdings",
  "audit_log", "auth_sessions", "sep10_challenges",
];

try {
  const { rows: tblRows } = await pool.query(
    `select table_name from information_schema.tables
     where table_schema = 'public' order by table_name`
  );
  const present = new Set(tblRows.map((r) => r.table_name));
  console.log("=== TABLES PRESENT ===");
  console.log([...present].join(", ") || "(none)");
  console.log("\n=== EXPECTED TABLE STATUS ===");
  for (const t of EXPECTED_TABLES) {
    console.log(`${present.has(t) ? "OK " : "MISSING"}  ${t}`);
  }

  // Columns added by later migrations on shared tables
  const { rows: stCols } = await pool.query(
    `select column_name from information_schema.columns
     where table_schema='public' and table_name='stellar_transactions' order by column_name`
  );
  console.log("\n=== stellar_transactions columns ===");
  console.log(stCols.map((r) => r.column_name).join(", ") || "(table missing)");

  // Seeded system ledger accounts?
  if (present.has("ledger_accounts")) {
    const { rows: acct } = await pool.query(
      `select count(*)::int as n from ledger_accounts where owner_ref='system'`
    );
    console.log(`\nsystem ledger_accounts seeded: ${acct[0].n}`);
  }

} catch (err) {
  console.error("QUERY ERROR:", err.message);
} finally {
  await pool.end();
}
