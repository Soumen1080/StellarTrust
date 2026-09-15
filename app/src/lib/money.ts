/**
 * Ledger minor-unit ↔ major-amount conversion and display.
 *
 * String-based, never float: `Number(amount) * 10 ** decimals` drifts at XLM's
 * 7dp scale, and a drifting amount in a payments app is a wrong number on a
 * receipt. Ported from frontend/src/lib/money.ts so both clients round the
 * same way.
 *
 * Uses LEDGER_CURRENCY_DECIMALS, not CURRENCY_SCALE — see that constant's own
 * doc comment for why the two disagree for USDC.
 */
import {
  LEDGER_CURRENCY_DECIMALS,
  type CurrencyCode,
} from "@stellartrust/shared";

/** Parse a user-entered major amount ("12.5") into a minor-unit integer string. */
export function toMinorUnits(
  major: string,
  currency: CurrencyCode,
): string | null {
  const decimals = LEDGER_CURRENCY_DECIMALS[currency];
  const match = /^(\d+)(?:\.(\d+))?$/.exec(major.trim());
  if (!match) return null;
  const [, whole = "", fraction = ""] = match;
  if (fraction.length > decimals) return null;
  const minorUnits = whole + fraction.padEnd(decimals, "0");
  const normalized = minorUnits.replace(/^0+(?=\d)/, "");
  return normalized === "" ? "0" : normalized;
}

/** Format a minor-unit integer string as a major-amount number. */
export function fromMinorUnits(minor: string, currency: CurrencyCode): number {
  const decimals = LEDGER_CURRENCY_DECIMALS[currency];
  const padded = minor.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = decimals > 0 ? padded.slice(-decimals) : "";
  return Number(`${whole}${fraction ? `.${fraction}` : ""}`);
}

/**
 * A minor-unit amount as a grouped display string.
 *
 * Trailing zeros beyond two decimals are dropped: `1,250.00` reads as money,
 * `1,250.0000000` reads as a machine dump. The full precision is never lost —
 * it is still in the underlying string — this only governs presentation.
 */
export function formatAmount(
  minor: string,
  currency: CurrencyCode,
  options: { compact?: boolean } = {},
): string {
  const value = fromMinorUnits(minor, currency);
  const decimals = LEDGER_CURRENCY_DECIMALS[currency];

  if (options.compact && Math.abs(value) >= 10_000) {
    return new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  }

  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: Math.min(2, decimals),
    maximumFractionDigits: Math.min(
      Math.max(2, countSignificantDecimals(value, decimals)),
      decimals,
    ),
  }).format(value);
}

/** How many decimals this value actually uses, capped at the currency scale. */
function countSignificantDecimals(value: number, max: number): number {
  const text = value.toFixed(max);
  const trimmed = text.replace(/0+$/, "");
  const dot = trimmed.indexOf(".");
  return dot === -1 ? 0 : trimmed.length - dot - 1;
}

/** `formatAmount` with the currency code appended: "1,250.00 USDC". */
export function formatMoney(
  minor: string,
  currency: CurrencyCode,
  options: { compact?: boolean } = {},
): string {
  return `${formatAmount(minor, currency, options)} ${currency}`;
}

/**
 * Shorten a Stellar address or transaction hash for display.
 *
 * Keeps both ends: the leading character identifies the type (G account, C
 * contract, T transaction) and the tail is what a user compares against their
 * wallet. The middle carries no information a human uses.
 */
export function shortenAddress(value: string, visible = 4): string {
  if (value.length <= visible * 2 + 3) return value;
  return `${value.slice(0, visible)}…${value.slice(-visible)}`;
}

/** Relative time for a timestamp — "2m ago", "3d ago". */
export function timeAgo(iso: string): string {
  const elapsed = Date.now() - Date.parse(iso);
  if (!Number.isFinite(elapsed)) return "";
  const seconds = Math.round(elapsed / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Absolute timestamp for detail screens and receipts. */
export function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
