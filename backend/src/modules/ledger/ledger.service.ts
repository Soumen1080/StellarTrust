/**
 * Ledger service — the only sanctioned way to record money movement.
 *
 * Golden Rule #1: every money movement writes a *balanced* double-entry set.
 * The service refuses to persist anything that does not balance, so an
 * unbalanced write can never reach the store.
 */
import { ledgerTransactionInputSchema } from "@stellartrust/shared";
import { ValidationError } from "../../lib/errors.js";
import { assertBalanced } from "./ledger.balance.js";
import type { LedgerRepository } from "./ledger.repository.js";
import type {
  LedgerTransactionInput,
  PersistedLedgerTransaction,
} from "./ledger.types.js";

export class LedgerService {
  constructor(private readonly repo: LedgerRepository) {}

  /**
   * Validate + balance-check + persist a ledger transaction.
   * Throws ValidationError for malformed input, LedgerError for unbalanced sets.
   */
  async record(
    input: LedgerTransactionInput,
  ): Promise<PersistedLedgerTransaction> {
    const parsed = ledgerTransactionInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        "Invalid ledger transaction",
        parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      );
    }

    // Hard gate: reject unbalanced transactions before any persistence.
    assertBalanced(parsed.data.entries);

    return this.repo.insertTransaction(parsed.data);
  }

  async getByReference(
    referenceId: string,
  ): Promise<PersistedLedgerTransaction | undefined> {
    return this.repo.findByReferenceId(referenceId);
  }
}
