/**
 * Product feedback routes (Phase 6).
 *
 * `GET /` is deliberately UNAUTHENTICATED — the wall is public, which is the
 * whole point of the feature. That makes the response shape a security
 * boundary rather than a formatting choice: it carries `FeedbackDTO`, which
 * has no email or wallet field, and the service is what produces it.
 *
 * Posting requires a session. An open write endpoint on a public wall is a
 * spam surface, and tying an entry to an account is also what makes the
 * one-entry-per-user rule enforceable.
 */
import { Router } from "express";
import type { FeedbackMutationResponse } from "@stellartrust/shared";
import { ValidationError } from "../../lib/errors.js";
import {
  type AuthedRequest,
  type BearerVerifier,
  requireAuth,
} from "../../middleware/auth.js";
import type { FeedbackService } from "./feedback.service.js";

export function createFeedbackRouter(
  service: FeedbackService,
  verifier?: BearerVerifier,
): Router {
  const router = Router();

  /** GET /feedback — the public wall. No authentication. */
  router.get("/", async (_req, res, next) => {
    try {
      res.json(await service.listPublic());
    } catch (err) {
      next(err);
    }
  });

  /** GET /feedback/me — the caller's own entry, so the form knows to hide. */
  router.get("/me", requireAuth(verifier), async (req, res, next) => {
    try {
      const actor = requireActor(req as AuthedRequest);
      res.json({ feedback: await service.findMine(actor.userId) });
    } catch (err) {
      next(err);
    }
  });

  /** POST /feedback — leave feedback. One per account. */
  router.post("/", requireAuth(verifier), async (req, res, next) => {
    try {
      const actor = requireActor(req as AuthedRequest);
      const body: FeedbackMutationResponse = {
        feedback: await service.submit(actor.userId, req.body),
      };
      res.status(201).json(body);
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
