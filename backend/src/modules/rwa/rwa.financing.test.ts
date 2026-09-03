import { describe, expect, it } from "vitest";
import {
  applyBps,
  daysBetween,
  investorYieldFor,
  issuerProceedsFor,
  principalFor,
  principalRoundingShortfall,
  pricePerUnitFor,
  proRataShares,
  splitCollection,
  validateTerms,
  type FinancingTerms,
} from "./rwa.financing.js";

/**
 * The worked example from plane.md §1.2, in minor units (2dp USDC):
 * a 100,000.00 invoice at 80% advance, 4% discount, 1% platform fee.
 */
const INVOICE: FinancingTerms = {
  faceValue: 10_000_000n, // 100,000.00
  advanceRateBps: 8_000n, //  80%
  discountRateBps: 400n, //   4%
  platformFeeBps: 100n, //    1%
};

describe("applyBps", () => {
  it("applies a rate exactly when it divides evenly", () => {
    expect(applyBps(10_000n, 8_000n)).toBe(8_000n);
  });

  it("rounds half up so the risk-carrying party keeps the fraction", () => {
    // 1 * 5000bps = 0.5 of a minor unit → 1, not 0.
    expect(applyBps(1n, 5_000n)).toBe(1n);
  });

  it("rounds a sub-half fraction down", () => {
    // 1 * 4999bps = 0.4999 → 0.
    expect(applyBps(1n, 4_999n)).toBe(0n);
  });

  it("refuses a negative amount rather than inventing a sign convention", () => {
    expect(() => applyBps(-1n, 100n)).toThrow(/negative/i);
  });
});

describe("principal and proceeds", () => {
  it("finances the advance rate of face value", () => {
    expect(principalFor(INVOICE)).toBe(8_000_000n); // 80,000.00
  });

  it("pays the issuer the principal less the discount taken up front", () => {
    // 80,000 − 4% = 76,800.00 — the seller's cash today.
    expect(issuerProceedsFor(INVOICE)).toBe(7_680_000n);
  });

  it("pays the full principal when there is no discount", () => {
    const free = { ...INVOICE, discountRateBps: 0n };
    expect(issuerProceedsFor(free)).toBe(principalFor(free));
  });
});

describe("pricePerUnitFor", () => {
  it("derives a price that reproduces the principal exactly", () => {
    const units = 1_000n;
    const price = pricePerUnitFor(INVOICE, units);
    expect(price).toBe(8_000n); // 80.00 per unit
    expect(price * units).toBe(principalFor(INVOICE));
    expect(principalRoundingShortfall(INVOICE, units)).toBe(0n);
  });

  it("reports the truncation gap when units do not divide the principal", () => {
    // 8,000,000 / 3 = 2,666,666 remainder 2.
    const shortfall = principalRoundingShortfall(INVOICE, 3n);
    expect(shortfall).toBe(2n);
    expect(shortfall).toBeLessThan(3n); // always < totalUnits
  });

  it("refuses a unit count that prices a unit below one minor unit", () => {
    // More units than there are minor units to divide among them.
    expect(() => pricePerUnitFor(INVOICE, 9_000_000n)).toThrow(
      /below one minor unit/,
    );
  });

  it("refuses a non-positive unit count", () => {
    expect(() => pricePerUnitFor(INVOICE, 0n)).toThrow(/positive/i);
  });
});

describe("investorYieldFor", () => {
  it("is the flat discount when collection is on time", () => {
    // 4% of 80,000 = 3,200.00
    expect(investorYieldFor(INVOICE, 90, 0)).toBe(320_000n);
  });

  it("accrues further for each day past maturity", () => {
    const onTime = investorYieldFor(INVOICE, 90, 0);
    const perDay = onTime / 90n;
    expect(investorYieldFor(INVOICE, 90, 10)).toBe(onTime + perDay * 10n);
  });

  it("accrues nothing extra on a zero-discount deal, however late", () => {
    // There is no contractual rate to accrue, so lateness costs nothing.
    const free = { ...INVOICE, discountRateBps: 0n };
    expect(investorYieldFor(free, 90, 365)).toBe(0n);
  });

  it("treats a missing term length as no defined accrual", () => {
    expect(investorYieldFor(INVOICE, 0, 30)).toBe(
      investorYieldFor(INVOICE, 0, 0),
    );
  });
});

describe("daysBetween", () => {
  it("counts whole elapsed days", () => {
    expect(
      daysBetween(new Date("2026-01-01T00:00:00Z"), new Date("2026-01-11T00:00:00Z")),
    ).toBe(10);
  });

  it("floors a partial day rather than rounding up into a late fee", () => {
    expect(
      daysBetween(new Date("2026-01-01T00:00:00Z"), new Date("2026-01-02T23:59:00Z")),
    ).toBe(1);
  });

  it("is zero when the second instant is not later", () => {
    const t = new Date("2026-01-01T00:00:00Z");
    expect(daysBetween(t, t)).toBe(0);
    expect(daysBetween(t, new Date("2025-12-01T00:00:00Z"))).toBe(0);
  });
});

describe("splitCollection — the waterfall", () => {
  it("pays the plane.md worked example exactly, and balances", () => {
    const split = splitCollection(INVOICE, INVOICE.faceValue, {
      termDays: 90,
      daysLate: 0,
    });

    expect(split.investorPrincipal).toBe(8_000_000n); // 80,000.00
    expect(split.investorYield).toBe(320_000n); //        3,200.00
    expect(split.investorTotal).toBe(8_320_000n); //     83,200.00
    expect(split.platformFee).toBe(100_000n); //          1,000.00
    expect(split.sellerResidual).toBe(1_580_000n); //    15,800.00
    expect(split.shortfall).toBe(0n);

    // The whole point: the legs reconstitute the collection.
    expect(
      split.investorTotal + split.platformFee + split.sellerResidual,
    ).toBe(INVOICE.faceValue);
  });

  it("balances for every leg on a full collection, whatever the terms", () => {
    const cases: FinancingTerms[] = [
      INVOICE,
      { ...INVOICE, advanceRateBps: 10_000n, discountRateBps: 0n, platformFeeBps: 0n },
      { ...INVOICE, advanceRateBps: 5_000n, discountRateBps: 1_250n },
      { ...INVOICE, faceValue: 7n, advanceRateBps: 3_333n },
    ];
    for (const terms of cases) {
      const split = splitCollection(terms, terms.faceValue);
      expect(
        split.investorTotal + split.platformFee + split.sellerResidual,
      ).toBe(terms.faceValue);
      expect(split.sellerResidual).toBeGreaterThanOrEqual(0n);
    }
  });

  it("pays investors first on a partial collection, leaving nothing behind them", () => {
    // Half the invoice arrives: less than the 83,200 investors are owed.
    const split = splitCollection(INVOICE, 5_000_000n);

    expect(split.investorTotal).toBe(5_000_000n); // all of it
    expect(split.platformFee).toBe(0n);
    expect(split.sellerResidual).toBe(0n);
    expect(split.shortfall).toBe(3_320_000n); // 83,200 − 50,000
    expect(split.investorPrincipal).toBe(5_000_000n);
    expect(split.investorYield).toBe(0n); // principal is not yet whole
  });

  it("credits yield only once principal is whole", () => {
    // 81,000 collected: principal (80,000) covered, 1,000 toward yield.
    const split = splitCollection(INVOICE, 8_100_000n, { termDays: 90 });
    expect(split.investorPrincipal).toBe(8_000_000n);
    expect(split.investorYield).toBe(100_000n);
    expect(split.shortfall).toBe(220_000n); // 3,200 owed − 1,000 paid
  });

  it("takes late accrual out of the seller's residual, not the investors'", () => {
    const onTime = splitCollection(INVOICE, INVOICE.faceValue, {
      termDays: 90,
      daysLate: 0,
    });
    const late = splitCollection(INVOICE, INVOICE.faceValue, {
      termDays: 90,
      daysLate: 30,
    });

    expect(late.investorTotal).toBeGreaterThan(onTime.investorTotal);
    expect(late.sellerResidual).toBeLessThan(onTime.sellerResidual);
    expect(late.platformFee).toBe(onTime.platformFee); // the platform is unaffected
    expect(
      late.investorTotal + late.platformFee + late.sellerResidual,
    ).toBe(INVOICE.faceValue);
  });

  it("leaves a zero residual when the terms consume the whole face value", () => {
    const thin: FinancingTerms = {
      faceValue: 10_000_000n,
      advanceRateBps: 10_000n, // finance all of it
      discountRateBps: 0n,
      platformFeeBps: 0n,
    };
    const split = splitCollection(thin, thin.faceValue);
    expect(split.sellerResidual).toBe(0n);
    expect(split.investorTotal).toBe(thin.faceValue);
  });

  it("pays nothing to anyone when nothing is collected", () => {
    const split = splitCollection(INVOICE, 0n);
    expect(split.investorTotal).toBe(0n);
    expect(split.platformFee).toBe(0n);
    expect(split.sellerResidual).toBe(0n);
    expect(split.shortfall).toBe(8_320_000n);
  });

  it("refuses a negative collection", () => {
    expect(() => splitCollection(INVOICE, -1n)).toThrow(/negative/i);
  });
});

describe("proRataShares", () => {
  it("splits evenly when the amount divides cleanly", () => {
    expect(proRataShares([1n, 1n, 2n], 400n)).toEqual([100n, 100n, 200n]);
  });

  it("distributes the truncation remainder instead of dropping it", () => {
    // 100 / 3 = 33 each, remainder 1 — someone must get it.
    const shares = proRataShares([1n, 1n, 1n], 100n);
    expect(shares.reduce((a, b) => a + b, 0n)).toBe(100n);
    expect(shares.filter((s) => s === 34n)).toHaveLength(1);
  });

  it("always sums to exactly the amount, across many awkward splits", () => {
    // A ledger transaction whose legs miss the total is rejected outright,
    // so this property matters more than any individual share.
    for (let holders = 1; holders <= 9; holders++) {
      for (const amount of [1n, 7n, 99n, 100n, 1_000_003n]) {
        const units = Array.from({ length: holders }, (_, i) => BigInt(i + 1));
        const shares = proRataShares(units, amount);
        expect(shares.reduce((a, b) => a + b, 0n)).toBe(amount);
        expect(shares.every((s) => s >= 0n)).toBe(true);
      }
    }
  });

  it("gives the remainder to the largest holdings first", () => {
    // 10 across holdings of 1 and 2: 3.33 and 6.66 → 3 and 7.
    expect(proRataShares([1n, 2n], 10n)).toEqual([3n, 7n]);
  });

  it("pays a zero-unit holder nothing", () => {
    const shares = proRataShares([0n, 5n], 100n);
    expect(shares[0]).toBe(0n);
    expect(shares[1]).toBe(100n);
  });

  it("returns all zeros when nobody holds units", () => {
    expect(proRataShares([0n, 0n], 500n)).toEqual([0n, 0n]);
  });

  it("refuses a negative distribution", () => {
    expect(() => proRataShares([1n], -5n)).toThrow(/negative/i);
  });
});

describe("validateTerms", () => {
  it("accepts the worked example", () => {
    expect(() => validateTerms(INVOICE, 1_000n)).not.toThrow();
  });

  it("refuses terms that cannot be paid from the face value", () => {
    // 100% advance + 10% yield + 5% fee needs 115% of face value.
    expect(() =>
      validateTerms(
        {
          faceValue: 10_000_000n,
          advanceRateBps: 10_000n,
          discountRateBps: 1_000n,
          platformFeeBps: 500n,
        },
        1_000n,
      ),
    ).toThrow(/not payable/i);
  });

  it("refuses an advance above 100%", () => {
    expect(() =>
      validateTerms({ ...INVOICE, advanceRateBps: 10_001n }, 1_000n),
    ).toThrow(/advance rate/i);
  });

  it("refuses a non-positive advance", () => {
    expect(() =>
      validateTerms({ ...INVOICE, advanceRateBps: 0n }, 1_000n),
    ).toThrow(/advance rate/i);
  });

  it("refuses a non-positive face value", () => {
    expect(() => validateTerms({ ...INVOICE, faceValue: 0n }, 1_000n)).toThrow(
      /face value/i,
    );
  });

  it("refuses an out-of-range discount or fee", () => {
    expect(() =>
      validateTerms({ ...INVOICE, discountRateBps: -1n }, 1_000n),
    ).toThrow(/discount rate/i);
    expect(() =>
      validateTerms({ ...INVOICE, platformFeeBps: 10_001n }, 1_000n),
    ).toThrow(/platform fee/i);
  });

  it("refuses a unit count that cannot carry a representable price", () => {
    expect(() => validateTerms(INVOICE, 9_000_000n)).toThrow(
      /below one minor unit/,
    );
  });
});
