/** AI KYC advisory client boundary. The AI service can never move funds. */
import { z } from "zod";
import { KycDecision, type KycRiskAdvisory } from "@stellartrust/shared";
import { config } from "../../config/index.js";
import { ExternalServiceError } from "../../lib/errors.js";
import type { RiskSignal } from "./providers/kyc-provider.js";

export interface KycRiskRequest {
  subjectRef: string;
  signals: RiskSignal[];
  sanctionsHit: boolean;
  newParty: boolean;
}

export interface KycRiskClient {
  score(input: KycRiskRequest): Promise<KycRiskAdvisory>;
}

const responseSchema = z.object({
  subject_ref: z.string(),
  risk_score: z.number().min(0).max(1),
  decision: z.enum([
    KycDecision.Approve,
    KycDecision.Review,
    KycDecision.Reject,
  ]),
  confidence: z.number().min(0).max(1),
  explanation: z.string().min(1),
  signals_used: z.array(z.string()),
});

export class HttpKycRiskClient implements KycRiskClient {
  async score(input: KycRiskRequest): Promise<KycRiskAdvisory> {
    try {
      const response = await fetch(`${config.AI_SERVICE_URL}/kyc-score`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject_ref: input.subjectRef,
          signals: input.signals,
          sanctions_hit: input.sanctionsHit,
          new_party: input.newParty,
        }),
        signal: AbortSignal.timeout(config.KYC_AI_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`AI service returned ${response.status}`);
      }
      const parsed = responseSchema.parse(await response.json());
      return {
        riskScore: parsed.risk_score,
        decision: parsed.decision,
        confidence: parsed.confidence,
        explanation: parsed.explanation,
        signals: parsed.signals_used,
      };
    } catch (err) {
      throw new ExternalServiceError("KYC risk service unavailable", err);
    }
  }
}

/** Deterministic adapter for tests and isolated local service tests. */
export class DeterministicKycRiskClient implements KycRiskClient {
  async score(input: KycRiskRequest): Promise<KycRiskAdvisory> {
    if (input.sanctionsHit) {
      return {
        riskScore: 1,
        decision: KycDecision.Reject,
        confidence: 0.99,
        explanation: "AML/sanctions signal requires compliance escalation.",
        signals: [...input.signals.map((signal) => signal.name), "sanctions_hit"],
      };
    }
    const average = input.signals.length
      ? input.signals.reduce((sum, signal) => sum + signal.value, 0) /
        input.signals.length
      : 0.5;
    const riskScore = Math.min(1, average + (input.newParty ? 0.1 : 0));
    const decision =
      riskScore < config.KYC_APPROVE_MAX_RISK
        ? KycDecision.Approve
        : riskScore >= config.KYC_REJECT_MIN_RISK
          ? KycDecision.Reject
          : KycDecision.Review;
    const distance = Math.min(
      Math.abs(riskScore - config.KYC_APPROVE_MAX_RISK),
      Math.abs(riskScore - config.KYC_REJECT_MIN_RISK),
    );
    return {
      riskScore: Number(riskScore.toFixed(4)),
      decision,
      confidence: Number(Math.min(0.99, 0.65 + distance).toFixed(4)),
      explanation: `Normalized provider signals produced risk=${riskScore.toFixed(2)}.`,
      signals: input.signals.map((signal) => signal.name),
    };
  }
}
