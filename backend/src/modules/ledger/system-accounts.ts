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

/**
 * Cross-border settlement accounts (migration 0011 seeds).
 *
 * These use their own `b0…` prefix: the settlement module previously posted
 * against `a0…0003`/`a0…0004`, which are the RWA payout accounts above. In
 * memory that was invisible; resolved against the real chart of accounts it
 * would have posted FX conversions into the RWA payout reserve.
 */
export const SETTLEMENT_SOURCE_ANCHOR_CLEARING =
  "b0000000-0000-4000-8000-000000000001";
export const SETTLEMENT_USER_SOURCE_LIABILITY =
  "b0000000-0000-4000-8000-000000000002";
export const SETTLEMENT_FX_CONVERSION = "b0000000-0000-4000-8000-000000000003";
export const SETTLEMENT_USER_DEST_LIABILITY =
  "b0000000-0000-4000-8000-000000000004";
export const SETTLEMENT_DEST_ANCHOR_CLEARING =
  "b0000000-0000-4000-8000-000000000005";
export const SETTLEMENT_LIQUIDITY_FEE_REVENUE =
  "b0000000-0000-4000-8000-000000000006";
/** Flat local-rail fee (UPI/IMPS/SEPA/ACH/NIP) retained on the payout leg. */
export const SETTLEMENT_PAYOUT_FEE_REVENUE =
  "b0000000-0000-4000-8000-000000000007";

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
    [SETTLEMENT_SOURCE_ANCHOR_CLEARING]: "settlement_source_anchor_clearing",
    [SETTLEMENT_USER_SOURCE_LIABILITY]: "settlement_user_source_liability",
    [SETTLEMENT_FX_CONVERSION]: "settlement_fx_conversion",
    [SETTLEMENT_USER_DEST_LIABILITY]: "settlement_user_dest_liability",
    [SETTLEMENT_DEST_ANCHOR_CLEARING]: "settlement_dest_anchor_clearing",
    [SETTLEMENT_LIQUIDITY_FEE_REVENUE]: "settlement_liquidity_fee_revenue",
    [SETTLEMENT_PAYOUT_FEE_REVENUE]: "settlement_payout_fee_revenue",
  });

/** The seeded account name for a synthetic id, or a named failure. */
export function systemAccountName(syntheticId: string): string {
  const name = SYNTHETIC_ACCOUNT_NAME[syntheticId];
  if (!name) {
    throw new Error(`Unknown ledger account id ${syntheticId}`);
  }
  return name;
}
