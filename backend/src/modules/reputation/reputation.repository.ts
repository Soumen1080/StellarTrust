/**
 * Reputation persistence boundary (Phase 6).
 *
 * Stores only aggregate, non-PII counters per user. The score is derived, not
 * stored raw, so the formula can evolve without a migration. In-memory locally;
 * a Postgres adapter can be injected in staging/production.
 */
import type { ReputationDTO } from "@stellartrust/shared";

/** Raw counters we accumulate per user (score is computed from these). */
export interface ReputationRecord {
  userId: string;
  ordersCompleted: number;
  disputesWon: number;
  disputesLost: number;
  updatedAt: string;
}

export interface ReputationRepository {
  get(userId: string): Promise<ReputationRecord | undefined>;
  save(record: ReputationRecord): Promise<void>;
}

export class InMemoryReputationRepository implements ReputationRepository {
  private readonly records = new Map<string, ReputationRecord>();

  async get(userId: string): Promise<ReputationRecord | undefined> {
    return this.records.get(userId);
  }

  async save(record: ReputationRecord): Promise<void> {
    this.records.set(record.userId, record);
  }
}

/** Neutral baseline for a user with no history. */
export const NEUTRAL_REPUTATION = 0.5;

/**
 * Derive a bounded 0..1 score from the counters. A Wilson-style shrink toward
 * the neutral prior keeps low-history users near 0.5 and rewards a track record
 * without letting a single event swing the score. Advisory only.
 */
export function computeScore(record: ReputationRecord): number {
  const positives = record.disputesWon + record.ordersCompleted;
  const negatives = record.disputesLost;
  const total = positives + negatives;
  if (total === 0) return NEUTRAL_REPUTATION;
  // Additive smoothing (Laplace) toward the neutral prior with weight `k`.
  const k = 4;
  const score = (positives + k * NEUTRAL_REPUTATION) / (total + k);
  return Number(Math.min(1, Math.max(0, score)).toFixed(4));
}

export function toDTO(record: ReputationRecord): ReputationDTO {
  return {
    userId: record.userId,
    score: computeScore(record),
    ordersCompleted: record.ordersCompleted,
    disputesWon: record.disputesWon,
    disputesLost: record.disputesLost,
    updatedAt: record.updatedAt,
  };
}
