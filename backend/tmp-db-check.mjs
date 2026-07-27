import "dotenv/config";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  const q = async (label, sql) => {
    const { rows } = await pool.query(sql);
    console.log(`\n=== ${label} ===`);
    console.dir(rows, { depth: null });
  };

  await q("orders", "select id, buyer_id, seller_id, amount, currency, status, created_at from orders order by created_at desc limit 10");
  await q("payment_transitions", "select id, order_id, transition, actor_id, created_at from payment_transitions order by created_at desc limit 20");
  await q("escrows", "select id, order_id, state, contract_id from escrows limit 10");
  await q("stellar_transactions (order-linked)", "select count(*)::int as n from stellar_transactions where order_id is not null");
  await q("ledger_transactions", "select count(*)::int as n from ledger_transactions");
  await q("users", "select id, email, created_at from users order by created_at desc limit 10");
} catch (err) {
  console.error("DB CHECK ERROR:", err.message);
} finally {
  await pool.end();
}
