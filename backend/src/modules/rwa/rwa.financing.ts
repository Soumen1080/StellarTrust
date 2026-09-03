/**
 * RWA financing arithmetic — discount / factoring model (plane.md §1.2).
 *
 * Pure functions over `bigint` minor units. No I/O, no clock, no randomness:
 * every input that varies is a parameter, so each rule below is testable in
 * isolation and the same numbers come out on a retry.
 *
 * ## The model
 *
 * An issuer sells a claim on a future payment (an invoice, a dated purchase
 * obligation) *below* its face value. Investors put up the advance now; when
 * the debtor pays, investors are repaid at face value. Their yield is the
 * difference — the discount. The share of face value that is *not* financed
 * stays with the seller as retained first-loss, which is what keeps the
 * seller's incentives aligned with the investors'.
 *
 *     face value            what the debtor owes at maturity
 *   × advance rate          the share actually financed          → principal
 *   × discount rate         the investor's yield on that principal
 *   × platform fee          the platform's take, paid after investors
 *
 * ## Why the arithmetic is integer-only
 *
 * Money here is minor units (cents, stroops) as `bigint`. A float would make
 * `0.1 + 0.2` a rounding incident in a ledger that a database constraint
 * requires to balance exactly. Every division below is integer division with an
 * explicitly chosen rounding direction, and every split that must sum to a
 * total distributes its remainder rather than dropping it.
 *
 * The recurring-coupon alternative was weighed and deferred — see plane.md
 * §8.1. Nothing here should grow a coupon concept without reading that first.
 */

import { ValidationError } from "../../lib/errors.js";

/** One basis point is 1/10000. */
export const BPS_DENOMINATOR = 10_000n;

/** Milliseconds in a day, for accrual measured in whole days. */
const MS_PER_DAY = 86_400_000;

/**
 * The financing terms of a tokenization, as exact integers.
 *
 * Mirrors the columns added in migration `0016`, converted from the DTO's
 * integer strings at the boundary.
 */
export interface FinancingTerms {
  /** What the debtor owes at maturity (minor units). */
  faceValue: bigint;
  /** Share of face value financed, in bps. 8000 = 80%. */
  advanceRateBps: bigint;
  /** Investor yield on the principal, in bps. */
  discountRateBps: bigint;
  /** Platform take, in bps of face value, paid after investors. */
  platformFeeBps: bigint;
}

/** How a collection is split, in the order the waterfall pays. */
export interface WaterfallSplit {
  /** Principal returned to investors. */
  investorPrincipal: bigint;
  /** Yield paid to investors on top of principal. */
  investorYield: bigint;
  /** Principal + yield — what the investor leg receives in total. */
  investorTotal: bigint;
  /** The platform's fee. */
  platformFee: bigint;
  /** What is left for the seller. Never negative. */
  sellerResidual: bigint;
  /**
   * True when the collection did not cover the full investor entitlement, so
   * the seller and platform received nothing and investors took a loss.
   */
  shortfall: bigint;
}

/**
 * Round-half-up integer division of a bps-scaled product.
 *
 * `(value * bps) / 10000` with the halfway case rounded up. Rounding *up* is
 * deliberate for amounts owed to investors: when a fraction of a minor unit is
 * unavoidable, the party carrying the risk gets it rather than the platform.
 */
export function applyBps(value: bigint, bps: bigint): bigint {
  if (value < 0n) {
    throw new ValidationError("Cannot apply a rate to a negative amount");
  }
  const scaled = value * bps;
  // +half before truncating turns floor into round-half-up for positives.
  return (scaled + BPS_DENOMINATOR / 2n) / BPS_DENOMINATOR;
}

/**
 * The principal investors are asked to put up: face value × advance rate.
 *
 * This is the amount the tokenization raises when fully subscribed, and
 * therefore the number `pricePerUnit × totalUnits` must reproduce exactly.
 */
export function principalFor(terms: FinancingTerms): bigint {
  return applyBps(terms.faceValue, terms.advanceRateBps);
}

/**
 * What the issuer receives at funding: principal less the investors' discount.
 *
 * The discount is taken up front — that *is* the factoring model. The investor
 * pays `principal` and is owed `principal + yield` at collection; the seller
 * receives `principal − yield` now, and the difference is reconciled out of the
 * face value when the debtor pays.
 */
export function issuerProceedsFor(terms: FinancingTerms): bigint {
  const principal = principalFor(terms);
  return principal - applyBps(principal, terms.discountRateBps);
}

/**
 * The unit price implied by the terms.
 *
 * Derived rather than accepted free-form: a price inconsistent with the terms
 * is the easiest way to end up with a waterfall that cannot be paid. Integer
 * division truncates, so `price × totalUnits` can fall a few minor units short
 * of the principal — {@link principalRoundingShortfall} reports that gap and
 * `validateTerms` refuses terms where it is not representable at all.
 */
export function pricePerUnitFor(
  terms: FinancingTerms,
  totalUnits: bigint,
): bigint {
  if (totalUnits <= 0n) {
    throw new ValidationError("Total units must be positive");
  }
  const price = principalFor(terms) / totalUnits;
  if (price <= 0n) {
    throw new ValidationError(
      "Financing terms imply a unit price below one minor unit; " +
        "reduce the unit count or raise the advance",
    );
  }
  return price;
}

/**
 * Minor units lost to truncation when the principal is divided into units.
 *
 * Always ≥ 0 and always < `totalUnits`. Surfaced rather than hidden so the
 * issuer sees the exact amount a full subscription will raise.
 */
export function principalRoundingShortfall(
  terms: FinancingTerms,
  totalUnits: bigint,
): bigint {
  return principalFor(terms) - pricePerUnitFor(terms, totalUnits) * totalUnits;
}

/**
 * Yield owed to investors, accruing past maturity.
 *
 * Up to maturity the yield is the flat contractual discount. After maturity it
 * keeps accruing at the same daily rate, because a debtor who pays late has had
 * the use of the money for longer and the investors have carried the risk for
 * longer. The extra comes out of the seller's residual first (see
 * {@link splitCollection}), which is the point: lateness costs the seller, not
 * the investors.
 *
 * @param termDays - contractual days from funding to maturity. Used to derive
 *   the daily rate; a non-positive term means no late accrual is defined and
 *   the flat discount stands.
 * @param daysLate - whole days past maturity at collection. Negative or zero
 *   means on time.
 */
export function investorYieldFor(
  terms: FinancingTerms,
  termDays: number,
  daysLate: number,
): bigint {
  const principal = principalFor(terms);
  const baseYield = applyBps(principal, terms.discountRateBps);

  if (daysLate <= 0 || termDays <= 0) return baseYield;

  // Daily accrual at the contractual rate. Computed from the base yield rather
  // than re-deriving a rate, so a zero-discount deal accrues nothing when late
  // — there is no rate to apply.
  const perDay = baseYield / BigInt(termDays);
  return baseYield + perDay * BigInt(daysLate);
}

/** Whole days between two instants, floored at zero. */
export function daysBetween(from: Date, to: Date): number {
  const diff = to.getTime() - from.getTime();
  if (!Number.isFinite(diff)) {
    throw new ValidationError("Invalid date in accrual window");
  }
  return diff <= 0 ? 0 : Math.floor(diff / MS_PER_DAY);
}

/**
 * Split a collected amount across the waterfall.
 *
 * Strict priority: investors are made whole before the platform earns anything,
 * and the platform before the seller sees a residual. That ordering is the
 * investor protection — it is what makes the seller's retained share genuinely
 * first-loss rather than a label.
 *
 * A partial collection therefore pays investors as far as it reaches and leaves
 * the platform and seller with nothing. `shortfall` reports what investors did
 * not receive, which is the input to the default/write-off path (plane.md
 * §1.4).
 *
 * @param collected - what actually arrived. May be less than face value.
 */
export function splitCollection(
  terms: FinancingTerms,
  collected: bigint,
  options: { termDays?: number; daysLate?: number } = {},
): WaterfallSplit {
  if (collected < 0n) {
    throw new ValidationError("Collected amount cannot be negative");
  }

  const principal = principalFor(terms);
  const yieldOwed = investorYieldFor(
    terms,
    options.termDays ?? 0,
    options.daysLate ?? 0,
  );
  const investorEntitlement = principal + yieldOwed;

  // ── Leg 1: investors, in full or as far as the collection reaches ────────
  if (collected < investorEntitlement) {
    const investorPrincipal = collected < principal ? collected : principal;
    const investorYield = collected - investorPrincipal;
    return {
      investorPrincipal,
      investorYield,
      investorTotal: collected,
      platformFee: 0n,
      sellerResidual: 0n,
      shortfall: investorEntitlement - collected,
    };
  }

  // ── Leg 2: the platform, from what remains ───────────────────────────────
  const afterInvestors = collected - investorEntitlement;
  const platformFeeOwed = applyBps(terms.faceValue, terms.platformFeeBps);
  const platformFee =
    afterInvestors < platformFeeOwed ? afterInvestors : platformFeeOwed;

  // ── Leg 3: the seller keeps whatever is left ─────────────────────────────
  return {
    investorPrincipal: principal,
    investorYield: yieldOwed,
    investorTotal: investorEntitlement,
    platformFee,
    sellerResidual: afterInvestors - platformFee,
    shortfall: 0n,
  };
}

/**
 * Distribute an amount pro-rata across holders without losing a minor unit.
 *
 * Integer division truncates, so the naive per-holder shares sum to less than
 * the total. The remainder is handed out one minor unit at a time to the
 * largest holdings first (largest-remainder method), which is deterministic,
 * order-independent for equal holdings, and — critically — makes the result sum
 * to exactly `amount`. A ledger transaction whose legs do not sum to the total
 * is rejected by the database, so "close enough" is not available here.
 *
 * @param holders - units held. Zero-unit holders receive nothing.
 * @returns shares in the same order as `holders`, summing to exactly `amount`.
 */
export function proRataShares(
  holders: readonly bigint[],
  amount: bigint,
): bigint[] {
  if (amount < 0n) {
    throw new ValidationError("Cannot distribute a negative amount");
  }
  const totalUnits = holders.reduce((sum, units) => sum + units, 0n);
  if (totalUnits <= 0n) {
    return holders.map(() => 0n);
  }

  const shares = holders.map((units) => (units * amount) / totalUnits);
  let remainder = amount - shares.reduce((sum, share) => sum + share, 0n);

  // Rank by the size of the truncated fraction, tie-broken by holding size and
  // then by index, so the outcome never depends on Array.sort's stability.
  const ranked = holders
    .map((units, index) => ({
      index,
      fraction: (units * amount) % totalUnits,
      units,
    }))
    .sort(
      (a, b) =>
        (b.fraction > a.fraction ? 1 : b.fraction < a.fraction ? -1 : 0) ||
        (b.units > a.units ? 1 : b.units < a.units ? -1 : 0) ||
        a.index - b.index,
    );

  for (const entry of ranked) {
    if (remainder <= 0n) break;
    const share = shares[entry.index];
    if (share === undefined) continue;
    shares[entry.index] = share + 1n;
    remainder -= 1n;
  }

  return shares;
}

/**
 * Reject financing terms that cannot be honoured, at creation rather than at
 * payout.
 *
 * The expensive failure mode is a tokenization that sells units for months and
 * only proves unpayable when the debtor finally pays. Each check below closes
 * one route to that.
 */
export function validateTerms(
  terms: FinancingTerms,
  totalUnits: bigint,
): void {
  if (terms.faceValue <= 0n) {
    throw new ValidationError("Face value must be positive");
  }
  if (terms.advanceRateBps <= 0n || terms.advanceRateBps > BPS_DENOMINATOR) {
    throw new ValidationError("Advance rate must be between 0% and 100%");
  }
  if (terms.discountRateBps < 0n || terms.discountRateBps > BPS_DENOMINATOR) {
    throw new ValidationError("Discount rate must be between 0% and 100%");
  }
  if (terms.platformFeeBps < 0n || terms.platformFeeBps > BPS_DENOMINATOR) {
    throw new ValidationError("Platform fee must be between 0% and 100%");
  }
  if (totalUnits <= 0n) {
    throw new ValidationError("Total units must be positive");
  }

  // The face value must cover what a full, on-time collection owes: the
  // investors' principal and yield, plus the platform fee. Terms that fail this
  // are insolvent by construction — the seller's residual would be negative.
  const principal = principalFor(terms);
  const yieldOwed = applyBps(principal, terms.discountRateBps);
  const platformFee = applyBps(terms.faceValue, terms.platformFeeBps);
  if (principal + yieldOwed + platformFee > terms.faceValue) {
    throw new ValidationError(
      "Financing terms are not payable: advance plus yield and fee exceed " +
        "the face value. Lower the advance rate, the discount, or the fee.",
    );
  }

  // Forces a representable unit price; throws with a specific message when the
  // principal cannot be divided into this many units.
  pricePerUnitFor(terms, totalUnits);
}
