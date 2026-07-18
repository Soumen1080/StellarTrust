/** KYC/KYB application orchestration and human-review workflow. */
import { randomUUID } from "node:crypto";
import {
  ApplicantType,
  HumanKycDecision,
  KycDecision,
  KycStatus,
  ReviewStatus,
  type KycApplicationInput,
  type KycApplicationResponse,
  type KycReviewDecisionInput,
  type KycReviewItem,
  type KycRiskAdvisory,
} from "@stellartrust/shared";
import { ConflictError, NotFoundError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import type { AuditRepository } from "../audit/audit.repository.js";
import type { IdentityRepository } from "../identity/identity.repository.js";
import { decideKyc } from "./kyc-decision.engine.js";
import type { KycRepository } from "./kyc.repository.js";
import type { KycRiskClient } from "./kyc-risk.client.js";
import type { KycProvider } from "./providers/kyc-provider.js";

function statusForDecision(decision: KycDecision): KycStatus {
  if (decision === KycDecision.Approve) return KycStatus.Verified;
  if (decision === KycDecision.Reject) return KycStatus.Rejected;
  return KycStatus.UnderReview;
}

export class KycService {
  constructor(
    private readonly provider: KycProvider,
    private readonly riskClient: KycRiskClient,
    private readonly kycRepo: KycRepository,
    private readonly identities: IdentityRepository,
    private readonly audit: AuditRepository,
  ) {}

  async submit(
    userId: string,
    input: KycApplicationInput,
  ): Promise<KycApplicationResponse> {
    const verificationId = randomUUID();
    const providerResult = await this.provider.submit(input);

    let aiAvailable = true;
    let advisory: KycRiskAdvisory;
    try {
      advisory = await this.riskClient.score({
        subjectRef: verificationId,
        signals: providerResult.riskSignals,
        sanctionsHit: providerResult.sanctionsHit,
        newParty: true,
      });
    } catch (err) {
      aiAvailable = false;
      logger.warn(
        { verificationId, errorType: (err as Error).name },
        "KYC AI unavailable; routing to human review",
      );
      advisory = {
        riskScore: 0.5,
        decision: KycDecision.Review,
        confidence: 0,
        explanation: "AI advisory unavailable; human review required.",
        signals: providerResult.riskSignals.map((signal) => signal.name),
      };
    }

    const policy = decideKyc(providerResult.checks, advisory, { aiAvailable });
    const status = statusForDecision(policy.decision);
    const reviewId =
      policy.decision === KycDecision.Review ? randomUUID() : null;
    const response: KycApplicationResponse = {
      verificationId,
      providerReference: providerResult.providerReference,
      status,
      checks: providerResult.checks,
      advisory,
      reviewId,
      submittedAt: new Date().toISOString(),
    };

    await this.kycRepo.saveVerification({ userId, response });
    await this.identities.updateUserProfile(userId, {
      email: input.email,
      legalName: input.legalName,
      kycStatus: status,
    });
    if (input.applicantType === ApplicantType.Business) {
      await this.identities.upsertBusiness(userId, {
        legalName: input.businessName ?? input.legalName,
        country: input.country,
      });
    }
    await this.identities.setLatestVerification(userId, response);

    if (reviewId) {
      const review: KycReviewItem = {
        id: reviewId,
        verificationId,
        userId,
        status: ReviewStatus.Queued,
        advisory,
        providerChecks: providerResult.checks,
        resolvedBy: null,
        resolution: null,
        resolutionReason: null,
        createdAt: response.submittedAt,
        resolvedAt: null,
      };
      await this.kycRepo.saveReview(review);
    }

    // Deliberately safe metadata: no email, names, DOB, document values, or refs.
    await this.audit.append({
      actor: `user:${userId}`,
      action: "kyc.submitted",
      entity: "kyc_verification",
      entityId: verificationId,
      metadata: {
        provider: providerResult.provider,
        applicantType: input.applicantType,
        checkOutcomes: providerResult.checks,
      },
    });
    await this.audit.append({
      actor: "system:kyc-decision-engine",
      action: `kyc.${policy.decision}`,
      entity: "kyc_verification",
      entityId: verificationId,
      metadata: {
        riskScore: advisory.riskScore,
        confidence: advisory.confidence,
        reasons: policy.reasons,
        aiAvailable,
        reviewId,
      },
    });

    return response;
  }

  async listReviews(): Promise<KycReviewItem[]> {
    return this.kycRepo.listQueuedReviews();
  }

  async resolveReview(
    reviewId: string,
    reviewerId: string,
    input: KycReviewDecisionInput,
  ): Promise<KycReviewItem> {
    const current = await this.kycRepo.getReview(reviewId);
    if (!current) throw new NotFoundError("KYC review not found");
    if (current.status !== ReviewStatus.Queued) {
      throw new ConflictError("KYC review is already resolved");
    }

    const resolvedAt = new Date().toISOString();
    const resolved = await this.kycRepo.resolveReview(reviewId, {
      resolvedBy: reviewerId,
      resolution: input.decision,
      reason: input.reason,
      resolvedAt,
    });
    if (!resolved) throw new ConflictError("KYC review is already resolved");

    const verification = await this.kycRepo.getVerification(
      current.verificationId,
    );
    if (!verification) throw new NotFoundError("KYC verification not found");
    const status =
      input.decision === HumanKycDecision.Approve
        ? KycStatus.Verified
        : KycStatus.Rejected;
    const updatedResponse = { ...verification.response, status };
    await this.kycRepo.updateVerification(
      current.verificationId,
      updatedResponse,
    );
    await this.identities.setUserKycStatus(current.userId, status);
    await this.identities.setLatestVerification(
      current.userId,
      updatedResponse,
    );

    await this.audit.append({
      actor: `user:${reviewerId}`,
      action: `kyc.human_${input.decision}`,
      entity: "kyc_verification",
      entityId: current.verificationId,
      metadata: { reviewId, reasonProvided: true },
    });
    return resolved;
  }
}
