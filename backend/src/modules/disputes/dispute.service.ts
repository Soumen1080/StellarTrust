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
  DISPUTABLE_ORDER_STATUSES,
  DisputeDecisionMaker,
  DisputeLogActor,
  DisputeResolution,
  DisputeSettlementStatus,
  DisputeStatus,
  disputeEvidenceInputSchema,
  openDisputeInputSchema,
  type AiAdvisory,
  type DisputeDecisionInput,
  type DisputeDTO,
  type DisputeEvidenceDTO,
  type DisputeEvidenceInput,
  type DisputeLogEntryDTO,
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
import { logger } from "../../lib/logger.js";
import type { AuditRepository } from "../audit/audit.repository.js";
import type { DomainEvent } from "../events/event.repository.js";
import {
  DomainEventType,
  EventEntity,
  dedupeKey,
} from "../events/event.types.js";
import type { ReputationService } from "../reputation/reputation.service.js";
import type { DisputeRiskClient } from "./dispute-risk.client.js";
import type {
  DisputeChainGateway,
  DisputeOrderGateway,
  DisputeRepository,
  DisputeSettlementGateway,
} from "./dispute.repository.js";

export interface DisputeActor {
  userId: string;
  roles: string[];
}

/** Neutral fallback when no reputation service is wired (e.g. isolated tests). */
const DEFAULT_REPUTATION = 0.5;

/**
 * The publish side of the event spine, as a narrow port.
 *
 * Structurally satisfied by `EventBus`. Disputes depends on the capability to
 * announce a fact, not on the bus's class.
 */
export interface DisputeEventPublisher {
  publish(event: Omit<DomainEvent, "id" | "occurredAt">): Promise<DomainEvent>;
}

export class DisputeService {
  constructor(
    private readonly repository: DisputeRepository,
    private readonly orders: DisputeOrderGateway,
    private readonly risk: DisputeRiskClient,
    private readonly audit: AuditRepository,
    private readonly reputation?: ReputationService,
    private readonly settlement?: DisputeSettlementGateway,
    private readonly chain?: DisputeChainGateway,
    /**
     * The event spine (plane.md §2.3). Optional so existing constructions keep
     * working; when present, opening and resolving a dispute publish facts that
     * the RWA module subscribes to in order to hold and release payouts.
     */
    private readonly events?: DisputeEventPublisher,
  ) {}

  /**
   * Whether an order has an unresolved dispute (plane.md §2.2).
   *
   * Satisfies the `DisputeReader` port the RWA module depends on: it needs one
   * boolean before paying investors, not the dispute record itself.
   */
  async hasOpenDispute(orderId: string): Promise<boolean> {
    return (await this.repository.findOpenByOrder(orderId)) !== undefined;
  }

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

    // A dispute is a claim over money that is actually held. Before `deposited`
    // nothing has been committed, and after release/refund/cancellation there is
    // nothing left to adjudicate — opening a claim there produces a record that
    // can never be executed, which reads to the parties as protection they do
    // not have.
    if (!DISPUTABLE_ORDER_STATUSES.includes(order.status)) {
      throw new ConflictError(
        `An order in "${order.status}" cannot be disputed — a dispute needs funds committed and not yet settled`,
      );
    }

    const existing = await this.repository.findOpenByOrder(order.id);
    if (existing) {
      throw new ConflictError("An open dispute already exists for this order");
    }

    // Name the custody the claim is about, at the moment the claim is made.
    const escrow = await this.orders.getEscrow(order.id);

    const now = new Date();
    const dispute: DisputeDTO = {
      id: randomUUID(),
      orderId: order.id,
      escrowId: escrow?.id ?? null,
      contractId: escrow?.contractId ?? null,
      status: DisputeStatus.EvidenceWindow,
      amount: order.amount,
      openedBy: actor.userId,
      buyerId: order.buyerId,
      sellerId: order.sellerId,
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
      metadata: {
        orderId: order.id,
        amountCurrency: order.amount.currency,
        escrowId: dispute.escrowId,
        contractId: dispute.contractId,
        // Role, not id: the log is read by the counterparty.
        openedByRole: this.roleOf(dispute, actor.userId),
        orderStatus: order.status,
      },
    });
    await this.freezeCustody(dispute, actor);
    // Announce the claim. The RWA module subscribes to hold any payout on a
    // tokenization linked to this order (plane.md §2.2) — disputes does not
    // know that, and does not need to.
    await this.publishFact(
      DomainEventType.DisputeOpened,
      dispute.id,
      `user:${actor.userId}`,
      { orderId: dispute.orderId },
      dispute.id,
    );
    return dispute;
  }

  /**
   * Publish a dispute fact, tolerating a spine failure.
   *
   * The dispute itself has already been persisted by the time this runs, so
   * throwing here would report a filed dispute as failed. The event is durable
   * once written, which makes a missed publish recoverable.
   */
  private async publishFact(
    eventType: DomainEventType,
    disputeId: string,
    actor: string,
    payload: Record<string, unknown>,
    qualifier?: string,
  ): Promise<void> {
    if (!this.events) return;
    try {
      await this.events.publish({
        eventType,
        entity: EventEntity.Dispute,
        entityId: disputeId,
        actor,
        payload,
        // Qualified by the dispute id: one order may be disputed, resolved,
        // and disputed again, and each is a distinct fact.
        dedupeKey: dedupeKey(eventType, disputeId, qualifier),
      });
    } catch (error) {
      logger.error(
        { err: error, disputeId, eventType },
        "failed to publish dispute event",
      );
    }
  }

  /**
   * Move the escrow contract into `Disputed` so the claim actually binds
   * on-chain.
   *
   * A dispute that exists only in our tables leaves the contract in `Locked`,
   * from which the arbiter cannot release when the dispute resolves — the
   * resolution would be recorded and then fail to execute. Doing it at open
   * time also stops the counterparty from confirming and releasing out from
   * under an active claim.
   *
   * Non-fatal: the dispute record is the authority for the claim, and the
   * wallet-signed deployments genuinely cannot do this server-side. Failure is
   * audited so a compliance operator can escalate it explicitly.
   */
  private async freezeCustody(
    dispute: DisputeDTO,
    actor: DisputeActor,
  ): Promise<void> {
    if (!this.chain || !dispute.contractId) return;
    try {
      await this.chain.markDisputed({
        orderId: dispute.orderId,
        actorUserId: actor.userId,
      });
      await this.audit.append({
        actor: `user:${actor.userId}`,
        action: "dispute.custody_frozen",
        entity: "dispute",
        entityId: dispute.id,
        metadata: { orderId: dispute.orderId, contractId: dispute.contractId },
      });
    } catch (err) {
      await this.audit.append({
        actor: "system:dispute-chain",
        action: "dispute.custody_freeze_failed",
        entity: "dispute",
        entityId: dispute.id,
        metadata: {
          orderId: dispute.orderId,
          contractId: dispute.contractId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
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
    const order = await this.requireOrderParty(dispute.orderId, actor);
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

    // Reputation is an advisory prior (Phase 6): fetch the parties' scores when
    // a reputation store is wired, else fall back to neutral.
    const [buyerReputation, sellerReputation] = await Promise.all([
      this.reputationScore(order.buyerId),
      this.reputationScore(order.sellerId),
    ]);

    // Recompute the advisory from the full evidence set so it is always a
    // reproducible function of the stored inputs (Rules.md §6).
    const result = await this.risk.recommend({
      disputeRef: dispute.id,
      amountMinor: dispute.amount.amount,
      currency: dispute.amount.currency,
      evidence: evidenceList,
      buyerReputation,
      sellerReputation,
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
      metadata: {
        evidenceId: evidence.id,
        kind: evidence.kind,
        supports: evidence.supports,
        weight: evidence.weight,
        submittedByRole: this.roleOf(dispute, actor.userId),
      },
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

    let resolutionOutcome: DisputeResolution;
    let decidedBy: DisputeDecisionMaker;
    let resolvedActor: string;
    let reason: string;

    if (decision) {
      // Human sign-off. Only a compliance reviewer may make the final decision.
      if (!actor.roles.includes("compliance")) {
        throw new ForbiddenError("A dispute decision requires compliance access");
      }
      // A compliance reviewer may decide without an advisory once the evidence
      // window has closed. Requiring one unconditionally deadlocks the case
      // nobody evidenced: the funds stay frozen with no path to a decision,
      // which is the worst outcome for both parties.
      if (!dispute.advisory && !this.evidenceWindowClosed(dispute)) {
        throw new ConflictError(
          "No evidence has been submitted yet — wait for the evidence window to close before deciding",
        );
      }
      resolutionOutcome = decision.decision;
      decidedBy = DisputeDecisionMaker.Human;
      resolvedActor = `user:${actor.userId}`;
      reason = decision.reason;
    } else {
      if (!dispute.advisory) {
        throw new ConflictError(
          "Dispute cannot be auto-resolved before any evidence and advisory exist",
        );
      }
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
        // The transfer has not been attempted yet; the record says so rather
        // than implying the money has already moved.
        settlement: {
          status: DisputeSettlementStatus.Pending,
          detail: null,
          updatedAt: now,
        },
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
        advisoryRecommendation: dispute.advisory?.recommendation ?? null,
        advisoryConfidence: dispute.advisory?.confidence ?? null,
        decidedWithoutAdvisory: dispute.advisory === null,
      },
    });

    // Phase 6: update the advisory reputation prior and auto-execute the
    // resolved fund movement through the arbiter payments path. Reputation is
    // best-effort; the settlement attempt's OUTCOME is written back onto the
    // dispute so the parties can see whether the money actually moved.
    await this.updateReputation(dispute.orderId, resolutionOutcome, dispute.id);

    // The outcome decides whether a held RWA position resumes or defaults
    // (plane.md §2.2). Published before the settlement executes so the hold is
    // lifted against the same decision the money moves on.
    await this.publishFact(
      DomainEventType.DisputeResolved,
      dispute.id,
      resolvedActor,
      { orderId: dispute.orderId, outcome: resolutionOutcome },
      dispute.id,
    );

    return this.autoExecuteSettlement(resolved, resolutionOutcome);
  }

  /** Disputes the user is party to — as buyer or seller, not just the opener. */
  async list(userId: string, orderId?: string): Promise<DisputeDTO[]> {
    const disputes = await this.repository.listForParty(userId);
    const scoped = orderId
      ? disputes.filter((dispute) => dispute.orderId === orderId)
      : disputes;
    return scoped.map((dispute) => this.withDerivedStatus(dispute));
  }

  /**
   * The dispute's history, projected from the append-only audit log into lines
   * the parties can read. Same access rule as the dispute itself.
   */
  async log(
    disputeId: string,
    actor: DisputeActor,
  ): Promise<DisputeLogEntryDTO[]> {
    const dispute = await this.details(disputeId, actor);
    const events = await this.audit.listForEntity("dispute", dispute.id);
    return events
      .map((event) => ({
        id: event.id,
        action: event.action,
        actor: this.logActorFor(dispute, event.actor, event.metadata),
        summary: this.summarize(event.action, event.metadata),
        metadata: event.metadata,
        at: event.createdAt,
      }))
      .sort((left, right) => left.at.localeCompare(right.at));
  }

  async queue(actor: DisputeActor): Promise<DisputeDTO[]> {
    if (!actor.roles.includes("compliance")) {
      throw new ForbiddenError("The dispute queue requires compliance access");
    }
    const open = await this.repository.listOpen();
    // Same derivation as the party-facing list: a reviewer sorting the queue
    // needs to see which cases have closed their evidence window and are
    // actually waiting on them.
    return open.map((dispute) => this.withDerivedStatus(dispute));
  }

  async details(disputeId: string, actor: DisputeActor): Promise<DisputeDTO> {
    const dispute = await this.requireDispute(disputeId);
    const isParty = await this.isOrderParty(dispute.orderId, actor.userId);
    if (!isParty && !actor.roles.includes("compliance")) {
      throw new ForbiddenError("Only an order party or compliance may view this dispute");
    }
    return this.withDerivedStatus(dispute);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private evidenceWindowClosed(dispute: DisputeDTO): boolean {
    return new Date().toISOString() > dispute.evidenceWindowClosesAt;
  }

  /**
   * Reflect a lapsed evidence window in the status the parties are shown.
   *
   * The window closing is a real transition — no more evidence is accepted —
   * but nothing was writing it down, so a dispute nobody evidenced kept
   * advertising "evidence window" forever while silently rejecting evidence.
   * Derived at read time rather than by a sweep job: the closing time is
   * already on the record, so a second source of truth would only be a way for
   * the two to disagree.
   */
  private withDerivedStatus(dispute: DisputeDTO): DisputeDTO {
    if (
      dispute.status === DisputeStatus.EvidenceWindow &&
      this.evidenceWindowClosed(dispute)
    ) {
      return { ...dispute, status: DisputeStatus.UnderReview };
    }
    return dispute;
  }

  /** Which side of the order a user id is on, for role-labelled log lines. */
  private roleOf(dispute: DisputeDTO, userId: string): DisputeLogActor {
    if (userId === dispute.buyerId) return DisputeLogActor.Buyer;
    if (userId === dispute.sellerId) return DisputeLogActor.Seller;
    return DisputeLogActor.Compliance;
  }

  /**
   * Map an audit event's actor string onto a role. Party ids are resolved
   * against the dispute so the log never leaks a raw user id to the other side.
   */
  private logActorFor(
    dispute: DisputeDTO,
    auditActor: string,
    metadata: Record<string, unknown>,
  ): DisputeLogActor {
    if (auditActor.startsWith("ai:")) return DisputeLogActor.Ai;
    if (auditActor.startsWith("system:") || auditActor === "auto_policy") {
      return DisputeLogActor.System;
    }
    if (auditActor.startsWith("user:")) {
      const userId = auditActor.slice("user:".length);
      return this.roleOf(dispute, userId);
    }
    const recorded = metadata.submittedByRole ?? metadata.openedByRole;
    return typeof recorded === "string"
      ? (recorded as DisputeLogActor)
      : DisputeLogActor.System;
  }

  /** One readable line per audited action. Unknown actions degrade gracefully. */
  private summarize(
    action: string,
    metadata: Record<string, unknown>,
  ): string {
    switch (action) {
      case "dispute.opened":
        return `Dispute opened against order ${String(metadata.orderId ?? "")}`;
      case "dispute.custody_frozen":
        return "Escrow custody frozen on-chain — neither party can move the funds";
      case "dispute.custody_freeze_failed":
        return "Could not freeze escrow custody on-chain; escalated to compliance";
      case "dispute.evidence_submitted":
        return `Evidence submitted (${String(metadata.kind ?? "item")}, supports ${String(
          metadata.supports ?? "—",
        )})`;
      case "dispute.advisory":
        return `AI advisory: ${String(metadata.recommendation ?? "")} at ${Math.round(
          Number(metadata.confidence ?? 0) * 100,
        )}% confidence${metadata.autoResolvable === true ? " (within auto-resolve policy)" : " (human decision required)"}`;
      case "dispute.resolved":
        return `Resolved: ${String(metadata.outcome ?? "")} — decided by ${String(
          metadata.decidedBy ?? "",
        ).replace(/_/g, " ")}`;
      case "dispute.settlement_executed":
        return `Funds moved through the arbiter path (${String(metadata.outcome ?? "")})`;
      case "dispute.settlement_failed":
        return `Fund movement failed: ${String(metadata.error ?? "unknown error")}`;
      case "dispute.settlement_skipped":
        return `No funds to move: ${String(metadata.reason ?? "no locked custody")}`;
      default:
        return action.replace(/^dispute\./, "").replace(/_/g, " ");
    }
  }

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

  private async reputationScore(userId: string): Promise<number> {
    if (!this.reputation) return DEFAULT_REPUTATION;
    return this.reputation.getScore(userId);
  }

  /**
   * Update the advisory reputation prior from the resolved outcome. Release
   * favours the seller (the buyer's claim did not prevail); refund favours the
   * buyer. Advisory only — never gates money.
   */
  private async updateReputation(
    orderId: string,
    outcome: DisputeResolution,
    disputeId: string,
  ): Promise<void> {
    if (!this.reputation) return;
    const order = await this.orders.getOrder(orderId);
    if (!order) return;
    const winnerUserId =
      outcome === DisputeResolution.Refund ? order.buyerId : order.sellerId;
    const loserUserId =
      outcome === DisputeResolution.Refund ? order.sellerId : order.buyerId;
    try {
      await this.reputation.recordDisputeOutcome({
        winnerUserId,
        loserUserId,
        disputeId,
      });
    } catch {
      // Reputation is advisory; never fail a resolution because of it.
    }
  }

  /**
   * Auto-execute the resolved outcome through the arbiter payments path, then
   * write the RESULT back onto the dispute.
   *
   * The dispute record is the authorization, so a failed transfer never undoes
   * the decision — but it must not be invisible either. Previously the failure
   * went only to the audit log, leaving both parties looking at a dispute that
   * said "Resolved: refund" while the funds sat untouched in escrow. The
   * returned snapshot carries the execution state so the UI can say which of
   * the two happened, and compliance can find the ones owed a retry.
   */
  private async autoExecuteSettlement(
    resolved: DisputeDTO,
    outcome: DisputeResolution,
  ): Promise<DisputeDTO> {
    if (!this.settlement || !resolved.resolution) {
      return this.recordSettlementOutcome(
        resolved,
        DisputeSettlementStatus.NotApplicable,
        "No arbiter settlement path is configured for this deployment",
      );
    }
    try {
      await this.settlement.settle({
        orderId: resolved.orderId,
        outcome,
        disputeId: resolved.id,
      });
      await this.audit.append({
        actor: "system:dispute-settlement",
        action: "dispute.settlement_executed",
        entity: "dispute",
        entityId: resolved.id,
        metadata: { orderId: resolved.orderId, outcome },
      });
      return this.recordSettlementOutcome(
        resolved,
        DisputeSettlementStatus.Executed,
        null,
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.audit.append({
        actor: "system:dispute-settlement",
        action: "dispute.settlement_failed",
        entity: "dispute",
        entityId: resolved.id,
        metadata: { orderId: resolved.orderId, outcome, error },
      });
      return this.recordSettlementOutcome(
        resolved,
        DisputeSettlementStatus.Failed,
        error,
      );
    }
  }

  /** Persist and return the resolution's execution state. */
  private async recordSettlementOutcome(
    resolved: DisputeDTO,
    status: DisputeSettlementStatus,
    detail: string | null,
  ): Promise<DisputeDTO> {
    if (!resolved.resolution) return resolved;
    const now = new Date().toISOString();
    const next: DisputeDTO = {
      ...resolved,
      resolution: {
        ...resolved.resolution,
        settlement: { status, detail, updatedAt: now },
      },
      updatedAt: now,
    };
    await this.repository.save(next);
    return next;
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
