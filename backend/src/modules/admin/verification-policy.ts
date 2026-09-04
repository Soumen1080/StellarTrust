/**
 * Verification routing policy — whether a decision is made automatically, with
 * the advisory risk engine, or by a person.
 *
 * This used to be three environment variables, which means changing it is a
 * redeploy. That is the wrong shape for a control an operator has to tune
 * against live fraud patterns: the moment you need it loosened or tightened is
 * the moment you cannot wait for a build.
 *
 * It is now a row (migration 0022) that an operator edits through the admin
 * console, and every edit is audited — a control that can be loosened without
 * a trace is not a control.
 *
 * **AI stays advisory in every mode** (Rules.md §6). `auto` does not mean the
 * model decides; it means the *deterministic policy* is allowed to conclude
 * without queueing a human. The model never approves anything on its own in
 * any mode, and the amount gate below overrides every mode.
 */

/** Domains that have a verification decision to route. */
export const VerificationDomain = {
  Kyc: "kyc",
  RwaAsset: "rwa_asset",
} as const;
export type VerificationDomain =
  (typeof VerificationDomain)[keyof typeof VerificationDomain];

export const VerificationMode = {
  /** Decide from the deterministic policy alone; no human queue when confident. */
  Auto: "auto",
  /** Consult the advisory engine, then apply the thresholds. The default. */
  Ai: "ai",
  /** Everything queues for a person, whatever the engine says. */
  Human: "human",
} as const;
export type VerificationMode =
  (typeof VerificationMode)[keyof typeof VerificationMode];

export interface VerificationPolicy {
  domain: VerificationDomain;
  mode: VerificationMode;
  /** Risk at or below which an automatic approval is allowed, in basis points. */
  approveMaxRiskBps: number;
  /** Risk at or above which an automatic rejection is allowed, in basis points. */
  rejectMinRiskBps: number;
  /** Below this confidence the advisory is not trusted; a human decides. */
  minConfidenceBps: number;
  /**
   * Above this amount (minor units) a decision always requires a human, even
   * when every threshold is satisfied (Rules.md §6). Zero disables the gate.
   */
  humanReviewAboveAmount: string;
  updatedBy: string | null;
  updatedAt: string;
}

export interface UpdateVerificationPolicyInput {
  mode?: VerificationMode;
  approveMaxRiskBps?: number;
  rejectMinRiskBps?: number;
  minConfidenceBps?: number;
  humanReviewAboveAmount?: string;
}

/**
 * The policy applied when nothing has been configured.
 *
 * Matches the behaviour that was previously compiled in
 * (KYC_APPROVE_MAX_RISK=0.35, KYC_REJECT_MIN_RISK=0.7,
 * KYC_MIN_CONFIDENCE=0.7), so introducing this table changed nothing until an
 * operator decided otherwise.
 */
export const DEFAULT_POLICIES: Readonly<
  Record<VerificationDomain, VerificationPolicy>
> = Object.freeze({
  kyc: {
    domain: VerificationDomain.Kyc,
    mode: VerificationMode.Ai,
    approveMaxRiskBps: 3_500,
    rejectMinRiskBps: 7_000,
    minConfidenceBps: 7_000,
    humanReviewAboveAmount: "0",
    updatedBy: null,
    updatedAt: "1970-01-01T00:00:00.000Z",
  },
  rwa_asset: {
    // Asset verification has always required a compliance decision (§3.1) and
    // this preserves that. An operator can loosen it; the default does not.
    domain: VerificationDomain.RwaAsset,
    mode: VerificationMode.Human,
    approveMaxRiskBps: 3_500,
    rejectMinRiskBps: 7_000,
    minConfidenceBps: 7_000,
    humanReviewAboveAmount: "0",
    updatedBy: null,
    updatedAt: "1970-01-01T00:00:00.000Z",
  },
});

/** What a policy decides for one case. */
export const RoutingOutcome = {
  AutoApprove: "auto_approve",
  AutoReject: "auto_reject",
  HumanReview: "human_review",
} as const;
export type RoutingOutcome =
  (typeof RoutingOutcome)[keyof typeof RoutingOutcome];

export interface RoutingDecision {
  outcome: RoutingOutcome;
  /** Machine-readable reasons, in the order they were established. */
  reasons: string[];
}

export interface RoutingInput {
  /** Advisory risk, 0..1. */
  riskScore: number;
  /** Advisory confidence, 0..1. */
  confidence: number;
  /** Whether the advisory engine answered at all. */
  aiAvailable: boolean;
  /** A hard provider failure, sanctions hit, or conflicting evidence. */
  hardFailure?: boolean;
  /** The amount at stake, minor units. Absent when the decision has none. */
  amount?: bigint;
}

/**
 * Route one case under one policy.
 *
 * A pure function: the same inputs give the same decision, every time, which
 * is what makes a routing decision reproducible for audit (Rules.md §6). It
 * reads the policy rather than the environment, so the admin console changing
 * a threshold changes the next decision and not the ones already made.
 *
 * The order below is the policy, and it is deliberately fail-closed: every
 * escape hatch routes *towards* a human, never away from one.
 */
export function routeVerification(
  policy: VerificationPolicy,
  input: RoutingInput,
): RoutingDecision {
  const reasons: string[] = [];

  // 1. Human mode short-circuits everything. It is the setting an operator
  //    reaches for during an incident, so nothing may override it.
  if (policy.mode === VerificationMode.Human) {
    return {
      outcome: RoutingOutcome.HumanReview,
      reasons: ["policy_mode_human"],
    };
  }

  // 2. The amount gate outranks every threshold (Rules.md §6: no autonomous
  //    money decision above threshold). Checked before the risk bands so a
  //    large, low-risk case still reaches a person.
  const ceiling = BigInt(policy.humanReviewAboveAmount);
  if (ceiling > 0n && input.amount !== undefined && input.amount > ceiling) {
    return {
      outcome: RoutingOutcome.HumanReview,
      reasons: ["amount_above_human_review_threshold"],
    };
  }

  // 3. A hard failure is never automated away, in any mode.
  if (input.hardFailure) reasons.push("hard_failure");

  // 4. An engine that did not answer is not evidence of low risk. In `ai` mode
  //    its absence routes to a human; in `auto` mode the deterministic policy
  //    was never going to consult it, so it is not a reason on its own.
  if (!input.aiAvailable && policy.mode === VerificationMode.Ai) {
    reasons.push("ai_unavailable");
  }

  // 5. An answer we do not trust is not an answer.
  if (
    policy.mode === VerificationMode.Ai &&
    input.confidence * 10_000 < policy.minConfidenceBps
  ) {
    reasons.push("low_confidence");
  }

  if (reasons.length > 0) {
    return { outcome: RoutingOutcome.HumanReview, reasons };
  }

  const riskBps = input.riskScore * 10_000;
  if (riskBps <= policy.approveMaxRiskBps) {
    return { outcome: RoutingOutcome.AutoApprove, reasons: ["low_risk"] };
  }
  if (riskBps >= policy.rejectMinRiskBps) {
    return { outcome: RoutingOutcome.AutoReject, reasons: ["high_risk"] };
  }

  // Between the bands is exactly the case a person exists to judge.
  return {
    outcome: RoutingOutcome.HumanReview,
    reasons: ["borderline_risk"],
  };
}

/**
 * Reject a policy that cannot mean anything before it is stored.
 *
 * The database has the same constraints (migration 0022). Both are here so a
 * bad edit fails at the boundary with a message an operator can act on,
 * instead of as a constraint violation they have to decode.
 */
export function validatePolicyUpdate(
  current: VerificationPolicy,
  update: UpdateVerificationPolicyInput,
): string[] {
  const errors: string[] = [];
  const merged = { ...current, ...update };

  for (const [field, value] of [
    ["approveMaxRiskBps", merged.approveMaxRiskBps],
    ["rejectMinRiskBps", merged.rejectMinRiskBps],
    ["minConfidenceBps", merged.minConfidenceBps],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 10_000) {
      errors.push(`${field} must be an integer between 0 and 10000 (basis points)`);
    }
  }

  // An approval band overlapping the rejection band is not a policy, it is two
  // contradictory instructions.
  if (merged.approveMaxRiskBps >= merged.rejectMinRiskBps) {
    errors.push(
      "approveMaxRiskBps must be below rejectMinRiskBps, or the approval and " +
        "rejection bands overlap",
    );
  }

  if (!/^\d+$/.test(String(merged.humanReviewAboveAmount))) {
    errors.push("humanReviewAboveAmount must be a non-negative integer in minor units");
  }

  if (
    update.mode !== undefined &&
    !Object.values(VerificationMode).includes(update.mode)
  ) {
    errors.push(`mode must be one of ${Object.values(VerificationMode).join(", ")}`);
  }

  return errors;
}
