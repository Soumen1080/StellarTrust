/**
 * Ledger persistence boundary.
 *
 * The interface is what the service depends on. Phase 0 ships an in-memory
 * implementation for local/dev + tests; a Postgres/Supabase-backed repository
 * (using DB transactions + the CHECK constraints in the migration) replaces it
 * without changing the service.
 */
import { randomUUID } from "node:crypto";
import { EntryDirection, type CurrencyCode } from "@stellartrust/shared";
import { ConflictError } from "../../lib/errors.js";
import { isUserAccountRef, parseUserAccountRef } from "./user-accounts.js";
import type {
  LedgerTransactionInput,
  PersistedLedgerEntry,
  PersistedLedgerTransaction,
} from "./ledger.types.js";

/**
 * A single account's position (plane.md §4.5).
 *
 * `balance` is in the account's natural direction — credits − debits for a
 * liability (which every user account is), debits − credits for an asset — so
 * it always reads as "how much this account holds". Minor units, as a string,
 * because a balance that passes through a float is a balance that can be
 * rounded past a cap.
 */
export interface AccountBalance {
  ownerRef: string;
  name: string;
  currency: CurrencyCode;
  balance: string;
  totalDebits: string;
  totalCredits: string;
  entryCount: number;
  lastEntryAt: string | null;
}

export interface LedgerRepository {
  /** Persist a already-validated, balanced transaction atomically. */
  insertTransaction(
    input: LedgerTransactionInput,
  ): Promise<PersistedLedgerTransaction>;
  findByReferenceId(
    referenceId: string,
  ): Promise<PersistedLedgerTransaction | undefined>;
  /**
   * Every balance owned by `ownerRef` (e.g. `user:<id>`), one per currency.
   *
   * Returns an empty list for an owner who has never transacted — that is a
   * zero balance, not a missing account, and forcing callers to distinguish
   * the two would make "can this user afford it?" a three-way answer.
   */
  listBalances(ownerRef: string): Promise<AccountBalance[]>;
  /** One owner's balance in one currency; zero when nothing has posted. */
  getBalance(ownerRef: string, currency: CurrencyCode): Promise<string>;
}

export class InMemoryLedgerRepository implements LedgerRepository {
  private readonly byId = new Map<string, PersistedLedgerTransaction>();
  private readonly byReference = new Map<string, string>();

  async insertTransaction(
    input: LedgerTransactionInput,
  ): Promise<PersistedLedgerTransaction> {
    if (this.byReference.has(input.referenceId)) {
      // Reference ids are unique — mirrors the DB uniqueness constraint that
      // prevents double-posting the same money movement.
      throw new ConflictError(
        `Ledger transaction with referenceId "${input.referenceId}" already exists`,
      );
    }

    const transactionId = randomUUID();
    const createdAt = new Date().toISOString();
    const entries: PersistedLedgerEntry[] = input.entries.map((e) => ({
      id: randomUUID(),
      transactionId,
      accountId: e.accountId,
      direction: e.direction,
      amount: e.amount,
      currency: e.currency,
      createdAt,
    }));

    const tx: PersistedLedgerTransaction = {
      id: transactionId,
      referenceId: input.referenceId,
      description: input.description,
      entries,
      createdAt,
    };

    this.byId.set(transactionId, tx);
    this.byReference.set(input.referenceId, transactionId);
    return tx;
  }

  async findByReferenceId(
    referenceId: string,
  ): Promise<PersistedLedgerTransaction | undefined> {
    const id = this.byReference.get(referenceId);
    return id ? this.byId.get(id) : undefined;
  }

  /**
   * Balances are derived by walking the entries, exactly as the Postgres
   * `ledger_account_balances` view derives them from the same rows. Rules.md
   * §2: a deterministic adapter must behave exactly as the real one — a cached
   * running total here would diverge the moment a test posted through a path
   * that forgot to update it.
   */
  async listBalances(ownerRef: string): Promise<AccountBalance[]> {
    const byCurrency = new Map<string, AccountBalance>();

    for (const tx of this.byId.values()) {
      for (const entry of tx.entries) {
        const parsed = parseUserAccountRef(entry.accountId);
        if (!parsed || parsed.ownerRef !== ownerRef) continue;

        const key = `${parsed.name}:${entry.currency}`;
        let account = byCurrency.get(key);
        if (!account) {
          account = {
            ownerRef,
            name: parsed.name,
            currency: entry.currency,
            balance: "0",
            totalDebits: "0",
            totalCredits: "0",
            entryCount: 0,
            lastEntryAt: null,
          };
          byCurrency.set(key, account);
        }

        const amount = BigInt(entry.amount);
        // Every user account is a liability (enforced by the 0020 check), so
        // the balance rises on the credit side.
        const signed = entry.direction === EntryDirection.Credit ? amount : -amount;
        account.balance = (BigInt(account.balance) + signed).toString();
        if (entry.direction === EntryDirection.Debit) {
          account.totalDebits = (
            BigInt(account.totalDebits) + amount
          ).toString();
        } else {
          account.totalCredits = (
            BigInt(account.totalCredits) + amount
          ).toString();
        }
        account.entryCount += 1;
        if (!account.lastEntryAt || entry.createdAt > account.lastEntryAt) {
          account.lastEntryAt = entry.createdAt;
        }
      }
    }

    return [...byCurrency.values()].sort((a, b) =>
      a.currency.localeCompare(b.currency),
    );
  }

  async getBalance(
    ownerRef: string,
    currency: CurrencyCode,
  ): Promise<string> {
    const balances = await this.listBalances(ownerRef);
    return (
      balances.find((account) => account.currency === currency)?.balance ?? "0"
    );
  }
}

export { isUserAccountRef };
