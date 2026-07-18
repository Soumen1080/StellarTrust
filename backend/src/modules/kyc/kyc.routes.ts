/** Authenticated KYC/KYB application and compliance-review routes. */
import { Router } from "express";
import {
  kycApplicationInputSchema,
  kycReviewDecisionInputSchema,
} from "@stellartrust/shared";
import { ValidationError } from "../../lib/errors.js";
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

export function createKycRouter(
  service: KycService,
  bearerVerifier: BearerVerifier,
): Router {
  const router = Router();
  const idempotencyStore = new InMemoryIdempotencyStore();

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
