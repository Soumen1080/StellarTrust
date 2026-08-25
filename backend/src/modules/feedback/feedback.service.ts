/**
 * Product feedback service (Phase 6).
 *
 * Two responsibilities, both about the boundary between what was submitted and
 * what is published:
 *
 *   1. Everything leaving this service is a {@link FeedbackDTO}. Contact PII
 *      (email, wallet address) is accepted, stored, and never returned.
 *   2. One entry per account. The wall is public and unmoderated, so the only
 *      thing keeping it from being a spam surface is that posting requires a
 *      verified session and each account gets one opinion.
 */
import { randomUUID } from "node:crypto";
import {
  type FeedbackDTO,
  type FeedbackListResponse,
  type FeedbackSummaryDTO,
  FEEDBACK_RATING_MAX,
  FEEDBACK_RATING_MIN,
  feedbackInputSchema,
} from "@stellartrust/shared";
import { ConflictError, ValidationError } from "../../lib/errors.js";
import type { AuditRepository } from "../audit/audit.repository.js";
import {
  type FeedbackRepository,
  toFeedbackDTO,
} from "./feedback.repository.js";

/**
 * How many entries the public wall returns.
 *
 * The endpoint is unauthenticated, so an unbounded list is a free full-table
 * read for anyone who finds it. Newest-first with a cap keeps the response a
 * predictable size no matter how much feedback accumulates.
 */
export const FEEDBACK_PAGE_SIZE = 50;

export class FeedbackService {
  constructor(
    private readonly repository: FeedbackRepository,
    private readonly audit: AuditRepository,
  ) {}

  /** The public wall: published fields only, plus the aggregate. */
  async listPublic(): Promise<FeedbackListResponse> {
    const [records, ratings] = await Promise.all([
      this.repository.list(FEEDBACK_PAGE_SIZE),
      this.repository.listRatings(),
    ]);
    return {
      feedback: records.map(toFeedbackDTO),
      summary: summarize(ratings),
    };
  }

  /** The caller's own entry, if they have left one. */
  async findMine(userId: string): Promise<FeedbackDTO | null> {
    const record = await this.repository.findByUser(userId);
    return record ? toFeedbackDTO(record) : null;
  }

  async submit(
    userId: string,
    input: unknown,
  ): Promise<FeedbackDTO> {
    const parsed = feedbackInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues[0]?.message ?? "Invalid feedback",
      );
    }

    // Checked before the insert for a usable error message; the partial unique
    // index in migration 0013 is what actually enforces it under concurrency.
    if (await this.repository.findByUser(userId)) {
      throw new ConflictError("You have already left feedback");
    }

    const record = {
      id: randomUUID(),
      userId,
      name: parsed.data.name,
      message: parsed.data.message,
      rating: parsed.data.rating,
      email: parsed.data.email,
      walletAddress: parsed.data.walletAddress,
      createdAt: new Date().toISOString(),
    };
    await this.repository.save(record);

    // The audit trail records that feedback was left and how it was rated —
    // not the message, the email, or the wallet. An audit log is read by more
    // people than the table is, and copying PII into it widens the exposure
    // for no investigative gain (Rules.md §7).
    await this.audit.append({
      actor: `user:${userId}`,
      action: "feedback.submitted",
      entity: "feedback",
      entityId: record.id,
      metadata: { rating: record.rating },
    });

    return toFeedbackDTO(record);
  }
}

/** Mean and per-star counts. Every star value is present, including zeros. */
function summarize(ratings: number[]): FeedbackSummaryDTO {
  const distribution: Record<string, number> = {};
  for (let star = FEEDBACK_RATING_MIN; star <= FEEDBACK_RATING_MAX; star += 1) {
    distribution[String(star)] = 0;
  }
  for (const rating of ratings) {
    const key = String(rating);
    const seen = distribution[key];
    // Ignore anything outside 1..5. The schema and the CHECK constraint both
    // reject those, but a summary is not the place to throw over one bad row.
    if (seen !== undefined) distribution[key] = seen + 1;
  }
  const total = ratings.length;
  const averageRating = total
    ? Number((ratings.reduce((sum, r) => sum + r, 0) / total).toFixed(2))
    : null;
  return { total, averageRating, distribution };
}
