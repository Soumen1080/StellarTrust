/**
 * Reputation routes (Phase 6) — read-only advisory surface.
 * A user can read their own reputation; compliance can read any user's.
 */
import { Router } from "express";
import { ForbiddenError, ValidationError } from "../../lib/errors.js";
import {
  type AuthedRequest,
  type BearerVerifier,
  requireAuth,
} from "../../middleware/auth.js";
import type { ReputationService } from "./reputation.service.js";

export function createReputationRouter(
  service: ReputationService,
  verifier?: BearerVerifier,
): Router {
  const router = Router();

  /** GET /reputation/me — the authenticated user's own reputation. */
  router.get("/me", requireAuth(verifier), async (req, res, next) => {
    try {
      const actor = requireActor(req as AuthedRequest);
      res.json({ reputation: await service.getReputation(actor.userId) });
    } catch (err) {
      next(err);
    }
  });

  /** GET /reputation/:userId — compliance-only lookup of any user. */
  router.get("/:userId", requireAuth(verifier), async (req, res, next) => {
    try {
      const actor = requireActor(req as AuthedRequest);
      const target = String(req.params.userId);
      if (actor.userId !== target && !actor.roles.includes("compliance")) {
        throw new ForbiddenError(
          "Only the user or compliance may read this reputation",
        );
      }
      res.json({ reputation: await service.getReputation(target) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function requireActor(req: AuthedRequest) {
  if (!req.auth) throw new ValidationError("Authenticated actor is missing");
  return req.auth;
}
