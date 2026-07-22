/**
 * Reputation service (Phase 6).
 *
 * Maintains a bounded 0..1 advisory reputation per user from completed orders
 * and resolved disputes. ADVISORY ONLY: reputation feeds the dispute AI
 * advisory as a prior and is surfaced read-only; it never gates money movement
 * (Rules.md §6). Every update is append-only audit-logged.
 */
import type { ReputationDTO } from "@stellartrust/shared";
import type { AuditRepository } from "../audit/audit.repository.js";
import {
  NEUTRAL_REPUTATION,
  computeScore,
  toDTO,
  type ReputationRecord,
  type ReputationRepository,
} from "./reputation.repository.js";

export class ReputationService {
  constructor(
    private readonly repository: ReputationRepository,
    private readonly audit: AuditRepository,
  ) {}

  /** Current 0..1 score (neutral 0.5 when there is no history). */
  async getScore(userId: string): Promise<number> {
    const record = await this.repository.get(userId);
    return record ? computeScore(record) : NEUTRAL_REPUTATION;
  }

  async getReputation(userId: string): Promise<ReputationDTO> {
    const record = await this.repository.get(userId);
    return toDTO(record ?? this.empty(userId));
  }

  /** Record a successfully completed (released) order for a party. */
  async recordOrderCompleted(userId: string): Promise<void> {
    const record = await this.load(userId);
    record.ordersCompleted += 1;
    await this.persist(record, "reputation.order_completed");
  }

  /**
   * Record a resolved dispute outcome. The winner gains a positive signal, the
   * loser a negative one. Callers pass the two parties and who prevailed.
   */
  async recordDisputeOutcome(input: {
    winnerUserId: string;
    loserUserId: string;
    disputeId: string;
  }): Promise<void> {
    const winner = await this.load(input.winnerUserId);
    winner.disputesWon += 1;
    await this.persist(winner, "reputation.dispute_won", {
      disputeId: input.disputeId,
    });

    const loser = await this.load(input.loserUserId);
    loser.disputesLost += 1;
    await this.persist(loser, "reputation.dispute_lost", {
      disputeId: input.disputeId,
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async load(userId: string): Promise<ReputationRecord> {
    return (await this.repository.get(userId)) ?? this.empty(userId);
  }

  private empty(userId: string): ReputationRecord {
    return {
      userId,
      ordersCompleted: 0,
      disputesWon: 0,
      disputesLost: 0,
      updatedAt: new Date().toISOString(),
    };
  }

  private async persist(
    record: ReputationRecord,
    action: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    record.updatedAt = new Date().toISOString();
    await this.repository.save(record);
    await this.audit.append({
      actor: "system:reputation",
      action,
      entity: "reputation",
      entityId: record.userId,
      metadata: {
        score: computeScore(record),
        ordersCompleted: record.ordersCompleted,
        disputesWon: record.disputesWon,
        disputesLost: record.disputesLost,
        ...extra,
      },
    });
  }
}
