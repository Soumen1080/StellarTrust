/**
 * Synthetic system-account ids ↔ the seeded chart of accounts.
 *
 * Services post ledger entries against fixed, currency-agnostic ids (one per
 * account "role"). The real chart in Postgres is currency-specific —
 * `ledger_accounts` is unique on (owner_ref, currency, name) — so each
 * synthetic id maps to a system account NAME, resolved to a concrete
 * per-currency account id at write time.
 *
 * The mapping lives here rather than inside one repository because two modules
 * post through it (payments and RWA payouts) and both need the same table. A
 * per-repository copy is how one of them ends up unable to resolve the other's
 * accounts.
 *
 * Names match the seeds in migrations 0002 (base), 0004 (payments), and 0006
 * (RWA).
 */

/** Payment/escrow accounts (migration 0004 seeds). */
export const COMMITMENT_ASSET = "10000000-0000-4000-8000-000000000001";
export const COMMITMENT_LIABILITY = "20000000-0000-4000-8000-000000000002";
export const CASH_CLEARING = "30000000-0000-4000-8000-000000000003";
export const ESCROW_HOLDING = "40000000-0000-4000-8000-000000000004";
export const CONTRACT_CUSTODY = "50000000-0000-4000-8000-000000000005";
export const DELIVERY_ASSET = "60000000-0000-4000-8000-000000000006";
export const DELIVERY_LIABILITY = "70000000-0000-4000-8000-000000000007";

/** RWA payout accounts (migration 0006 seeds). */
export const RWA_PAYOUT_PAYABLE = "a0000000-0000-4000-8000-000000000003";
export const RWA_PAYOUT_RESERVE = "a0000000-0000-4000-8000-000000000004";

export const SYNTHETIC_ACCOUNT_NAME: Readonly<Record<string, string>> =
  Object.freeze({
    [COMMITMENT_ASSET]: "commitment_asset",
    [COMMITMENT_LIABILITY]: "commitment_liability",
    [CASH_CLEARING]: "cash_clearing",
    [ESCROW_HOLDING]: "escrow_holding",
    [CONTRACT_CUSTODY]: "contract_custody",
    [DELIVERY_ASSET]: "delivery_confirmation_asset",
    [DELIVERY_LIABILITY]: "delivery_confirmation_liability",
    [RWA_PAYOUT_PAYABLE]: "rwa_payout_payable",
    [RWA_PAYOUT_RESERVE]: "rwa_payout_reserve",
  });

/** The seeded account name for a synthetic id, or a named failure. */
export function systemAccountName(syntheticId: string): string {
  const name = SYNTHETIC_ACCOUNT_NAME[syntheticId];
  if (!name) {
    throw new Error(`Unknown ledger account id ${syntheticId}`);
  }
  return name;
}
