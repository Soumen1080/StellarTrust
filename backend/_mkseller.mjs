import "dotenv/config";
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL, max: 2 });
const email = `diag-seller-${Date.now()}@pending.stellartrust.local`;
const { rows } = await pool.query(
  `insert into users (email, display_name, kyc_status) values ($1,'diag seller','verified') returning id`,
  [email]
);
console.log(rows[0].id);
await pool.end();
