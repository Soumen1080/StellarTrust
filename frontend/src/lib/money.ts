/**
 * Ledger minor-unit ↔ major-amount conversion for order amount fields.
 *
 * String-based (no float math): a naive `Number(amount) * 10 ** decimals`
 * drifts for XLM's 7dp scale the same way it would for currency in general.
 * Must use {@link LEDGER_CURRENCY_DECIMALS}, not `CURRENCY_SCALE` — see that
 * constant's doc comment for why the two currently disagree for USDC.
 */
import { LEDGER_CURRENCY_DECIMALS, type CurrencyCode } from "@stellartrust/shared";

/** Parse a user-entered major amount (e.g. "12.5") into a minor-unit integer string. */
export function toMinorUnits(
  major: string,
  currency: CurrencyCode,
): string | null {
  const decimals = LEDGER_CURRENCY_DECIMALS[currency];
  const match = /^(\d+)(?:\.(\d+))?$/.exec(major.trim());
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  if (fraction.length > decimals) return null;
  const minorUnits = whole + fraction.padEnd(decimals, "0");
  // Strip leading zeros but keep at least one digit.
  const normalized = minorUnits.replace(/^0+(?=\d)/, "");
  return normalized === "" ? "0" : normalized;
}

/** Format a ledger minor-unit integer string as a major-amount number for display. */
export function fromMinorUnits(minor: string, currency: CurrencyCode): number {
  const decimals = LEDGER_CURRENCY_DECIMALS[currency];
  const padded = minor.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = decimals > 0 ? padded.slice(-decimals) : "";
  return Number(`${whole}${fraction ? `.${fraction}` : ""}`);
}
