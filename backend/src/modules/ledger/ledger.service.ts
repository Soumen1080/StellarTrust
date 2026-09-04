/**
 * Ledger service — the only sanctioned way to record money movement.
 *
 * Golden Rule #1: every money movement writes a *balanced* double-entry set.
 * The service refuses to persist anything that does not balance, so an
 * unbalanced write can never reach the store.
 */
import {
  ledgerTransactionInputSchema,
  type CurrencyCode,
} from "@stellartrust/shared";
import { ValidationError } from "../../lib/errors.js";
import { assertBalanced } from "./ledger.balance.js";
import type {
  AccountBalance,
  LedgerRepository,
} from "./ledger.repository.js";
import type {
  LedgerTransactionInput,
  PersistedLedgerTransaction,
} from "./ledger.types.js";
import { userCashAccount } from "./user-accounts.js";

/**
 * Raised when a user-funded operation would take an account below zero
 * (plane.md §4.5). Carries the shortfall so the caller can say how much is
 * missing rather than only that something is.
 */
export class InsufficientFundsError extends ValidationError {
  constructor(
    readonly currency: CurrencyCode,
    readonly available: string,
    readonly required: string,
  ) {
    super(
      `Insufficient balance: ${required} ${currency} required, ${available} available`,
    );
    this.name = "InsufficientFundsError";
  }
}

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

  // ── Per-user balances (plane.md §4.5) ─────────────────────────────────────

  /** Every currency balance the user holds. Empty means they hold nothing. */
  async listUserBalances(userId: string): Promise<AccountBalance[]> {
    return this.repo.listBalances(`user:${userId}`);
  }

  /** One user's spendable balance in one currency, in minor units. */
  async getUserBalance(
    userId: string,
    currency: CurrencyCode,
  ): Promise<bigint> {
    return BigInt(await this.repo.getBalance(`user:${userId}`, currency));
  }

  /**
   * Refuse an operation the user cannot fund.
   *
   * Called *before* any money moves, so a refused operation leaves nothing to
   * unwind — the same ordering §3.2 uses for its investor limits. Amounts are
   * bigint throughout: a balance compared in floating point is a balance that
   * rounding can step over.
   */
  async assertSufficientFunds(
    userId: string,
    currency: CurrencyCode,
    required: bigint,
  ): Promise<void> {
    if (required <= 0n) return;
    const available = await this.getUserBalance(userId, currency);
    if (available < required) {
      throw new InsufficientFundsError(
        currency,
        available.toString(),
        required.toString(),
      );
    }
  }

  /** The account reference a user's cash postings address. */
  userAccount(userId: string): string {
    return userCashAccount(userId);
  }
}
