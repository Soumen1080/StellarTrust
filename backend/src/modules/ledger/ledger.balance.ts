/**
 * Double-entry balancing rules — the heart of Golden Rule #1.
 *
 * A ledger transaction is BALANCED iff, for every currency involved, the sum of
 * debit amounts equals the sum of credit amounts. Amounts are integer minor
 * units represented as strings and computed with BigInt to avoid float drift.
 *
 * These are pure functions with no I/O so they are trivially testable.
 */
import { EntryDirection } from "@stellartrust/shared";
import { LedgerError } from "../../lib/errors.js";
import type { LedgerEntryInput } from "./ledger.types.js";

function parseAmount(raw: string, index: number): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new LedgerError(
      `Entry ${index}: amount must be a non-negative integer string of minor units`,
    );
  }
  const value = BigInt(raw);
  if (value <= 0n) {
    throw new LedgerError(`Entry ${index}: amount must be greater than zero`);
  }
  return value;
}

export interface BalanceSummary {
  /** Net signed total per currency (debit positive, credit negative). Always 0 when balanced. */
  perCurrencyNet: Record<string, string>;
  debitTotal: Record<string, string>;
  creditTotal: Record<string, string>;
}

/**
 * Validates a set of entries is balanced. Throws {@link LedgerError} otherwise.
 * Requirements:
 *  - at least two entries
 *  - every amount is a positive integer (minor units)
 *  - for each currency, total debits === total credits
 *  - at least one debit and one credit exist
 */
export function assertBalanced(entries: LedgerEntryInput[]): BalanceSummary {
  if (entries.length < 2) {
    throw new LedgerError(
      "A balanced transaction requires at least two entries",
    );
  }

  const debit = new Map<string, bigint>();
  const credit = new Map<string, bigint>();

  entries.forEach((entry, index) => {
    const amount = parseAmount(entry.amount, index);
    const bucket = entry.direction === EntryDirection.Debit ? debit : credit;
    bucket.set(entry.currency, (bucket.get(entry.currency) ?? 0n) + amount);
  });

  if (debit.size === 0 || credit.size === 0) {
    throw new LedgerError(
      "A balanced transaction requires at least one debit and one credit",
    );
  }

  const currencies = new Set<string>([...debit.keys(), ...credit.keys()]);
  const perCurrencyNet: Record<string, string> = {};
  const debitTotal: Record<string, string> = {};
  const creditTotal: Record<string, string> = {};
  const unbalanced: string[] = [];

  for (const currency of currencies) {
    const d = debit.get(currency) ?? 0n;
    const c = credit.get(currency) ?? 0n;
    debitTotal[currency] = d.toString();
    creditTotal[currency] = c.toString();
    perCurrencyNet[currency] = (d - c).toString();
    if (d !== c) {
      unbalanced.push(
        `${currency}: debits=${d.toString()} credits=${c.toString()}`,
      );
    }
  }

  if (unbalanced.length > 0) {
    throw new LedgerError(
      `Unbalanced ledger transaction (debits must equal credits per currency): ${unbalanced.join("; ")}`,
    );
  }

  return { perCurrencyNet, debitTotal, creditTotal };
}

/** Non-throwing variant. */
export function isBalanced(entries: LedgerEntryInput[]): boolean {
  try {
    assertBalanced(entries);
    return true;
  } catch {
    return false;
  }
}
