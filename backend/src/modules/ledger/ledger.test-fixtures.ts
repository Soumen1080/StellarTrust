/**
 * Ledger test fixtures.
 *
 * Since plane.md §4.5 every user-funded operation refuses a user who cannot
 * pay. That is the behaviour the platform wanted, and it means a test whose
 * subject is something else — a lifecycle transition, a reconciliation sweep,
 * an event replay — now fails for a reason that has nothing to do with what it
 * asserts.
 *
 * {@link PrefundedLedgerService} solves that without weakening the check: it is
 * a real {@link LedgerService} over a real repository, with an opening balance
 * credited to each user the first time their funds are examined. The
 * insufficient-funds path still runs, still reads a real balance derived from
 * real entries, and still throws when the balance is short — a test can prove
 * that by funding less than it spends.
 *
 * What it is *not* is a stub that answers "yes". A test asserting the refusal
 * (`rwa.protection.test.ts`) uses the ordinary `LedgerService` and funds
 * deliberately, which is the only way that assertion means anything.
 */
import { EntryDirection, type CurrencyCode } from "@stellartrust/shared";
import { LedgerService } from "./ledger.service.js";
import {
  InMemoryLedgerRepository,
  type LedgerRepository,
} from "./ledger.repository.js";
import { CASH_CLEARING } from "./system-accounts.js";

/**
 * The opening balance each user is given. Large enough that no fixture
 * purchase is refused for want of funds, and an ordinary integer so a test
 * that does assert on a balance reads a round number.
 */
export const OPENING_BALANCE = "100000000000";

export class PrefundedLedgerService extends LedgerService {
  private readonly funded = new Set<string>();

  constructor(
    repository: LedgerRepository = new InMemoryLedgerRepository(),
    private readonly openingBalance = OPENING_BALANCE,
  ) {
    super(repository);
  }

  /**
   * Credit the opening balance the first time this user's funds are examined,
   * then defer to the real check.
   *
   * Funding lazily rather than up-front is what keeps this usable: a test names
   * its actors by string id and never registers them anywhere, so there is no
   * list of users to fund at construction.
   */
  override async assertSufficientFunds(
    userId: string,
    currency: CurrencyCode,
    required: bigint,
  ): Promise<void> {
    await this.ensureOpeningBalance(userId, currency);
    return super.assertSufficientFunds(userId, currency, required);
  }

  /** Credit the opening balance explicitly, e.g. before reading a balance. */
  async ensureOpeningBalance(
    userId: string,
    currency: CurrencyCode,
  ): Promise<void> {
    const key = `${userId}:${currency}`;
    if (this.funded.has(key)) return;
    this.funded.add(key);
    await this.record({
      referenceId: `test-opening-balance:${key}`,
      description: `Opening test balance for ${userId}`,
      entries: [
        {
          accountId: CASH_CLEARING,
          direction: EntryDirection.Debit,
          amount: this.openingBalance,
          currency,
        },
        {
          accountId: this.userAccount(userId),
          direction: EntryDirection.Credit,
          amount: this.openingBalance,
          currency,
        },
      ],
    });
  }
}
