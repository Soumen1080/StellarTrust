/** Authenticated KYC/KYB application and compliance-review routes. */
import { createHash, timingSafeEqual } from "node:crypto";
import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  HumanKycDecision,
  kycApplicationInputSchema,
  kycReviewDecisionInputSchema,
} from "@stellartrust/shared";
import { config } from "../../config/index.js";
import {
  AuthError,
  NotFoundError,
  ValidationError,
} from "../../lib/errors.js";
import {
  requireAuth,
  type AuthedRequest,
  type BearerVerifier,
} from "../../middleware/auth.js";
import { requireRole } from "../../middleware/authorization.js";
import {
  idempotency,
  InMemoryIdempotencyStore,
} from "../../middleware/idempotency.js";
import type { KycService } from "./kyc.service.js";

function requireDevApprovalPassword(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const expected = config.TEMP_KYC_APPROVAL_PASSWORD;
  if (config.NODE_ENV !== "development" || !expected) {
    next(new NotFoundError("Development KYC approval is unavailable"));
    return;
  }

  const provided = req.header("x-dev-approval-password") ?? "";
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  if (!timingSafeEqual(expectedDigest, providedDigest)) {
    next(new AuthError("Invalid development approval password"));
    return;
  }
  next();
}

export function createKycRouter(
  service: KycService,
  bearerVerifier: BearerVerifier,
): Router {
  const router = Router();
  const idempotencyStore = new InMemoryIdempotencyStore();

  router.get(
    "/status",
    requireAuth(bearerVerifier),
    async (req, res, next) => {
      try {
        const userId = (req as AuthedRequest).auth?.userId;
        if (!userId) throw new ValidationError("Authenticated user is missing");
        res.json(await service.getStatus(userId));
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/applications",
    requireAuth(bearerVerifier),
    idempotency(idempotencyStore),
    async (req, res, next) => {
      try {
        const parsed = kycApplicationInputSchema.safeParse(req.body);
        if (!parsed.success) {
          throw new ValidationError(
            "Invalid KYC application",
            parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          );
        }
        const userId = (req as AuthedRequest).auth?.userId;
        if (!userId) throw new ValidationError("Authenticated user is missing");
        res.status(201).json(await service.submit(userId, parsed.data));
      } catch (err) {
        next(err);
      }
    },
  );

  // Temporary local-development escape hatch. These endpoints are unavailable
  // unless the backend is in development and a server-side password is set.
  router.get(
    "/dev/reviews",
    requireDevApprovalPassword,
    async (_req, res, next) => {
      try {
        res.json({ reviews: await service.listReviews() });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/dev/reviews/:reviewId/approve",
    requireDevApprovalPassword,
    idempotency(idempotencyStore),
    async (req, res, next) => {
      try {
        const rawReason = (req.body as { reason?: unknown } | undefined)?.reason;
        const parsed = kycReviewDecisionInputSchema.safeParse({
          decision: HumanKycDecision.Approve,
          reason: typeof rawReason === "string" ? rawReason.trim() : rawReason,
        });
        if (!parsed.success) {
          throw new ValidationError(
            "Invalid KYC approval",
            parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          );
        }
        const reviewId = (req.params as { reviewId: string }).reviewId;
        res.json(
          await service.resolveReview(
            reviewId,
            "development-password-reviewer",
            parsed.data,
          ),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/reviews",
    requireAuth(bearerVerifier),
    requireRole("compliance"),
    async (_req, res, next) => {
      try {
        res.json({ reviews: await service.listReviews() });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/reviews/:reviewId/decision",
    requireAuth(bearerVerifier),
    requireRole("compliance"),
    idempotency(idempotencyStore),
    async (req, res, next) => {
      try {
        const parsed = kycReviewDecisionInputSchema.safeParse(req.body);
        if (!parsed.success) {
          throw new ValidationError(
            "Invalid KYC review decision",
            parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          );
        }
        const reviewerId = (req as AuthedRequest).auth?.userId;
        if (!reviewerId) {
          throw new ValidationError("Authenticated reviewer is missing");
        }
        const reviewId = (req.params as { reviewId: string }).reviewId;
        res.json(
          await service.resolveReview(reviewId, reviewerId, parsed.data),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
