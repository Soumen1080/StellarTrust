/**
 * Postgres-backed ledger persistence.
 *
 * Golden Rule #1 names the double-entry ledger as the system of record. An
 * in-memory implementation of a system of record is a contradiction: it makes
 * every balance a function of process uptime, and — because RWA payout
 * idempotency is a lookup by reference id — it lets a restart turn a completed
 * payout back into an unposted one. (The token contract's one-shot
 * `distributed` flag is what actually catches that today, which is the wrong
 * component to be relying on.)
 *
 * Writes go inside one database transaction so a transaction header can never
 * exist without its entries. The deferred `ledger_balance_check` trigger from
 * migration 0001 validates the balancing invariant at COMMIT and is the final
 * backstop behind {@link LedgerService}'s own check.
 *
 * Parameterized queries only (Rules.md §7).
 */
import type pg from "pg";
import type { CurrencyCode, EntryDirection } from "@stellartrust/shared";
import { ConflictError } from "../../lib/errors.js";
import { assertBalanced } from "./ledger.balance.js";
import type { LedgerRepository } from "./ledger.repository.js";
import { systemAccountName } from "./system-accounts.js";
import type {
  LedgerTransactionInput,
  PersistedLedgerEntry,
  PersistedLedgerTransaction,
} from "./ledger.types.js";

/** Postgres timestamptz columns arrive as Date; normalize to ISO strings. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

interface TransactionRow {
  id: string;
  reference_id: string;
  description: string;
  created_at: Date | string;
}

interface EntryRow {
  id: string;
  transaction_id: string;
  account_id: string;
  direction: string;
  amount: string;
  currency: string;
  created_at: Date | string;
}

/** 23505 = unique_violation; here it can only be the reference id. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  );
}

export class PgLedgerRepository implements LedgerRepository {
  /** Cache of resolved `${name}:${currency}` → account id. */
  private readonly accountIdCache = new Map<string, string>();

  constructor(private readonly pool: pg.Pool) {}

  async insertTransaction(
    input: LedgerTransactionInput,
  ): Promise<PersistedLedgerTransaction> {
    // Belt and braces: the service checks this too, and the database checks it
    // again at commit. Money is the one place worth three checks.
    assertBalanced(input.entries);

    const client = await this.pool.connect();
    try {
      await client.query("begin");

      const header = await client.query<{ id: string; created_at: Date }>(
        `insert into ledger_transactions (reference_id, description)
         values ($1, $2)
         returning id, created_at`,
        [input.referenceId, input.description],
      );
      const headerRow = header.rows[0];
      if (!headerRow) throw new Error("Failed to create ledger transaction");
      const transactionId = headerRow.id;
      const createdAt = toIso(headerRow.created_at);

      const entries: PersistedLedgerEntry[] = [];
      for (const entry of input.entries) {
        const accountId = await this.resolveAccountId(
          client,
          entry.accountId,
          entry.currency,
        );
        const inserted = await client.query<{ id: string; created_at: Date }>(
          `insert into ledger_entries
             (transaction_id, account_id, direction, amount, currency)
           values ($1, $2, $3, $4, $5)
           returning id, created_at`,
          [transactionId, accountId, entry.direction, entry.amount, entry.currency],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error("Failed to create ledger entry");
        entries.push({
          id: row.id,
          transactionId,
          accountId,
          direction: entry.direction,
          amount: entry.amount,
          currency: entry.currency,
          createdAt: toIso(row.created_at),
        });
      }

      await client.query("commit");
      return {
        id: transactionId,
        referenceId: input.referenceId,
        description: input.description,
        entries,
        createdAt,
      };
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      if (isUniqueViolation(err)) {
        // Reference ids are unique — this money movement is already posted.
        // Callers recover the existing transaction rather than posting twice.
        throw new ConflictError(
          `Ledger transaction with referenceId "${input.referenceId}" already exists`,
        );
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async findByReferenceId(
    referenceId: string,
  ): Promise<PersistedLedgerTransaction | undefined> {
    const { rows } = await this.pool.query<TransactionRow>(
      `select id, reference_id, description, created_at
       from ledger_transactions where reference_id = $1`,
      [referenceId],
    );
    const header = rows[0];
    if (!header) return undefined;

    const { rows: entryRows } = await this.pool.query<EntryRow>(
      `select id, transaction_id, account_id, direction, amount, currency, created_at
       from ledger_entries where transaction_id = $1
       order by created_at asc, id asc`,
      [header.id],
    );

    return {
      id: header.id,
      referenceId: header.reference_id,
      description: header.description,
      createdAt: toIso(header.created_at),
      entries: entryRows.map((row) => ({
        id: row.id,
        transactionId: row.transaction_id,
        accountId: row.account_id,
        direction: row.direction as EntryDirection,
        amount: String(row.amount),
        currency: row.currency as CurrencyCode,
        createdAt: toIso(row.created_at),
      })),
    };
  }

  /** Synthetic role id + currency → the seeded system account's real id. */
  private async resolveAccountId(
    client: pg.PoolClient,
    syntheticId: string,
    currency: string,
  ): Promise<string> {
    const name = systemAccountName(syntheticId);
    const cacheKey = `${name}:${currency}`;
    const cached = this.accountIdCache.get(cacheKey);
    if (cached) return cached;

    const { rows } = await client.query<{ id: string }>(
      `select id from ledger_accounts
       where owner_ref = 'system' and currency = $1 and name = $2`,
      [currency, name],
    );
    const id = rows[0]?.id;
    if (!id) {
      throw new Error(
        `System ledger account '${name}' (${currency}) is not seeded`,
      );
    }
    this.accountIdCache.set(cacheKey, id);
    return id;
  }
}
