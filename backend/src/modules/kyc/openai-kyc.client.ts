/**
 * OpenAI-backed KYC profile-review engine (advisory only).
 *
 * Implements the same {@link KycRiskClient} boundary as the deterministic and
 * AI-service clients, so the KYC decision engine and human gate are unchanged:
 * this only supplies the *advisory* risk score/decision/explanation. It can
 * never move funds or write the ledger (Rules.md §3, §6).
 *
 * PII hygiene (Rules.md §6): only opaque references and normalized numeric
 * signals are sent to the model — never names, dates of birth, document
 * numbers, images, or raw provider payloads. Any failure throws, and the KYC
 * service degrades that to human review (it catches risk-client errors).
 *
 * Determinism: temperature is pinned to 0 and JSON mode is requested so a given
 * input is as reproducible as the model allows; every call is audit-logged by
 * the KYC service via the resulting advisory.
 */
import { z } from "zod";
import { KycDecision, type KycRiskAdvisory } from "@stellartrust/shared";
import { config } from "../../config/index.js";
import { ExternalServiceError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import type { KycRiskClient, KycRiskRequest } from "./kyc-risk.client.js";

const SYSTEM_PROMPT = [
  "You are an advisory KYC/AML risk analyst for a payments platform.",
  "You receive ONLY normalized, non-personal signals (opaque reference, numeric",
  "risk signals in [0,1] where higher means riskier, and two booleans).",
  "Return STRICT JSON only, matching this schema exactly:",
  '{"risk_score": number 0..1, "decision": "approve"|"review"|"reject",',
  ' "confidence": number 0..1, "explanation": string, "signals": string[]}.',
  "Rules:",
  "- If sanctions_hit is true, decision MUST be \"reject\" and risk_score >= 0.95.",
  "- Approve only clearly low-risk cases; reject only clearly high-risk cases;",
  "  otherwise use \"review\" so a human decides.",
  "- Base the assessment ONLY on the provided signals. Never use or infer",
  "  protected attributes (race, religion, gender, ethnicity, nationality).",
  "- explanation must be one or two plain sentences; signals must reference the",
  "  input signal names you relied on.",
].join(" ");

const responseSchema = z.object({
  risk_score: z.number().min(0).max(1),
  decision: z.enum([KycDecision.Approve, KycDecision.Review, KycDecision.Reject]),
  confidence: z.number().min(0).max(1),
  explanation: z.string().min(1),
  signals: z.array(z.string()).default([]),
});

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

export class OpenAiKycRiskClient implements KycRiskClient {
  constructor(private readonly apiKey: string) {}

  async score(input: KycRiskRequest): Promise<KycRiskAdvisory> {
    try {
      const userPayload = {
        subject_ref: input.subjectRef,
        signals: input.signals.map((signal) => ({
          name: signal.name,
          value: signal.value,
        })),
        sanctions_hit: input.sanctionsHit,
        new_party: input.newParty,
      };

      const response = await fetch(`${config.OPENAI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: config.OPENAI_MODEL,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: JSON.stringify(userPayload) },
          ],
        }),
        signal: AbortSignal.timeout(config.OPENAI_TIMEOUT_MS),
      });

      if (!response.ok) {
        // Do not log the response body — it may echo request content.
        throw new Error(`OpenAI returned ${response.status}`);
      }

      const completion = (await response.json()) as ChatCompletionResponse;
      const content = completion.choices?.[0]?.message?.content;
      if (!content) throw new Error("OpenAI returned an empty completion");

      const parsed = responseSchema.parse(JSON.parse(content));
      // Enforce the sanctions invariant regardless of model output.
      if (input.sanctionsHit && parsed.decision !== KycDecision.Reject) {
        return {
          riskScore: 1,
          decision: KycDecision.Reject,
          confidence: Math.max(parsed.confidence, 0.95),
          explanation:
            "Sanctions/AML signal present — reject and escalate to compliance.",
          signals: [...parsed.signals, "sanctions_hit"],
        };
      }
      return {
        riskScore: parsed.risk_score,
        decision: parsed.decision,
        confidence: parsed.confidence,
        explanation: parsed.explanation,
        signals: parsed.signals,
      };
    } catch (err) {
      logger.warn(
        { errorType: (err as Error).name },
        "OpenAI KYC advisory failed; caller will route to human review",
      );
      throw new ExternalServiceError("OpenAI KYC advisory unavailable", err);
    }
  }
}
