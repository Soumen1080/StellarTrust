/**
 * Final KYC policy engine. AI is advisory; this deterministic backend policy
 * owns Approve / Review / Reject and always fails closed to human review.
 */
import {
  KycDecision,
  ProviderCheckStatus,
  type KycProviderChecks,
  type KycRiskAdvisory,
} from "@stellartrust/shared";
import { config } from "../../config/index.js";

export interface KycDecisionResult {
  decision: KycDecision;
  reasons: string[];
}

export function decideKyc(
  checks: KycProviderChecks,
  advisory: KycRiskAdvisory,
  options: { aiAvailable: boolean },
): KycDecisionResult {
  const reasons: string[] = [];
  const values = Object.values(checks);

  if (!options.aiAvailable) reasons.push("ai_unavailable");
  if (checks.aml === ProviderCheckStatus.Fail) reasons.push("aml_hit");
  if (values.includes(ProviderCheckStatus.Fail)) reasons.push("provider_fail");
  if (values.includes(ProviderCheckStatus.Review)) reasons.push("provider_review");
  if (advisory.confidence < config.KYC_MIN_CONFIDENCE) {
    reasons.push("low_confidence");
  }

  // Hard provider failures, AML, uncertainty, and conflicting/borderline evidence
  // require a human. Automated rejection is reserved for clear high-risk cases
  // where all provider checks completed without an explicit hard/conflicting hit.
  if (reasons.length > 0) {
    return { decision: KycDecision.Review, reasons };
  }

  if (
    advisory.decision === KycDecision.Approve &&
    advisory.riskScore <= config.KYC_APPROVE_MAX_RISK
  ) {
    return { decision: KycDecision.Approve, reasons: ["low_risk"] };
  }

  if (
    advisory.decision === KycDecision.Reject &&
    advisory.riskScore >= config.KYC_REJECT_MIN_RISK
  ) {
    return { decision: KycDecision.Reject, reasons: ["high_risk"] };
  }

  return { decision: KycDecision.Review, reasons: ["borderline_risk"] };
}
