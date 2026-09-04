/**
 * Admin — verification routing policy and business metrics.
 *
 * Two claims worth proving:
 *
 * **The routing policy fails closed.** Every escape hatch — an engine that did
 * not answer, an answer we do not trust, an amount above the ceiling, a hard
 * provider failure — routes *towards* a human, never away from one. A policy
 * that can be misconfigured into auto-approving a sanctions hit is not a
 * control, and the way that bug arrives is a reordering that looks harmless.
 *
 * **The metrics say what they claim.** A default rate that quietly counts
 * still-running positions as successes flatters a young book, and an operator
 * making a credit decision on that number is being misled by their own
 * dashboard.
 */
import { describe, expect, it } from "vitest";
import { InMemoryAuditRepository } from "../audit/audit.repository.js";
import { AdminService, type AdminReaders } from "./admin.service.js";
import { InMemoryPolicyRepository } from "./policy.repository.js";
import {
  DEFAULT_POLICIES,
  RoutingOutcome,
  routeVerification,
  validatePolicyUpdate,
  VerificationDomain,
  VerificationMode,
  type VerificationPolicy,
} from "./verification-policy.js";

const OPERATOR = { userId: "officer-1" };

function policy(overrides?: Partial<VerificationPolicy>): VerificationPolicy {
  return { ...DEFAULT_POLICIES.kyc, ...overrides };
}

/** A case the policy would otherwise wave straight through. */
const CONFIDENT_LOW_RISK = {
  riskScore: 0.1,
  confidence: 0.95,
  aiAvailable: true,
};

describe("routing a verification", () => {
  it("approves a confident low-risk case", () => {
    expect(routeVerification(policy(), CONFIDENT_LOW_RISK)).toEqual({
      outcome: RoutingOutcome.AutoApprove,
      reasons: ["low_risk"],
    });
  });

  it("rejects a confident high-risk case", () => {
    expect(
      routeVerification(policy(), {
        riskScore: 0.9,
        confidence: 0.95,
        aiAvailable: true,
      }).outcome,
    ).toBe(RoutingOutcome.AutoReject);
  });

  it("sends a case between the bands to a person", () => {
    // Neither clearly safe nor clearly bad is exactly what a human is for.
    expect(
      routeVerification(policy(), {
        riskScore: 0.5,
        confidence: 0.95,
        aiAvailable: true,
      }),
    ).toEqual({
      outcome: RoutingOutcome.HumanReview,
      reasons: ["borderline_risk"],
    });
  });

  it("treats the approval band as inclusive at its edge", () => {
    // 3500bps is "at or below", so exactly 0.35 approves. Stated as a test
    // because an off-by-one here silently moves every borderline case.
    expect(
      routeVerification(policy(), { ...CONFIDENT_LOW_RISK, riskScore: 0.35 })
        .outcome,
    ).toBe(RoutingOutcome.AutoApprove);
  });

  it("sends one basis point above the approval band to a person", () => {
    expect(
      routeVerification(policy(), { ...CONFIDENT_LOW_RISK, riskScore: 0.3501 })
        .outcome,
    ).toBe(RoutingOutcome.HumanReview);
  });
});

describe("the policy fails closed", () => {
  it("routes everything to a person in human mode", () => {
    // The setting an operator reaches for during an incident. Nothing may
    // override it — not a low score, not a high confidence.
    expect(
      routeVerification(
        policy({ mode: VerificationMode.Human }),
        CONFIDENT_LOW_RISK,
      ),
    ).toEqual({
      outcome: RoutingOutcome.HumanReview,
      reasons: ["policy_mode_human"],
    });
  });

  it("sends a large case to a person however low its risk", () => {
    // Rules.md §6: no autonomous money decision above threshold. Checked
    // before the risk bands, so a big, clean case still reaches someone.
    expect(
      routeVerification(policy({ humanReviewAboveAmount: "100000" }), {
        ...CONFIDENT_LOW_RISK,
        amount: 100_001n,
      }),
    ).toEqual({
      outcome: RoutingOutcome.HumanReview,
      reasons: ["amount_above_human_review_threshold"],
    });
  });

  it("allows a case exactly at the amount ceiling", () => {
    expect(
      routeVerification(policy({ humanReviewAboveAmount: "100000" }), {
        ...CONFIDENT_LOW_RISK,
        amount: 100_000n,
      }).outcome,
    ).toBe(RoutingOutcome.AutoApprove);
  });

  it("ignores the amount gate when it is disabled", () => {
    expect(
      routeVerification(policy({ humanReviewAboveAmount: "0" }), {
        ...CONFIDENT_LOW_RISK,
        amount: 999_999_999n,
      }).outcome,
    ).toBe(RoutingOutcome.AutoApprove);
  });

  it("never automates away a hard provider failure", () => {
    // A sanctions hit with a low model score is the exact case this catches.
    const decision = routeVerification(policy(), {
      ...CONFIDENT_LOW_RISK,
      hardFailure: true,
    });
    expect(decision.outcome).toBe(RoutingOutcome.HumanReview);
    expect(decision.reasons).toContain("hard_failure");
  });

  it("does not read a silent engine as low risk", () => {
    const decision = routeVerification(policy(), {
      ...CONFIDENT_LOW_RISK,
      aiAvailable: false,
    });
    expect(decision.outcome).toBe(RoutingOutcome.HumanReview);
    expect(decision.reasons).toContain("ai_unavailable");
  });

  it("does not trust an answer below the confidence floor", () => {
    const decision = routeVerification(policy(), {
      riskScore: 0.1,
      confidence: 0.5,
      aiAvailable: true,
    });
    expect(decision.outcome).toBe(RoutingOutcome.HumanReview);
    expect(decision.reasons).toContain("low_confidence");
  });

  it("still refuses a hard failure in auto mode", () => {
    // `auto` means the deterministic policy may conclude without queueing —
    // not that anything goes.
    expect(
      routeVerification(policy({ mode: VerificationMode.Auto }), {
        ...CONFIDENT_LOW_RISK,
        hardFailure: true,
      }).outcome,
    ).toBe(RoutingOutcome.HumanReview);
  });

  it("does not queue on a silent engine in auto mode", () => {
    // In auto mode the deterministic policy was never going to consult the
    // engine, so its absence is not a reason on its own.
    expect(
      routeVerification(policy({ mode: VerificationMode.Auto }), {
        ...CONFIDENT_LOW_RISK,
        aiAvailable: false,
      }).outcome,
    ).toBe(RoutingOutcome.AutoApprove);
  });

  it("defaults asset verification to a human decision", () => {
    // §3.1 has always required compliance to verify an asset; the default
    // policy preserves that rather than quietly loosening it.
    expect(DEFAULT_POLICIES.rwa_asset.mode).toBe(VerificationMode.Human);
  });
});

describe("a policy must be coherent before it is stored", () => {
  it("refuses an approval band that overlaps the rejection band", () => {
    // Two contradictory instructions, not a policy.
    expect(
      validatePolicyUpdate(policy(), {
        approveMaxRiskBps: 8_000,
        rejectMinRiskBps: 7_000,
      }),
    ).toContainEqual(expect.stringContaining("must be below"));
  });

  it("refuses bands that touch", () => {
    expect(
      validatePolicyUpdate(policy(), {
        approveMaxRiskBps: 7_000,
        rejectMinRiskBps: 7_000,
      }).length,
    ).toBeGreaterThan(0);
  });

  it("refuses basis points outside 0..10000", () => {
    expect(
      validatePolicyUpdate(policy(), { approveMaxRiskBps: 10_001 }).length,
    ).toBeGreaterThan(0);
    expect(
      validatePolicyUpdate(policy(), { minConfidenceBps: -1 }).length,
    ).toBeGreaterThan(0);
  });

  it("refuses a fractional basis point", () => {
    expect(
      validatePolicyUpdate(policy(), { approveMaxRiskBps: 350.5 }).length,
    ).toBeGreaterThan(0);
  });

  it("refuses an amount that is not minor units", () => {
    expect(
      validatePolicyUpdate(policy(), { humanReviewAboveAmount: "12.50" })
        .length,
    ).toBeGreaterThan(0);
  });

  it("accepts a coherent change", () => {
    expect(
      validatePolicyUpdate(policy(), {
        mode: VerificationMode.Human,
        approveMaxRiskBps: 2_000,
      }),
    ).toEqual([]);
  });
});

describe("editing a policy", () => {
  function setup() {
    const audit = new InMemoryAuditRepository();
    const service = new AdminService(
      {
        tokenizations: async () => [],
        orders: async () => [],
        disputes: async () => [],
      },
      new InMemoryPolicyRepository(),
      audit,
    );
    return { service, audit };
  }

  it("applies the change", async () => {
    const { service } = setup();
    const updated = await service.updatePolicy(
      VerificationDomain.Kyc,
      { mode: VerificationMode.Human },
      OPERATOR,
    );
    expect(updated.mode).toBe(VerificationMode.Human);
    expect(
      (await service.getPolicy(VerificationDomain.Kyc)).mode,
    ).toBe(VerificationMode.Human);
  });

  it("records what the policy was changed *from*", async () => {
    // The question an auditor asks. An entry carrying only the new value
    // cannot answer it, which is why the before is recorded too.
    const { service, audit } = setup();
    await service.updatePolicy(
      VerificationDomain.Kyc,
      { mode: VerificationMode.Auto, approveMaxRiskBps: 6_000 },
      OPERATOR,
    );

    const [entry] = await audit.listForEntity(
      "verification_policy",
      VerificationDomain.Kyc,
    );
    expect(entry?.action).toBe("admin.verification_policy_updated");
    expect(entry?.actor).toBe("user:officer-1");
    expect(entry?.metadata).toMatchObject({
      before: { mode: VerificationMode.Ai, approveMaxRiskBps: 3_500 },
      after: { mode: VerificationMode.Auto, approveMaxRiskBps: 6_000 },
    });
  });

  it("refuses an incoherent change and writes nothing", async () => {
    const { service, audit } = setup();
    await expect(
      service.updatePolicy(
        VerificationDomain.Kyc,
        { approveMaxRiskBps: 9_000 },
        OPERATOR,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    // Not merely refused — refused without a trace of a change having happened.
    expect(
      (await service.getPolicy(VerificationDomain.Kyc)).approveMaxRiskBps,
    ).toBe(3_500);
    expect(
      await audit.listForEntity("verification_policy", VerificationDomain.Kyc),
    ).toEqual([]);
  });

  it("lists every known domain, configured or not", async () => {
    // A console that only lists configured domains hides the one an operator
    // most needs to configure.
    const { service } = setup();
    expect((await service.listPolicies()).map((p) => p.domain).sort()).toEqual([
      "kyc",
      "rwa_asset",
    ]);
  });
});

describe("business metrics", () => {
  const NOW = new Date("2026-06-01T00:00:00.000Z");

  function tokenization(overrides: Record<string, unknown>) {
    return {
      id: "t1",
      status: "funded",
      faceValueAmount: "1000000",
      faceValueCurrency: "USDC",
      totalUnits: "1000",
      unitsSold: "1000",
      pricePerUnitAmount: "800",
      maturityDate: "2026-09-01T00:00:00.000Z",
      collectedAt: null,
      createdAt: "2026-05-01T00:00:00.000Z",
      ...overrides,
    } as never;
  }

  function setup(readers: Partial<AdminReaders>) {
    return new AdminService(
      {
        tokenizations: async () => [],
        orders: async () => [],
        disputes: async () => [],
        ...readers,
      },
      new InMemoryPolicyRepository(),
      new InMemoryAuditRepository(),
      () => NOW,
    );
  }

  it("locks the face value of every position still carrying risk", async () => {
    const service = setup({
      tokenizations: async () => [
        tokenization({ id: "t1", status: "funded" }),
        tokenization({ id: "t2", status: "active" }),
        // Finished: its risk is resolved, so it is not locked value.
        tokenization({ id: "t3", status: "repaid" }),
      ],
    });
    const metrics = await service.businessMetrics();
    expect(metrics.totalValueLocked).toEqual({ USDC: "2000000" });
  });

  it("keeps currencies apart rather than inventing an exchange rate", async () => {
    // A single scalar TVL across currencies would need an FX rate this
    // service does not have. A number that silently assumes 1 USD = 1 EUR is
    // worse than no number.
    const service = setup({
      tokenizations: async () => [
        tokenization({ id: "t1", faceValueCurrency: "USDC" }),
        tokenization({ id: "t2", faceValueCurrency: "EUR" }),
      ],
    });
    expect((await service.businessMetrics()).totalValueLocked).toEqual({
      USDC: "1000000",
      EUR: "1000000",
    });
  });

  it("reports capital deployed as units sold at the unit price", async () => {
    // Not the face value: that includes the seller's retained first-loss and
    // a yield nobody has earned yet.
    const service = setup({
      tokenizations: async () => [
        tokenization({ unitsSold: "750", pricePerUnitAmount: "800" }),
      ],
    });
    expect((await service.businessMetrics()).capitalDeployed).toEqual({
      USDC: "600000",
    });
  });

  it("computes the default rate over resolved positions only", async () => {
    // Counting still-running positions as successes flatters a young book,
    // and an operator making a credit decision on that number is being misled
    // by their own dashboard.
    const service = setup({
      tokenizations: async () => [
        tokenization({ id: "t1", status: "repaid" }),
        tokenization({ id: "t2", status: "repaid" }),
        tokenization({ id: "t3", status: "defaulted" }),
        tokenization({ id: "t4", status: "written_off" }),
        // Still running — excluded from the denominator entirely.
        tokenization({ id: "t5", status: "funded" }),
        tokenization({ id: "t6", status: "active" }),
      ],
    });
    // 2 losses over 4 resolved = 50%, not 2 over 6 = 33%.
    expect((await service.businessMetrics()).defaultRateBps).toBe(5_000);
  });

  it("reports a zero default rate when nothing has resolved yet", async () => {
    const service = setup({
      tokenizations: async () => [tokenization({ status: "funded" })],
    });
    expect((await service.businessMetrics()).defaultRateBps).toBe(0);
  });

  it("counts positions past maturity with no collection as overdue", async () => {
    const service = setup({
      tokenizations: async () => [
        tokenization({ id: "t1", maturityDate: "2026-05-01T00:00:00.000Z" }),
        // Past maturity but collected: late, not overdue.
        tokenization({
          id: "t2",
          maturityDate: "2026-05-01T00:00:00.000Z",
          collectedAt: "2026-05-20T00:00:00.000Z",
        }),
        // Not yet due.
        tokenization({ id: "t3", maturityDate: "2026-09-01T00:00:00.000Z" }),
      ],
    });
    expect((await service.businessMetrics()).overduePositions).toBe(1);
  });

  it("averages days-to-collect over collected positions only", async () => {
    const service = setup({
      tokenizations: async () => [
        tokenization({
          id: "t1",
          createdAt: "2026-05-01T00:00:00.000Z",
          collectedAt: "2026-05-31T00:00:00.000Z",
        }),
        tokenization({
          id: "t2",
          createdAt: "2026-05-01T00:00:00.000Z",
          collectedAt: "2026-05-11T00:00:00.000Z",
        }),
        // Uncollected: excluded, rather than counted as zero days.
        tokenization({ id: "t3", collectedAt: null }),
      ],
    });
    expect((await service.businessMetrics()).averageDaysToCollect).toBe(20);
  });

  it("reports no average when nothing has been collected", async () => {
    const service = setup({
      tokenizations: async () => [tokenization({ collectedAt: null })],
    });
    expect((await service.businessMetrics()).averageDaysToCollect).toBeNull();
  });

  it("ignores a collection timestamp that precedes creation", async () => {
    // A negative interval is a data fault, not a fast collection. Counting it
    // would drag the average down and hide the fault.
    const service = setup({
      tokenizations: async () => [
        tokenization({
          id: "t1",
          createdAt: "2026-05-31T00:00:00.000Z",
          collectedAt: "2026-05-01T00:00:00.000Z",
        }),
      ],
    });
    expect((await service.businessMetrics()).averageDaysToCollect).toBeNull();
  });

  it("computes the dispute rate against orders", async () => {
    const service = setup({
      orders: async () =>
        Array.from({ length: 8 }, (_, i) => ({
          id: `o${i}`,
          status: "released",
          amount: "1000",
          currency: "USDC",
          createdAt: "2026-05-01T00:00:00.000Z",
        })),
      disputes: async () => [
        {
          id: "d1",
          status: "open",
          orderId: "o1",
          createdAt: "2026-05-02T00:00:00.000Z",
        },
        {
          id: "d2",
          status: "resolved",
          orderId: "o2",
          createdAt: "2026-05-02T00:00:00.000Z",
        },
      ],
    });
    const metrics = await service.businessMetrics();
    expect(metrics.disputeRateBps).toBe(2_500);
    expect(metrics.openDisputes).toBe(1);
  });

  it("does not divide by zero on an empty platform", async () => {
    const metrics = await setup({}).businessMetrics();
    expect(metrics.disputeRateBps).toBe(0);
    expect(metrics.defaultRateBps).toBe(0);
    expect(metrics.totalValueLocked).toEqual({});
  });
});

describe("the volume series", () => {
  const NOW = new Date("2026-06-10T12:00:00.000Z");

  function setup(readers: Partial<AdminReaders>) {
    return new AdminService(
      {
        tokenizations: async () => [],
        orders: async () => [],
        disputes: async () => [],
        ...readers,
      },
      new InMemoryPolicyRepository(),
      new InMemoryAuditRepository(),
      () => NOW,
    );
  }

  it("includes every day in the window, quiet ones too", async () => {
    // A chart that omits quiet days draws a line implying activity that never
    // happened, which is how a gap gets read as a trend.
    const { buckets } = await setup({}).volumeSeries(7);
    expect(buckets).toHaveLength(7);
    expect(buckets[0]?.date).toBe("2026-06-04");
    expect(buckets[6]?.date).toBe("2026-06-10");
  });

  it("places an order in the bucket for its day", async () => {
    const { buckets } = await setup({
      orders: async () => [
        {
          id: "o1",
          status: "released",
          amount: "5000",
          currency: "USDC",
          createdAt: "2026-06-08T09:00:00.000Z",
        },
      ],
    }).volumeSeries(7);

    const day = buckets.find((b) => b.date === "2026-06-08");
    expect(day).toMatchObject({
      orderCount: 1,
      orderVolume: { USDC: "5000" },
    });
  });

  it("drops activity older than the window rather than piling it on the edge", async () => {
    const { buckets } = await setup({
      orders: async () => [
        {
          id: "old",
          status: "released",
          amount: "5000",
          currency: "USDC",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }).volumeSeries(7);
    expect(buckets.every((b) => b.orderCount === 0)).toBe(true);
  });

  it("bounds the window so a console cannot ask for the whole history", async () => {
    expect((await setup({}).volumeSeries(10_000)).buckets).toHaveLength(365);
    expect((await setup({}).volumeSeries(0)).buckets).toHaveLength(1);
  });
});
