import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { CurrencyCode, EntryDirection } from "@stellartrust/shared";
import { LedgerError } from "../../lib/errors.js";
import { assertBalanced, isBalanced } from "./ledger.balance.js";
import { InMemoryLedgerRepository } from "./ledger.repository.js";
import { LedgerService } from "./ledger.service.js";
import type { LedgerEntryInput } from "./ledger.types.js";

const acctA = randomUUID();
const acctB = randomUUID();

function entry(
  accountId: string,
  direction: (typeof EntryDirection)[keyof typeof EntryDirection],
  amount: string,
  currency = CurrencyCode.USD,
): LedgerEntryInput {
  return { accountId, direction, amount, currency };
}

describe("assertBalanced", () => {
  it("accepts a balanced debit/credit pair", () => {
    const entries = [
      entry(acctA, EntryDirection.Debit, "10000"),
      entry(acctB, EntryDirection.Credit, "10000"),
    ];
    const summary = assertBalanced(entries);
    expect(summary.perCurrencyNet[CurrencyCode.USD]).toBe("0");
    expect(isBalanced(entries)).toBe(true);
  });

  it("accepts a balanced split across multiple legs", () => {
    const entries = [
      entry(acctA, EntryDirection.Debit, "10000"),
      entry(acctB, EntryDirection.Credit, "7000"),
      entry(randomUUID(), EntryDirection.Credit, "3000"),
    ];
    expect(() => assertBalanced(entries)).not.toThrow();
  });

  it("rejects an unbalanced pair (debits != credits)", () => {
    const entries = [
      entry(acctA, EntryDirection.Debit, "10000"),
      entry(acctB, EntryDirection.Credit, "9999"),
    ];
    expect(() => assertBalanced(entries)).toThrow(LedgerError);
    expect(isBalanced(entries)).toBe(false);
  });

  it("rejects a single-entry transaction", () => {
    const entries = [entry(acctA, EntryDirection.Debit, "10000")];
    expect(() => assertBalanced(entries)).toThrow(LedgerError);
  });

  it("rejects all-debits (no credit side)", () => {
    const entries = [
      entry(acctA, EntryDirection.Debit, "5000"),
      entry(acctB, EntryDirection.Debit, "5000"),
    ];
    expect(() => assertBalanced(entries)).toThrow(LedgerError);
  });

  it("requires balance per-currency independently", () => {
    const entries = [
      entry(acctA, EntryDirection.Debit, "10000", CurrencyCode.USD),
      entry(acctB, EntryDirection.Credit, "10000", CurrencyCode.USD),
      entry(acctA, EntryDirection.Debit, "5000", CurrencyCode.EUR),
      entry(acctB, EntryDirection.Credit, "4000", CurrencyCode.EUR),
    ];
    expect(() => assertBalanced(entries)).toThrow(/EUR/);
  });

  it("rejects zero and non-integer amounts", () => {
    expect(() =>
      assertBalanced([
        entry(acctA, EntryDirection.Debit, "0"),
        entry(acctB, EntryDirection.Credit, "0"),
      ]),
    ).toThrow(LedgerError);
    expect(() =>
      assertBalanced([
        entry(acctA, EntryDirection.Debit, "10.5"),
        entry(acctB, EntryDirection.Credit, "10.5"),
      ]),
    ).toThrow(LedgerError);
  });

  it("handles large amounts without float drift (BigInt)", () => {
    const big = "9007199254740993"; // > Number.MAX_SAFE_INTEGER
    expect(() =>
      assertBalanced([
        entry(acctA, EntryDirection.Debit, big),
        entry(acctB, EntryDirection.Credit, big),
      ]),
    ).not.toThrow();
  });
});

describe("LedgerService.record", () => {
  it("persists a balanced transaction", async () => {
    const service = new LedgerService(new InMemoryLedgerRepository());
    const tx = await service.record({
      referenceId: `ref-${randomUUID()}`,
      description: "buyer deposit into escrow",
      entries: [
        entry(acctA, EntryDirection.Debit, "10000"),
        entry(acctB, EntryDirection.Credit, "10000"),
      ],
    });
    expect(tx.id).toBeDefined();
    expect(tx.entries).toHaveLength(2);
  });

  it("refuses to persist an unbalanced transaction", async () => {
    const service = new LedgerService(new InMemoryLedgerRepository());
    await expect(
      service.record({
        referenceId: `ref-${randomUUID()}`,
        description: "bad write",
        entries: [
          entry(acctA, EntryDirection.Debit, "10000"),
          entry(acctB, EntryDirection.Credit, "1"),
        ],
      }),
    ).rejects.toBeInstanceOf(LedgerError);
  });

  it("rejects duplicate referenceId (no double-posting)", async () => {
    const service = new LedgerService(new InMemoryLedgerRepository());
    const referenceId = `ref-${randomUUID()}`;
    const entries = [
      entry(acctA, EntryDirection.Debit, "10000"),
      entry(acctB, EntryDirection.Credit, "10000"),
    ];
    await service.record({ referenceId, description: "first", entries });
    await expect(
      service.record({ referenceId, description: "dup", entries }),
    ).rejects.toThrow();
  });
});
