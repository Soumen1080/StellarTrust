/**
 * Per-user ledger accounts (plane.md §4.5).
 *
 * The acceptance conditions the plan names: a balance reflects postings, and
 * an overdraw is refused. Both are asserted here against the *ordinary*
 * `LedgerService` over the in-memory repository — never the prefunded test
 * double, whose whole purpose is to make the refusal not fire.
 */
import { describe, expect, it } from "vitest";
import { EntryDirection, type CurrencyCode } from "@stellartrust/shared";
import {
  InsufficientFundsError,
  LedgerService,
} from "./ledger.service.js";
import { InMemoryLedgerRepository } from "./ledger.repository.js";
import { CASH_CLEARING, ESCROW_HOLDING } from "./system-accounts.js";
import {
  isUserAccountRef,
  parseUserAccountRef,
  userCashAccount,
} from "./user-accounts.js";

const USDC = "USDC" as CurrencyCode;
const XLM = "XLM" as CurrencyCode;

function setup() {
  return new LedgerService(new InMemoryLedgerRepository());
}

/** The two legs a deposit posts: platform cash in, user credited. */
async function credit(
  ledger: LedgerService,
  userId: string,
  amount: string,
  currency: CurrencyCode = USDC,
  reference = `deposit:${userId}:${currency}:${amount}`,
): Promise<void> {
  await ledger.record({
    referenceId: reference,
    description: `Deposit for ${userId}`,
    entries: [
      {
        accountId: CASH_CLEARING,
        direction: EntryDirection.Debit,
        amount,
        currency,
      },
      {
        accountId: ledger.userAccount(userId),
        direction: EntryDirection.Credit,
        amount,
        currency,
      },
    ],
  });
}

describe("user account references", () => {
  it("names one account per user", () => {
    expect(userCashAccount("user-1")).toBe("user:user-1/user_cash");
  });

  it("does not mistake a system account uuid for a user account", () => {
    // The two address spaces share one field on a ledger entry. A UUID
    // contains no "/", which is what keeps them apart.
    expect(isUserAccountRef(CASH_CLEARING)).toBe(false);
    expect(parseUserAccountRef(CASH_CLEARING)).toBeUndefined();
  });

  it("splits a reference into the columns the accounts table is keyed on", () => {
    expect(parseUserAccountRef("user:abc/user_cash")).toEqual({
      ownerRef: "user:abc",
      userId: "abc",
      name: "user_cash",
    });
  });

  it("refuses a reference with no owner or no account name", () => {
    expect(parseUserAccountRef("user:/user_cash")).toBeUndefined();
    expect(parseUserAccountRef("user:abc/")).toBeUndefined();
  });
});

describe("a balance reflects postings", () => {
  it("is zero for a user who has never transacted", async () => {
    const ledger = setup();
    expect(await ledger.getUserBalance("nobody", USDC)).toBe(0n);
    expect(await ledger.listUserBalances("nobody")).toEqual([]);
  });

  it("rises on a credit and falls on a debit", async () => {
    const ledger = setup();
    await credit(ledger, "investor-1", "10000");
    expect(await ledger.getUserBalance("investor-1", USDC)).toBe(10_000n);

    // Spending: a user account is a liability, so a debit reduces it.
    await ledger.record({
      referenceId: "spend:1",
      description: "Purchase",
      entries: [
        {
          accountId: ledger.userAccount("investor-1"),
          direction: EntryDirection.Debit,
          amount: "3000",
          currency: USDC,
        },
        {
          accountId: ESCROW_HOLDING,
          direction: EntryDirection.Credit,
          amount: "3000",
          currency: USDC,
        },
      ],
    });
    expect(await ledger.getUserBalance("investor-1", USDC)).toBe(7_000n);
  });

  it("keeps each user's balance to themselves", async () => {
    const ledger = setup();
    await credit(ledger, "investor-1", "10000");
    await credit(ledger, "investor-2", "500");

    expect(await ledger.getUserBalance("investor-1", USDC)).toBe(10_000n);
    expect(await ledger.getUserBalance("investor-2", USDC)).toBe(500n);
  });

  it("keeps each currency separate", async () => {
    const ledger = setup();
    await credit(ledger, "investor-1", "10000", USDC);
    await credit(ledger, "investor-1", "70000000", XLM);

    expect(await ledger.getUserBalance("investor-1", USDC)).toBe(10_000n);
    expect(await ledger.getUserBalance("investor-1", XLM)).toBe(70_000_000n);

    const balances = await ledger.listUserBalances("investor-1");
    expect(balances.map((b) => b.currency).sort()).toEqual(["USDC", "XLM"]);
  });

  it("reports the debit and credit totals behind the balance", async () => {
    const ledger = setup();
    await credit(ledger, "investor-1", "10000");
    await ledger.record({
      referenceId: "spend:2",
      description: "Purchase",
      entries: [
        {
          accountId: ledger.userAccount("investor-1"),
          direction: EntryDirection.Debit,
          amount: "2500",
          currency: USDC,
        },
        {
          accountId: ESCROW_HOLDING,
          direction: EntryDirection.Credit,
          amount: "2500",
          currency: USDC,
        },
      ],
    });

    const [account] = await ledger.listUserBalances("investor-1");
    expect(account).toMatchObject({
      balance: "7500",
      totalCredits: "10000",
      totalDebits: "2500",
      entryCount: 2,
    });
  });
});

describe("an overdraw is refused", () => {
  it("allows spending exactly the balance", async () => {
    const ledger = setup();
    await credit(ledger, "investor-1", "10000");
    await expect(
      ledger.assertSufficientFunds("investor-1", USDC, 10_000n),
    ).resolves.toBeUndefined();
  });

  it("refuses one minor unit more than the balance", async () => {
    const ledger = setup();
    await credit(ledger, "investor-1", "10000");
    await expect(
      ledger.assertSufficientFunds("investor-1", USDC, 10_001n),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it("refuses a user with no balance at all", async () => {
    const ledger = setup();
    await expect(
      ledger.assertSufficientFunds("nobody", USDC, 1n),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it("names the shortfall so the caller can say how much is missing", async () => {
    const ledger = setup();
    await credit(ledger, "investor-1", "4000");
    await expect(
      ledger.assertSufficientFunds("investor-1", USDC, 10_000n),
    ).rejects.toMatchObject({ available: "4000", required: "10000" });
  });

  it("does not let a balance in one currency fund a purchase in another", async () => {
    const ledger = setup();
    await credit(ledger, "investor-1", "10000000", XLM);
    await expect(
      ledger.assertSufficientFunds("investor-1", USDC, 1n),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it("permits a zero-amount check without consulting a balance", async () => {
    // Callers pass whatever the operation costs; an operation that costs
    // nothing must not be refused for want of an account that never existed.
    const ledger = setup();
    await expect(
      ledger.assertSufficientFunds("nobody", USDC, 0n),
    ).resolves.toBeUndefined();
  });
});
