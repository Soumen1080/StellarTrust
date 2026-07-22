/**
 * AI dispute advisory client boundary (Phase 4).
 *
 * Calls the read-only AI Risk Service `/dispute-recommend` endpoint. The AI is
 * ADVISORY ONLY — it can never release, refund, or write to the ledger
 * (Rules.md §3, §6). The backend applies the human-gate thresholds and any fund
 * movement. Timeouts fall back to a manual-review advisory so an AI outage
 * degrades to human review rather than blocking the dispute (Rules.md §6).
 */
import { z } from "zod";
import {
  AiRecommendation,
  DisputeResolution,
  type AiAdvisory,
  type CurrencyCode,
  type DisputeEvidenceDTO,
} from "@stellartrust/shared";
import { config } from "../../config/index.js";
import { logger } from "../../lib/logger.js";

export interface DisputeRiskRequest {
  disputeRef: string;
  amountMinor: string;
  currency: CurrencyCode;
  evidence: DisputeEvidenceDTO[];
  buyerReputation: number;
  sellerReputation: number;
}

export interface DisputeAdvisoryResult extends AiAdvisory {
  /** AI's own advisory flag; the backend still owns the final human gate. */
  requiresHumanReview: boolean;
}

export interface DisputeRiskClient {
  recommend(input: DisputeRiskRequest): Promise<DisputeAdvisoryResult>;
}

const responseSchema = z.object({
  dispute_ref: z.string(),
  recommendation: z.enum([
    AiRecommendation.Release,
    AiRecommendation.Refund,
    AiRecommendation.ManualReview,
  ]),
  confidence: z.number().min(0).max(1),
  explanation: z.string().min(1),
  signals: z.array(z.string()),
  requires_human_review: z.boolean(),
});

/** Advisory returned when the AI service cannot be reached — degrade to human. */
function manualReviewFallback(reason: string): DisputeAdvisoryResult {
  return {
    recommendation: AiRecommendation.ManualReview,
    confidence: 0,
    explanation: `AI dispute service unavailable (${reason}); routing to human review.`,
    signals: ["ai_unavailable"],
    requiresHumanReview: true,
  };
}

export class HttpDisputeRiskClient implements DisputeRiskClient {
  async recommend(input: DisputeRiskRequest): Promise<DisputeAdvisoryResult> {
    try {
      const response = await fetch(`${config.AI_SERVICE_URL}/dispute-recommend`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          dispute_ref: input.disputeRef,
          amount_minor: Number(input.amountMinor),
          currency: input.currency,
          evidence: input.evidence.map((item) => ({
            kind: item.kind,
            supports: item.supports,
            weight: item.weight,
          })),
          buyer_reputation: input.buyerReputation,
          seller_reputation: input.sellerReputation,
        }),
        signal: AbortSignal.timeout(config.DISPUTE_AI_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`AI service returned ${response.status}`);
      }
      const parsed = responseSchema.parse(await response.json());
      return {
        recommendation: parsed.recommendation,
        confidence: parsed.confidence,
        explanation: parsed.explanation,
        signals: parsed.signals,
        requiresHumanReview: parsed.requires_human_review,
      };
    } catch (err) {
      // Never block the dispute on an AI outage — fall back to human review.
      logger.warn({ err }, "dispute AI advisory unavailable; using manual-review fallback");
      return manualReviewFallback(err instanceof Error ? err.message : "unknown");
    }
  }
}

/**
 * Deterministic adapter for tests and isolated local runs. Mirrors the AI
 * service's weighted-evidence heuristic so advisories are reproducible without
 * the Python service running.
 */
export class DeterministicDisputeRiskClient implements DisputeRiskClient {
  async recommend(input: DisputeRiskRequest): Promise<DisputeAdvisoryResult> {
    if (input.evidence.length === 0) {
      return {
        recommendation: AiRecommendation.ManualReview,
        confidence: 0,
        explanation: "No evidence submitted; cannot form an advisory view.",
        signals: [],
        requiresHumanReview: true,
      };
    }

    let releaseWeight = input.evidence
      .filter((item) => item.supports === DisputeResolution.Release)
      .reduce((sum, item) => sum + item.weight, 0);
    let refundWeight = input.evidence
      .filter((item) => item.supports === DisputeResolution.Refund)
      .reduce((sum, item) => sum + item.weight, 0);

    // "Conflicting" means opposing *evidence* exists — reputation is a prior,
    // not evidence, so it is excluded from the conflict test.
    const conflicting = releaseWeight > 0 && refundWeight > 0;

    // Bounded, explainable reputation nudges (mirror the AI engine).
    releaseWeight += input.sellerReputation * 0.25;
    refundWeight += (1 - input.buyerReputation) * 0.25;

    const total = releaseWeight + refundWeight;
    const recommendation =
      releaseWeight >= refundWeight
        ? AiRecommendation.Release
        : AiRecommendation.Refund;
    const confidence =
      total === 0
        ? 0
        : Number(
            (Math.max(releaseWeight, refundWeight) / total).toFixed(4),
          );

    const signals = input.evidence.map(
      (item) => `${item.kind}->${item.supports}(${item.weight.toFixed(2)})`,
    );
    signals.push(`buyer_rep=${input.buyerReputation.toFixed(2)}`);
    signals.push(`seller_rep=${input.sellerReputation.toFixed(2)}`);

    return {
      recommendation,
      confidence,
      explanation:
        `Weighted evidence favours ${recommendation} ` +
        `(release=${releaseWeight.toFixed(2)} vs refund=${refundWeight.toFixed(2)}).` +
        (conflicting ? " Conflicting evidence present." : ""),
      signals,
      requiresHumanReview: conflicting || confidence < 0.9,
    };
  }
}
