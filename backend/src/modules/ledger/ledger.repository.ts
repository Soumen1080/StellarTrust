/**
 * Ledger persistence boundary.
 *
 * The interface is what the service depends on. Phase 0 ships an in-memory
 * implementation for local/dev + tests; a Postgres/Supabase-backed repository
 * (using DB transactions + the CHECK constraints in the migration) replaces it
 * without changing the service.
 */
import { randomUUID } from "node:crypto";
import { ConflictError } from "../../lib/errors.js";
import type {
  LedgerTransactionInput,
  PersistedLedgerEntry,
  PersistedLedgerTransaction,
} from "./ledger.types.js";

export interface LedgerRepository {
  /** Persist a already-validated, balanced transaction atomically. */
  insertTransaction(
    input: LedgerTransactionInput,
  ): Promise<PersistedLedgerTransaction>;
  findByReferenceId(
    referenceId: string,
  ): Promise<PersistedLedgerTransaction | undefined>;
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
}
