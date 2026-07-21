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
  type KycStatusResponse,
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

/**
 * Development-only auto-approval options (see devlopement.md §6). When enabled,
 * a submitted verification transitions to `verified` after `delayMs`, resolved
 * lazily on read so it survives process/instance restarts. Never enabled in
 * production (guarded at wiring time in app.ts).
 */
export interface KycServiceOptions {
  autoApprove?: boolean;
  autoApproveDelayMs?: number;
}

export class KycService {
  constructor(
    private readonly provider: KycProvider,
    private readonly riskClient: KycRiskClient,
    private readonly kycRepo: KycRepository,
    private readonly identities: IdentityRepository,
    private readonly audit: AuditRepository,
    private readonly options: KycServiceOptions = {},
  ) {}

  private get autoApproveEnabled(): boolean {
    return Boolean(this.options.autoApprove);
  }

  private get autoApproveDelayMs(): number {
    return this.options.autoApproveDelayMs ?? 10_000;
  }

  async submit(
    userId: string,
    input: KycApplicationInput,
  ): Promise<KycApplicationResponse> {
    const verificationId = randomUUID();
    const providerResult = await this.provider.submit(input);
    const submittedAt = new Date().toISOString();

    let aiAvailable = true;
    let advisory: KycRiskAdvisory;
    let status: KycStatus;
    let reviewId: string | null = null;
    let autoApproveAt: string | null = null;
    let auditReasons: string[];
    let auditDecision: KycDecision;

    if (this.autoApproveEnabled) {
      // Development shortcut: skip the AI call entirely and schedule automatic
      // verification. The real provider/AI/human path is preserved below.
      aiAvailable = false;
      advisory = {
        riskScore: 0,
        decision: KycDecision.Approve,
        confidence: 1,
        explanation:
          "Development auto-approval enabled; verification completes automatically.",
        signals: providerResult.riskSignals.map((signal) => signal.name),
      };
      status = KycStatus.UnderReview;
      autoApproveAt = new Date(Date.now() + this.autoApproveDelayMs).toISOString();
      auditReasons = ["development_auto_approval"];
      auditDecision = KycDecision.Review;
    } else {
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
      status = statusForDecision(policy.decision);
      reviewId = policy.decision === KycDecision.Review ? randomUUID() : null;
      auditReasons = policy.reasons;
      auditDecision = policy.decision;
    }

    const response: KycApplicationResponse = {
      verificationId,
      providerReference: providerResult.providerReference,
      status,
      checks: providerResult.checks,
      advisory,
      reviewId,
      submittedAt,
      autoApproveAt,
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
      actor: this.autoApproveEnabled
        ? "system:kyc-auto-approve"
        : "system:kyc-decision-engine",
      action: `kyc.${auditDecision}`,
      entity: "kyc_verification",
      entityId: verificationId,
      metadata: {
        riskScore: advisory.riskScore,
        confidence: advisory.confidence,
        reasons: auditReasons,
        aiAvailable,
        reviewId,
        autoApproveAt,
      },
    });

    return response;
  }

  /**
   * Returns the caller's current KYC status, first resolving any pending
   * development auto-approval whose timer has elapsed. Stateless — safe across
   * instance/process restarts (no in-memory timers).
   */
  async getStatus(userId: string): Promise<KycStatusResponse> {
    await this.maybeAutoApprove(userId);
    const profile = await this.identities.getProfile(userId);
    return {
      status: profile?.user.kycStatus ?? KycStatus.Pending,
      verification: profile?.latestVerification ?? null,
    };
  }

  private async maybeAutoApprove(userId: string): Promise<void> {
    if (!this.autoApproveEnabled) return;
    const profile = await this.identities.getProfile(userId);
    const verification = profile?.latestVerification;
    if (!verification?.autoApproveAt) return;
    if (verification.status !== KycStatus.UnderReview) return;
    if (verification.autoApproveAt > new Date().toISOString()) return;

    const updatedResponse: KycApplicationResponse = {
      ...verification,
      status: KycStatus.Verified,
    };
    await this.kycRepo.updateVerification(
      verification.verificationId,
      updatedResponse,
    );
    await this.identities.setUserKycStatus(userId, KycStatus.Verified);
    await this.identities.setLatestVerification(userId, updatedResponse);
    await this.audit.append({
      actor: "system:kyc-auto-approve",
      action: "kyc.auto_verified",
      entity: "kyc_verification",
      entityId: verification.verificationId,
      metadata: { development: true, scheduledFor: verification.autoApproveAt },
    });
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
