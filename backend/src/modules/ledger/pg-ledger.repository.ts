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
import type { AccountBalance, LedgerRepository } from "./ledger.repository.js";
import { systemAccountName } from "./system-accounts.js";
import { parseUserAccountRef } from "./user-accounts.js";
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

  /**
   * Every balance owned by `ownerRef`, read from the `ledger_account_balances`
   * view (migration 0020) so the arithmetic is Postgres's rather than a second
   * implementation of it here.
   */
  async listBalances(ownerRef: string): Promise<AccountBalance[]> {
    const { rows } = await this.pool.query<{
      owner_ref: string;
      name: string;
      currency: string;
      balance: string;
      total_debits: string;
      total_credits: string;
      entry_count: string;
      last_entry_at: Date | string | null;
    }>(
      `select owner_ref, name, currency, balance, total_debits, total_credits,
              entry_count, last_entry_at
       from ledger_account_balances
       where owner_ref = $1
       order by currency asc, name asc`,
      [ownerRef],
    );

    return rows.map((row) => ({
      ownerRef: row.owner_ref,
      name: row.name,
      currency: row.currency as CurrencyCode,
      balance: String(row.balance),
      totalDebits: String(row.total_debits),
      totalCredits: String(row.total_credits),
      entryCount: Number(row.entry_count),
      lastEntryAt: row.last_entry_at ? toIso(row.last_entry_at) : null,
    }));
  }

  async getBalance(ownerRef: string, currency: CurrencyCode): Promise<string> {
    const { rows } = await this.pool.query<{ balance: string }>(
      `select coalesce(sum(balance), 0)::text as balance
       from ledger_account_balances
       where owner_ref = $1 and currency = $2`,
      [ownerRef, currency],
    );
    return rows[0]?.balance ?? "0";
  }

  /**
   * Account reference + currency → the real `ledger_accounts` row id.
   *
   * Two address spaces meet here. A system account is a fixed synthetic UUID
   * that must already be seeded — a missing one is a deployment error, so it
   * throws. A user account is created on demand: a user's first transaction is
   * the moment their account should exist, and requiring an out-of-band
   * provisioning step would make that first payment fail for everyone.
   */
  private async resolveAccountId(
    client: pg.PoolClient,
    syntheticId: string,
    currency: string,
  ): Promise<string> {
    const userAccount = parseUserAccountRef(syntheticId);
    if (userAccount) {
      return this.resolveUserAccountId(
        client,
        userAccount.ownerRef,
        userAccount.name,
        currency,
      );
    }
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

  /**
   * A user's account for one currency, created if this is their first posting.
   *
   * `on conflict do nothing` + a re-select rather than a check-then-insert:
   * two concurrent first-postings for the same user would both see no row and
   * both insert, and the unique index on (owner_ref, currency, name) is what
   * settles that. The returning-empty case is the loser of that race, and it
   * reads the winner's row.
   *
   * Typed `liability` because the balance is what the platform owes the user,
   * which is also what migration 0020's check constraint requires.
   */
  private async resolveUserAccountId(
    client: pg.PoolClient,
    ownerRef: string,
    name: string,
    currency: string,
  ): Promise<string> {
    const cacheKey = `${ownerRef}:${name}:${currency}`;
    const cached = this.accountIdCache.get(cacheKey);
    if (cached) return cached;

    const inserted = await client.query<{ id: string }>(
      `insert into ledger_accounts (type, currency, owner_ref, name)
       values ('liability', $1, $2, $3)
       on conflict (owner_ref, currency, name) do nothing
       returning id`,
      [currency, ownerRef, name],
    );
    let id = inserted.rows[0]?.id;

    if (!id) {
      const { rows } = await client.query<{ id: string }>(
        `select id from ledger_accounts
         where owner_ref = $1 and currency = $2 and name = $3`,
        [ownerRef, currency, name],
      );
      id = rows[0]?.id;
    }

    if (!id) {
      throw new Error(
        `Failed to resolve user ledger account '${name}' (${currency}) for ${ownerRef}`,
      );
    }
    this.accountIdCache.set(cacheKey, id);
    return id;
  }
}
