/**
 * The admin console's verification policy actually governs a KYC decision.
 *
 * Without this the policy table is a settings page that changes nothing — an
 * operator tightens a threshold, sees it saved, and the next application is
 * decided by the old compiled-in numbers. That failure is invisible from the
 * console, which is exactly why it is worth a test.
 */
import { describe, expect, it } from "vitest";
import {
  KycDecision,
  ProviderCheckStatus,
  type KycProviderChecks,
  type KycRiskAdvisory,
} from "@stellartrust/shared";
import {
  DEFAULT_POLICIES,
  VerificationMode,
  type VerificationPolicy,
} from "../admin/verification-policy.js";
import { decideKyc } from "./kyc-decision.engine.js";

const CLEAN_CHECKS: KycProviderChecks = {
  document: ProviderCheckStatus.Pass,
  identity: ProviderCheckStatus.Pass,
  aml: ProviderCheckStatus.Pass,
  address: ProviderCheckStatus.Pass,
};

function advisory(overrides?: Partial<KycRiskAdvisory>): KycRiskAdvisory {
  return {
    riskScore: 0.2,
    decision: KycDecision.Approve,
    confidence: 0.95,
    explanation: "deterministic fixture",
    signals: [],
    ...overrides,
  };
}

function policy(overrides?: Partial<VerificationPolicy>): VerificationPolicy {
  return { ...DEFAULT_POLICIES.kyc, ...overrides };
}

describe("the policy governs the decision", () => {
  it("approves a clean low-risk application under the default policy", () => {
    expect(
      decideKyc(CLEAN_CHECKS, advisory(), {
        aiAvailable: true,
        policy: policy(),
      }).decision,
    ).toBe(KycDecision.Approve);
  });

  it("sends that same application to a human once the band is tightened", () => {
    // The whole point of the console: one setting, changed live, changes the
    // outcome for the very next application.
    const decision = decideKyc(CLEAN_CHECKS, advisory({ riskScore: 0.2 }), {
      aiAvailable: true,
      policy: policy({ approveMaxRiskBps: 1_000 }),
    });
    expect(decision.decision).toBe(KycDecision.Review);
    expect(decision.reasons).toContain("borderline_risk");
  });

  it("queues everything in human mode, however clean", () => {
    const decision = decideKyc(CLEAN_CHECKS, advisory({ riskScore: 0.01 }), {
      aiAvailable: true,
      policy: policy({ mode: VerificationMode.Human }),
    });
    expect(decision.decision).toBe(KycDecision.Review);
    expect(decision.reasons).toContain("policy_mode_human");
  });

  it("falls back to the configured thresholds when no policy is supplied", () => {
    // Every existing construction passes no policy, and must keep meaning
    // exactly what it meant before the table existed.
    expect(
      decideKyc(CLEAN_CHECKS, advisory(), { aiAvailable: true }).decision,
    ).toBe(KycDecision.Approve);
  });
});

describe("the engine still fails closed under any policy", () => {
  it("routes an AML hit to a human even at the loosest setting", () => {
    const decision = decideKyc(
      { ...CLEAN_CHECKS, aml: ProviderCheckStatus.Fail },
      advisory({ riskScore: 0 }),
      {
        aiAvailable: true,
        policy: policy({
          mode: VerificationMode.Auto,
          approveMaxRiskBps: 9_999,
        }),
      },
    );
    expect(decision.decision).toBe(KycDecision.Review);
    // The audit trail says *which* check failed, not merely that one did.
    expect(decision.reasons).toContain("aml_hit");
  });

  it("names a provider check that asked for review", () => {
    const decision = decideKyc(
      { ...CLEAN_CHECKS, address: ProviderCheckStatus.Review },
      advisory(),
      { aiAvailable: true, policy: policy() },
    );
    expect(decision.decision).toBe(KycDecision.Review);
    expect(decision.reasons).toContain("provider_review");
  });

  it("does not auto-approve against an advisory that did not recommend it", () => {
    // A model reporting a low score while recommending review is conflicting
    // evidence, and an automatic approval on conflicting evidence is the
    // failure that lets someone through.
    const decision = decideKyc(
      CLEAN_CHECKS,
      advisory({ riskScore: 0.1, decision: KycDecision.Review }),
      { aiAvailable: true, policy: policy() },
    );
    expect(decision.decision).toBe(KycDecision.Review);
    expect(decision.reasons).toContain("conflicting_advisory");
  });

  it("does not auto-reject against an advisory that recommended approval", () => {
    const decision = decideKyc(
      CLEAN_CHECKS,
      advisory({ riskScore: 0.9, decision: KycDecision.Approve }),
      { aiAvailable: true, policy: policy() },
    );
    expect(decision.decision).toBe(KycDecision.Review);
    expect(decision.reasons).toContain("conflicting_advisory");
  });

  it("rejects when the score and the advisory agree", () => {
    expect(
      decideKyc(
        CLEAN_CHECKS,
        advisory({ riskScore: 0.9, decision: KycDecision.Reject }),
        { aiAvailable: true, policy: policy() },
      ).decision,
    ).toBe(KycDecision.Reject);
  });

  it("routes to a human when the advisory engine did not answer", () => {
    const decision = decideKyc(CLEAN_CHECKS, advisory({ confidence: 0 }), {
      aiAvailable: false,
      policy: policy(),
    });
    expect(decision.decision).toBe(KycDecision.Review);
    expect(decision.reasons).toContain("ai_unavailable");
  });
});
