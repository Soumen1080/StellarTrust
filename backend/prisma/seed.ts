/**
 * Seed the ledger chart of accounts.
 *
 * payment.service.ts posts every balanced ledger transaction against seven
 * fixed control-account UUIDs. Because ledger_entries.account_id is a real FK
 * to ledger_accounts, those rows must exist before any ledger entry is written.
 * These are multi-currency control accounts; the per-entry currency is what the
 * balancing invariant uses, so the account currency here is nominal (USD).
 *
 * Idempotent: uses upsert keyed by the fixed id. Runs through the Prisma client
 * + pg driver adapter (DATABASE_URL), i.e. the app's real runtime data path.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "../src/generated/prisma/client.js";

const CHART_OF_ACCOUNTS = [
  { id: "10000000-0000-4000-8000-000000000001", type: "asset", name: "Commitment Asset" },
  { id: "20000000-0000-4000-8000-000000000002", type: "liability", name: "Commitment Liability" },
  { id: "30000000-0000-4000-8000-000000000003", type: "asset", name: "Cash Clearing" },
  { id: "40000000-0000-4000-8000-000000000004", type: "liability", name: "Escrow Holding" },
  { id: "50000000-0000-4000-8000-000000000005", type: "asset", name: "Contract Custody" },
  { id: "60000000-0000-4000-8000-000000000006", type: "asset", name: "Delivery Asset" },
  { id: "70000000-0000-4000-8000-000000000007", type: "liability", name: "Delivery Liability" },
] as const;

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL ?? process.env.DIRECT_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL (or DIRECT_URL) must be set to seed the database");
  }

  const pool = new pg.Pool({ connectionString });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    for (const account of CHART_OF_ACCOUNTS) {
      await prisma.ledgerAccount.upsert({
        where: { id: account.id },
        update: { type: account.type, name: account.name, currency: "USD" },
        create: {
          id: account.id,
          type: account.type,
          currency: "USD",
          name: account.name,
          ownerRef: null,
        },
      });
    }
    const count = await prisma.ledgerAccount.count();
    console.log(`Seeded ledger chart of accounts. ledger_accounts rows: ${count}`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
