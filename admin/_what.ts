import { getPool } from "./src/lib/db.js";
const p = getPool();
const q = async (l: string, sql: string) => {
  const { rows } = await p.query(sql);
  console.log(l.padEnd(34), rows[0].n);
};
console.log("Rows behind each admin table:\n");
await q("Queues > KYC review queue", "select count(*)::int n from kyc_reviews where status='queued'");
await q("Queues > Treasury movements", "select count(*)::int n from treasury_movements");
await q("Queues > Asset verification", "select count(*)::int n from assets where verification_status='under_review'");
await q("Overview > Tokenizations", "select count(*)::int n from tokenizations");
await q("Overview > Disputes", "select count(*)::int n from dispute_records");
await q("Audit trail", "select count(*)::int n from audit_log");
await q("Orders (metrics only)", "select count(*)::int n from orders");
process.exit(0);
