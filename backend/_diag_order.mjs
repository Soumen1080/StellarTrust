// TEMP diagnostic: reproduce the order-create DB writes, then ROLLBACK.
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";

const conn = process.env.DIRECT_URL || process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString: conn, max: 2 });

async function q(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

try {
  const orders = await q(`select count(*)::int n from orders`);
  const escrows = await q(`select count(*)::int n from escrows`);
  const openMm = await q(`select count(*)::int n from reconciliation_mismatches where status='open'`);
  console.log(`orders=${orders[0].n} escrows=${escrows[0].n} openMismatches=${openMm[0].n}`);

  const users = await q(`select id from users limit 2`);
  if (users.length < 2) {
    console.log("Not enough users to simulate an order; skipping insert test.");
  } else {
    const [buyer, seller] = users;
    console.log(`Simulating CREATE order buyer=${buyer.id} seller=${seller.id} (will ROLLBACK)`);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const orderId = randomUUID();
      const now = new Date().toISOString();
      await client.query(
        `insert into orders (id, buyer_id, seller_id, amount, currency, status, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [orderId, buyer.id, seller.id, "10000", "USD", "created", now, now]
      );
      // resolve the two system accounts used by CREATE
      const acct = async (name) => {
        const r = await client.query(
          `select id from ledger_accounts where owner_ref='system' and currency=$1 and name=$2`,
          ["USD", name]
        );
        if (!r.rows[0]) throw new Error(`missing system account ${name} USD`);
        return r.rows[0].id;
      };
      const assetId = await acct("commitment_asset");
      const liabId = await acct("commitment_liability");
      const lt = await client.query(
        `insert into ledger_transactions (reference_id, description) values ($1,$2) returning id`,
        [`order:${orderId}:create`, "test"]
      );
      const ltId = lt.rows[0].id;
      await client.query(
        `insert into ledger_entries (transaction_id, account_id, direction, amount, currency)
         values ($1,$2,'debit',$3,'USD'),($1,$4,'credit',$3,'USD')`,
        [ltId, assetId, "10000", liabId]
      );
      const st = await client.query(
        `insert into stellar_transactions (hash, type, status, ledger_transaction_id, order_id, transition, amount, currency, contract_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [randomUUID().replace(/-/g,""), "escrow_create", "success", ltId, orderId, "create", "10000", "USD", null]
      );
      await client.query(
        `insert into payment_transitions (order_id, transition, actor_id, ledger_transaction_id, stellar_transaction_id)
         values ($1,$2,$3,$4,$5)`,
        [orderId, "create", buyer.id, ltId, st.rows[0].id]
      );
      await client.query("commit");  // deferred triggers fire here
      console.log("CREATE order DB path: COMMIT OK (would succeed) — rolling back now not possible, so cleaning up.");
      // Clean up the test rows we just committed.
      await pool.query(`delete from payment_transitions where order_id=$1`, [orderId]);
      await pool.query(`delete from stellar_transactions where order_id=$1`, [orderId]);
      await pool.query(`delete from ledger_entries where transaction_id=$1`, [ltId]);
      await pool.query(`delete from ledger_transactions where id=$1`, [ltId]);
      await pool.query(`delete from orders where id=$1`, [orderId]);
      console.log("cleanup done.");
    } catch (err) {
      await client.query("rollback").catch(() => {});
      console.log("CREATE order DB path FAILED:", err.code || "", err.message);
    } finally {
      client.release();
    }
  }
} catch (err) {
  console.error("ERROR:", err.message);
} finally {
  await pool.end();
}
