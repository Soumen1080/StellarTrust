/**
 * Ledger currency ↔ Soroban token (SAC) resolution.
 *
 * The ledger records money as minor-unit integer strings ("10000" = 100.00 for
 * a 2-dp currency). Soroban token contracts hold `i128` amounts scaled by the
 * token's own `decimals` (7 for a classic Stellar asset contract). Locking an
 * escrow means moving between those two representations exactly — a silent
 * off-by-10^5 here would lock the wrong amount of real value, so the
 * conversions are integer-only and reject anything they cannot represent.
 */
import { CurrencyCode, LEDGER_CURRENCY_DECIMALS } from "@stellartrust/shared";
import { config } from "../../config/index.js";
import { ChainError } from "../../lib/errors.js";

export interface TokenBinding {
  currency: CurrencyCode;
  /** `C…` address of the token contract holding this currency on-chain. */
  contractId: string;
  /** The token contract's own `decimals()`. Classic SAC assets use 7. */
  decimals: number;
}

/**
 * Decimal places the *ledger* uses for each currency's minor unit. Re-exported
 * from `@stellartrust/shared` so the frontend's amount parsing and this
 * module's on-chain conversion never disagree about the ledger's own scale.
 */
const LEDGER_MINOR_DECIMALS = LEDGER_CURRENCY_DECIMALS;

/**
 * Resolve the token contract backing a ledger currency. Fails closed: an
 * unconfigured currency must not fall back to "some other token".
 */
export function resolveToken(currency: CurrencyCode): TokenBinding {
  const binding = config.STELLAR_TOKEN_CONTRACTS[currency];
  if (!binding) {
    throw new ChainError(
      `No Soroban token contract is configured for ${currency}. ` +
        "Set STELLAR_TOKEN_CONTRACTS before enabling on-chain escrow for it.",
    );
  }
  return { currency, ...binding };
}

/**
 * Reverse lookup: which ledger currency does this token contract back?
 *
 * Reading custody back gives us a token *address*, not a currency — the escrow
 * contract stores what it holds, not what our books call it. Without this the
 * amount in custody could not be expressed in ledger units at all, and
 * reconciliation would be left comparing state while ignoring value.
 *
 * Returns `undefined` for a token this deployment has no binding for, which is
 * itself a finding: custody is holding something we did not configure.
 */
export function tokenBindingByContractId(
  contractId: string,
): TokenBinding | undefined {
  for (const [currency, binding] of Object.entries(
    config.STELLAR_TOKEN_CONTRACTS,
  )) {
    if (binding.contractId === contractId) {
      return { currency: currency as CurrencyCode, ...binding };
    }
  }
  return undefined;
}

/**
 * Convert a ledger minor-unit amount to the token contract's `i128` scale.
 *
 * @throws ChainError if the amount is not a positive integer string, or if the
 *   token is coarser than the ledger (which would silently truncate value).
 */
export function toTokenAmount(
  minorUnits: string,
  token: TokenBinding,
): bigint {
  if (!/^\d+$/.test(minorUnits)) {
    throw new ChainError(
      `Amount ${minorUnits} is not a non-negative minor-unit integer`,
    );
  }
  const shift = token.decimals - LEDGER_MINOR_DECIMALS[token.currency];
  if (shift < 0) {
    throw new ChainError(
      `Token for ${token.currency} has ${token.decimals} decimals but the ` +
        `ledger records ${LEDGER_MINOR_DECIMALS[token.currency]}; converting ` +
        "would truncate value",
    );
  }
  const amount = BigInt(minorUnits) * 10n ** BigInt(shift);
  if (amount <= 0n) {
    throw new ChainError("On-chain escrow amount must be greater than zero");
  }
  return amount;
}

/**
 * Convert a token `i128` amount back to ledger minor units.
 *
 * @throws ChainError if the on-chain amount carries precision the ledger
 *   cannot represent — reconciliation must surface that, not round it away.
 */
export function fromTokenAmount(
  amount: bigint,
  token: TokenBinding,
): string {
  const shift = token.decimals - LEDGER_MINOR_DECIMALS[token.currency];
  const divisor = 10n ** BigInt(Math.max(shift, 0));
  if (amount % divisor !== 0n) {
    throw new ChainError(
      `On-chain amount ${amount} cannot be expressed in ${token.currency} ` +
        "minor units without losing precision",
    );
  }
  return (amount / divisor).toString();
}
