/** SEP-10 challenge/verify and current-identity routes. */
import { Router } from "express";
import {
  sep10ChallengeRequestSchema,
  sep10VerifyRequestSchema,
} from "@stellartrust/shared";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import {
  requireAuth,
  type AuthedRequest,
  type BearerVerifier,
} from "../../middleware/auth.js";
import type { IdentityRepository } from "../identity/identity.repository.js";
import type { Sep10Service } from "./sep10.service.js";

export function createAuthRouter(
  service: Sep10Service,
  identities: IdentityRepository,
  bearerVerifier: BearerVerifier,
): Router {
  const router = Router();

  router.post("/sep10/challenge", async (req, res, next) => {
    try {
      const parsed = sep10ChallengeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(
          "Invalid SEP-10 challenge request",
          parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        );
      }
      res.status(201).json(await service.createChallenge(parsed.data.account));
    } catch (err) {
      next(err);
    }
  });

  router.post("/sep10/verify", async (req, res, next) => {
    try {
      const parsed = sep10VerifyRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(
          "Invalid SEP-10 verification request",
          parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        );
      }
      res.json(await service.verifyChallenge(parsed.data));
    } catch (err) {
      next(err);
    }
  });

  router.get("/me", requireAuth(bearerVerifier), async (req, res, next) => {
    try {
      const userId = (req as AuthedRequest).auth?.userId;
      if (!userId) throw new NotFoundError("Identity not found");
      const profile = await identities.getProfile(userId);
      if (!profile) throw new NotFoundError("Identity not found");
      res.json(profile);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
