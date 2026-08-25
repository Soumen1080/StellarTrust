/**
 * Feedback persistence boundary (Phase 6).
 *
 * The record here is the FULL submission, contact details included. Nothing in
 * this file returns a record to a caller outside the module: the service maps
 * it through {@link toFeedbackDTO} first, and that DTO has no field an email or
 * wallet address could occupy. Keeping the widening impossible at the type
 * level is cheaper than remembering to strip fields in five route handlers.
 */
import type { FeedbackDTO } from "@stellartrust/shared";

/** A stored submission — published columns plus the contact PII. */
export interface FeedbackRecord {
  id: string;
  /** Author's account, or null once that account is deleted. */
  userId: string | null;
  name: string;
  message: string;
  rating: number;
  /** Contact PII. Never leaves the module. */
  email: string;
  /** Contact PII. Never leaves the module. */
  walletAddress: string;
  createdAt: string;
}

export interface FeedbackRepository {
  /** Newest first. */
  list(limit: number): Promise<FeedbackRecord[]>;
  /** Every rating ever left, for the summary. Ratings are not PII. */
  listRatings(): Promise<number[]>;
  findByUser(userId: string): Promise<FeedbackRecord | undefined>;
  save(record: FeedbackRecord): Promise<void>;
}

/** The public projection. The only shape a route may return. */
export function toFeedbackDTO(record: FeedbackRecord): FeedbackDTO {
  return {
    id: record.id,
    name: record.name,
    message: record.message,
    rating: record.rating,
    createdAt: record.createdAt,
  };
}

export class InMemoryFeedbackRepository implements FeedbackRepository {
  private readonly records = new Map<string, FeedbackRecord>();

  async list(limit: number): Promise<FeedbackRecord[]> {
    return [...this.records.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async listRatings(): Promise<number[]> {
    return [...this.records.values()].map((record) => record.rating);
  }

  async findByUser(userId: string): Promise<FeedbackRecord | undefined> {
    return [...this.records.values()].find(
      (record) => record.userId === userId,
    );
  }

  async save(record: FeedbackRecord): Promise<void> {
    this.records.set(record.id, record);
  }
}
