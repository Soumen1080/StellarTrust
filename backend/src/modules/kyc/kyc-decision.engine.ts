/**
 * Final KYC policy engine. AI is advisory; this deterministic backend policy
 * owns Approve / Review / Reject and always fails closed to human review.
 *
 * The thresholds come from a {@link VerificationPolicy} when one is supplied —
 * the row an operator edits through the admin console (migration 0022) — and
 * from the environment otherwise. The fallback is what keeps every existing
 * construction and test meaning exactly what it meant before the policy table
 * existed, and the seeded policy matches the environment defaults, so
 * introducing the table changed no decision until someone decided otherwise.
 */
import {
  KycDecision,
  ProviderCheckStatus,
  type KycProviderChecks,
  type KycRiskAdvisory,
} from "@stellartrust/shared";
import { config } from "../../config/index.js";
import {
  RoutingOutcome,
  routeVerification,
  VerificationDomain,
  VerificationMode,
  type VerificationPolicy,
} from "../admin/verification-policy.js";

export interface KycDecisionResult {
  decision: KycDecision;
  reasons: string[];
}

/**
 * The policy implied by the environment variables, for callers that pass none.
 *
 * Risk and confidence are configured as 0..1 fractions and the policy carries
 * basis points, so they are scaled here rather than in two places.
 */
function policyFromConfig(): VerificationPolicy {
  return {
    domain: VerificationDomain.Kyc,
    mode: VerificationMode.Ai,
    approveMaxRiskBps: Math.round(config.KYC_APPROVE_MAX_RISK * 10_000),
    rejectMinRiskBps: Math.round(config.KYC_REJECT_MIN_RISK * 10_000),
    minConfidenceBps: Math.round(config.KYC_MIN_CONFIDENCE * 10_000),
    humanReviewAboveAmount: "0",
    updatedBy: null,
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

export function decideKyc(
  checks: KycProviderChecks,
  advisory: KycRiskAdvisory,
  options: { aiAvailable: boolean; policy?: VerificationPolicy },
): KycDecisionResult {
  const policy = options.policy ?? policyFromConfig();
  const values = Object.values(checks);

  // Provider outcomes are this engine's own concern — the shared router knows
  // about risk, confidence and amounts, not about which checks a KYC provider
  // ran. They are collapsed into the router's `hardFailure` flag, and the
  // specific reasons are carried through so the audit trail says *which*
  // check failed rather than merely that one did.
  const providerReasons: string[] = [];
  if (checks.aml === ProviderCheckStatus.Fail) providerReasons.push("aml_hit");
  if (values.includes(ProviderCheckStatus.Fail)) {
    providerReasons.push("provider_fail");
  }
  if (values.includes(ProviderCheckStatus.Review)) {
    providerReasons.push("provider_review");
  }

  const routed = routeVerification(policy, {
    riskScore: advisory.riskScore,
    confidence: advisory.confidence,
    aiAvailable: options.aiAvailable,
    hardFailure: providerReasons.length > 0,
  });

  // The router's reasons come first — they are the ones that decided the
  // outcome — followed by the provider detail behind `hard_failure`.
  const reasons = [
    ...routed.reasons.filter((reason) => reason !== "hard_failure"),
    ...providerReasons,
  ];

  if (routed.outcome === RoutingOutcome.HumanReview) {
    return { decision: KycDecision.Review, reasons };
  }

  if (routed.outcome === RoutingOutcome.AutoReject) {
    // The router says the score is high enough to reject. The advisory must
    // also *say* reject: a model reporting a high score while recommending
    // approval is conflicting evidence, and conflicting evidence is a human's
    // call (Rules.md §6).
    if (advisory.decision === KycDecision.Reject) {
      return { decision: KycDecision.Reject, reasons };
    }
    return {
      decision: KycDecision.Review,
      reasons: [...reasons, "conflicting_advisory"],
    };
  }

  // Same requirement in the other direction, and this one matters more: an
  // automatic *approval* against a model that did not recommend one is the
  // failure that lets someone through.
  if (advisory.decision === KycDecision.Approve) {
    return { decision: KycDecision.Approve, reasons };
  }
  return {
    decision: KycDecision.Review,
    reasons: [...reasons, "conflicting_advisory"],
  };
}
