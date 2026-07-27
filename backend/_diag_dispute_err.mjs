// Directly reproduce the dispute repository query error against the DB.
import "dotenv/config";
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
try {
  await pool.query(`select data from dispute_records where id = $1`, ["x"]);
  console.log("dispute_records query OK");
} catch (err) {
  console.log("DISPUTE QUERY ERROR:", err.code, "-", err.message);
} finally {
  await pool.end();
}
