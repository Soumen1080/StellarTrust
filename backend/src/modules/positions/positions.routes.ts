/**
 * Unified position view (plane.md §2.4) — read-only.
 *
 * One endpoint, always scoped to the caller. There is deliberately no
 * `/positions/:userId` compliance variant: each underlying domain already has
 * its own compliance surface with its own authorization, and a single endpoint
 * that returned any user's whole financial position would be a wider grant than
 * any of them intended.
 */
import { Router } from "express";
import { ValidationError } from "../../lib/errors.js";
import {
  type AuthedRequest,
  type BearerVerifier,
  requireAuth,
} from "../../middleware/auth.js";
import type { PositionsService } from "./positions.service.js";

export function createPositionsRouter(
  service: PositionsService,
  verifier?: BearerVerifier,
): Router {
  const router = Router();

  /** GET /positions — the caller's orders, settlements, disputes, holdings. */
  router.get("/", requireAuth(verifier), async (req, res, next) => {
    try {
      const actor = requireActor(req as AuthedRequest);
      res.json(await service.forUser(actor.userId));
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
