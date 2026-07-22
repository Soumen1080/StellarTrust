/**
 * Dispute service (Phase 4 — Disputes + AI advisory).
 *
 * Owns the dispute lifecycle: open → collect evidence (bounded window) → AI
 * advisory → resolution. The AI is advisory only (Rules.md §3, §6): it never
 * moves funds or writes the ledger. The backend applies the human gate — a
 * dispute may auto-resolve ONLY below the amount threshold AND above the
 * confidence threshold with a non-conflicting, non-manual advisory; everything
 * else requires a human compliance sign-off. Every AI advisory and every final
 * decision is append-only audit-logged and reproducible from the stored inputs.
 *
 * Fund movement itself remains the compliance-operated escrow/payments arbiter
 * path (Phase 2); a resolved dispute is the auditable authority for that action.
 */
import { randomUUID } from "node:crypto";
import {
  AiRecommendation,
  CURRENCY_SCALE,
  DisputeDecisionMaker,
  DisputeResolution,
  DisputeStatus,
  disputeEvidenceInputSchema,
  openDisputeInputSchema,
  type AiAdvisory,
  type DisputeDecisionInput,
  type DisputeDTO,
  type DisputeEvidenceDTO,
  type DisputeEvidenceInput,
  type OpenDisputeInput,
  type OrderDTO,
} from "@stellartrust/shared";
import { config } from "../../config/index.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../lib/errors.js";
import type { AuditRepository } from "../audit/audit.repository.js";
import type { DisputeRiskClient } from "./dispute-risk.client.js";
import type {
  DisputeOrderGateway,
  DisputeRepository,
} from "./dispute.repository.js";

export interface DisputeActor {
  userId: string;
  roles: string[];
}

/** Neutral default reputation until a reputation store exists (Phase 6). */
const DEFAULT_REPUTATION = 0.5;

export class DisputeService {
  constructor(
    private readonly repository: DisputeRepository,
    private readonly orders: DisputeOrderGateway,
    private readonly risk: DisputeRiskClient,
    private readonly audit: AuditRepository,
  ) {}

  async open(
    actor: DisputeActor,
    input: OpenDisputeInput,
  ): Promise<DisputeDTO> {
    const parsed = openDisputeInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        "Invalid dispute request",
        parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    }

    const order = await this.requireOrderParty(parsed.data.orderId, actor);

    const existing = await this.repository.findOpenByOrder(order.id);
    if (existing) {
      throw new ConflictError("An open dispute already exists for this order");
    }

    const now = new Date();
    const dispute: DisputeDTO = {
      id: randomUUID(),
      orderId: order.id,
      escrowId: null,
      status: DisputeStatus.EvidenceWindow,
      amount: order.amount,
      openedBy: actor.userId,
      reason: parsed.data.reason,
      evidence: [],
      advisory: null,
      autoResolvable: false,
      resolution: null,
      evidenceWindowClosesAt: new Date(
        now.getTime() + config.DISPUTE_EVIDENCE_WINDOW_HOURS * 3_600_000,
      ).toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await this.repository.save(dispute);
    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: "dispute.opened",
      entity: "dispute",
      entityId: dispute.id,
      metadata: { orderId: order.id, amountCurrency: order.amount.currency },
    });
    return dispute;
  }

  async submitEvidence(
    actor: DisputeActor,
    disputeId: string,
    input: DisputeEvidenceInput,
  ): Promise<DisputeDTO> {
    const parsed = disputeEvidenceInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        "Invalid evidence",
        parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    }

    const dispute = await this.requireDispute(disputeId);
    await this.requireOrderParty(dispute.orderId, actor);
    if (dispute.resolution) {
      throw new ConflictError("Dispute is already resolved");
    }
    if (new Date().toISOString() > dispute.evidenceWindowClosesAt) {
      throw new ConflictError("The evidence submission window has closed");
    }

    const evidence: DisputeEvidenceDTO = {
      ...parsed.data,
      id: randomUUID(),
      submittedBy: actor.userId,
      createdAt: new Date().toISOString(),
    };
    const evidenceList = [...dispute.evidence, evidence];

    // Recompute the advisory from the full evidence set so it is always a
    // reproducible function of the stored inputs (Rules.md §6).
    const result = await this.risk.recommend({
      disputeRef: dispute.id,
      amountMinor: dispute.amount.amount,
      currency: dispute.amount.currency,
      evidence: evidenceList,
      buyerReputation: DEFAULT_REPUTATION,
      sellerReputation: DEFAULT_REPUTATION,
    });
    const advisory: AiAdvisory = {
      recommendation: result.recommendation,
      confidence: result.confidence,
      explanation: result.explanation,
      signals: result.signals,
    };
    const autoResolvable = this.isAutoResolvable(
      advisory,
      result.requiresHumanReview,
      dispute.amount,
    );

    const next: DisputeDTO = {
      ...dispute,
      status: DisputeStatus.UnderReview,
      evidence: evidenceList,
      advisory,
      autoResolvable,
      updatedAt: new Date().toISOString(),
    };
    await this.repository.save(next);

    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: "dispute.evidence_submitted",
      entity: "dispute",
      entityId: dispute.id,
      metadata: { evidenceId: evidence.id, kind: evidence.kind },
    });
    // Advisory decisions are audited separately (AI is accountable and logged).
    await this.audit.append({
      actor: "ai:dispute-advisory",
      action: "dispute.advisory",
      entity: "dispute",
      entityId: dispute.id,
      metadata: {
        recommendation: advisory.recommendation,
        confidence: advisory.confidence,
        requiresHumanReview: result.requiresHumanReview,
        autoResolvable,
        signals: advisory.signals,
      },
    });
    return next;
  }

  /**
   * Resolve a dispute. If `decision` is provided, a human compliance reviewer is
   * signing off (required above thresholds). If omitted, the dispute must be
   * auto-resolvable under the policy thresholds; otherwise resolution is
   * rejected and a human decision is required.
   */
  async resolve(
    actor: DisputeActor,
    disputeId: string,
    decision?: DisputeDecisionInput,
  ): Promise<DisputeDTO> {
    const dispute = await this.requireDispute(disputeId);
    if (dispute.resolution) {
      throw new ConflictError("Dispute is already resolved");
    }
    if (!dispute.advisory) {
      throw new ConflictError(
        "Dispute cannot be resolved before any evidence and advisory exist",
      );
    }

    let resolutionOutcome: DisputeResolution;
    let decidedBy: DisputeDecisionMaker;
    let resolvedActor: string;
    let reason: string;

    if (decision) {
      // Human sign-off. Only a compliance reviewer may make the final decision.
      if (!actor.roles.includes("compliance")) {
        throw new ForbiddenError("A dispute decision requires compliance access");
      }
      resolutionOutcome = decision.decision;
      decidedBy = DisputeDecisionMaker.Human;
      resolvedActor = `user:${actor.userId}`;
      reason = decision.reason;
    } else {
      // Auto path — only permitted strictly within the policy thresholds.
      if (!dispute.autoResolvable) {
        throw new ForbiddenError(
          "This dispute exceeds the auto-resolve thresholds and requires a human decision",
        );
      }
      resolutionOutcome =
        dispute.advisory.recommendation === AiRecommendation.Refund
          ? DisputeResolution.Refund
          : DisputeResolution.Release;
      decidedBy = DisputeDecisionMaker.AutoPolicy;
      resolvedActor = "auto_policy";
      reason = `Auto-resolved within policy thresholds (confidence ${dispute.advisory.confidence}).`;
    }

    const now = new Date().toISOString();
    const resolved: DisputeDTO = {
      ...dispute,
      status: DisputeStatus.Resolved,
      resolution: {
        outcome: resolutionOutcome,
        decidedBy,
        actor: resolvedActor,
        reason,
        decidedAt: now,
      },
      updatedAt: now,
    };
    await this.repository.save(resolved);

    await this.audit.append({
      actor: resolvedActor,
      action: "dispute.resolved",
      entity: "dispute",
      entityId: dispute.id,
      metadata: {
        outcome: resolutionOutcome,
        decidedBy,
        orderId: dispute.orderId,
        // Snapshot the advisory the decision was made against (reproducible).
        advisoryRecommendation: dispute.advisory.recommendation,
        advisoryConfidence: dispute.advisory.confidence,
      },
    });
    return resolved;
  }

  async list(userId: string): Promise<DisputeDTO[]> {
    return this.repository.listForUser(userId);
  }

  async queue(actor: DisputeActor): Promise<DisputeDTO[]> {
    if (!actor.roles.includes("compliance")) {
      throw new ForbiddenError("The dispute queue requires compliance access");
    }
    return this.repository.listOpen();
  }

  async details(disputeId: string, actor: DisputeActor): Promise<DisputeDTO> {
    const dispute = await this.requireDispute(disputeId);
    const isParty = await this.isOrderParty(dispute.orderId, actor.userId);
    if (!isParty && !actor.roles.includes("compliance")) {
      throw new ForbiddenError("Only an order party or compliance may view this dispute");
    }
    return dispute;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * A dispute may auto-resolve only strictly within the configured thresholds:
   * below the max amount AND at/above the min confidence, with a concrete
   * (non-manual, non-conflicting) advisory. Otherwise a human must decide.
   */
  private isAutoResolvable(
    advisory: AiAdvisory,
    requiresHumanReview: boolean,
    amount: OrderDTO["amount"],
  ): boolean {
    if (requiresHumanReview) return false;
    if (advisory.recommendation === AiRecommendation.ManualReview) return false;
    if (advisory.confidence < config.AUTO_RESOLVE_MIN_CONFIDENCE) return false;

    const scale = CURRENCY_SCALE[amount.currency] ?? 2;
    const majorUnits = Number(amount.amount) / 10 ** scale;
    return majorUnits < config.AUTO_RESOLVE_MAX_AMOUNT;
  }

  private async requireDispute(disputeId: string): Promise<DisputeDTO> {
    const dispute = await this.repository.find(disputeId);
    if (!dispute) throw new NotFoundError("Dispute not found");
    return dispute;
  }

  private async requireOrderParty(
    orderId: string,
    actor: DisputeActor,
  ): Promise<OrderDTO> {
    const order = await this.orders.getOrder(orderId);
    if (!order) throw new NotFoundError("Order not found");
    if (order.buyerId !== actor.userId && order.sellerId !== actor.userId) {
      throw new ForbiddenError("Only an order party may open or evidence a dispute");
    }
    return order;
  }

  private async isOrderParty(
    orderId: string,
    userId: string,
  ): Promise<boolean> {
    const order = await this.orders.getOrder(orderId);
    return Boolean(
      order && (order.buyerId === userId || order.sellerId === userId),
    );
  }
}
