/** KYC verification + human review persistence boundary. */
import type {
  HumanKycDecision,
  KycApplicationResponse,
  KycReviewItem,
} from "@stellartrust/shared";

export interface KycVerificationRecord {
  userId: string;
  response: KycApplicationResponse;
}

export interface KycRepository {
  saveVerification(record: KycVerificationRecord): Promise<void>;
  getVerification(id: string): Promise<KycVerificationRecord | undefined>;
  updateVerification(
    id: string,
    response: KycApplicationResponse,
  ): Promise<KycVerificationRecord | undefined>;
  saveReview(review: KycReviewItem): Promise<void>;
  getReview(id: string): Promise<KycReviewItem | undefined>;
  listQueuedReviews(): Promise<KycReviewItem[]>;
  resolveReview(
    id: string,
    input: {
      resolvedBy: string;
      resolution: HumanKycDecision;
      reason: string;
      resolvedAt: string;
    },
  ): Promise<KycReviewItem | undefined>;
}

export class InMemoryKycRepository implements KycRepository {
  private readonly verifications = new Map<string, KycVerificationRecord>();
  private readonly reviews = new Map<string, KycReviewItem>();

  async saveVerification(record: KycVerificationRecord): Promise<void> {
    this.verifications.set(record.response.verificationId, record);
  }

  async getVerification(
    id: string,
  ): Promise<KycVerificationRecord | undefined> {
    return this.verifications.get(id);
  }

  async updateVerification(
    id: string,
    response: KycApplicationResponse,
  ): Promise<KycVerificationRecord | undefined> {
    const current = this.verifications.get(id);
    if (!current) return undefined;
    const updated = { ...current, response };
    this.verifications.set(id, updated);
    return updated;
  }

  async saveReview(review: KycReviewItem): Promise<void> {
    this.reviews.set(review.id, review);
  }

  async getReview(id: string): Promise<KycReviewItem | undefined> {
    return this.reviews.get(id);
  }

  async listQueuedReviews(): Promise<KycReviewItem[]> {
    return [...this.reviews.values()]
      .filter((review) => review.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async resolveReview(
    id: string,
    input: {
      resolvedBy: string;
      resolution: HumanKycDecision;
      reason: string;
      resolvedAt: string;
    },
  ): Promise<KycReviewItem | undefined> {
    const current = this.reviews.get(id);
    if (!current || current.status !== "queued") return undefined;
    const resolved: KycReviewItem = {
      ...current,
      status: "resolved",
      resolvedBy: input.resolvedBy,
      resolution: input.resolution,
      resolutionReason: input.reason,
      resolvedAt: input.resolvedAt,
    };
    this.reviews.set(id, resolved);
    return resolved;
  }
}
