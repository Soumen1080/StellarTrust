/**
 * Settlement REST routes (Phase 3). All endpoints touch money movement, so they
 * are authenticated (Rules.md #5); mutations are idempotent (Rules.md #4).
 */
import { Router } from "express";
import { ForbiddenError, ValidationError } from "../../lib/errors.js";
import {
  type AuthedRequest,
  type BearerVerifier,
  requireAuth,
} from "../../middleware/auth.js";
import {
  idempotency,
  InMemoryIdempotencyStore,
} from "../../middleware/idempotency.js";
import { CORRIDORS } from "./corridors.js";
import type { SettlementReconciliationJob } from "./settlement.reconciliation.job.js";
import type { SettlementService } from "./settlement.service.js";

export function createSettlementRouter(
  service: SettlementService,
  reconciliation: SettlementReconciliationJob,
  verifier?: BearerVerifier,
): Router {
  const router = Router();
  const mutations = new InMemoryIdempotencyStore();

  // Supported corridors (non-sensitive catalog); still authenticated for parity
  // with the rest of the money surface.
  router.get("/corridors", requireAuth(verifier), (_req, res) => {
    res.json({ corridors: CORRIDORS });
  });

  // A quote is a read-style pricing action; not a money mutation, so no
  // idempotency key is required, but it is authenticated.
  router.post("/quotes", requireAuth(verifier), async (req, res, next) => {
    try {
      requireActor(req as AuthedRequest);
      res.status(201).json(await service.quote(req.body));
    } catch (err) {
      next(err);
    }
  });

  // Execute a quote end-to-end (money movement) — idempotent.
  router.post(
    "/orders",
    requireAuth(verifier),
    idempotency(mutations),
    async (req, res, next) => {
      try {
        const actor = requireActor(req as AuthedRequest);
        res.status(201).json(await service.execute(actor, req.body));
      } catch (err) {
        next(err);
      }
    },
  );

  router.get("/orders", requireAuth(verifier), async (req, res, next) => {
    try {
      const actor = requireActor(req as AuthedRequest);
      res.json({ settlements: await service.list(actor.userId) });
    } catch (err) {
      next(err);
    }
  });

  router.get(
    "/orders/:settlementId",
    requireAuth(verifier),
    async (req, res, next) => {
      try {
        const actor = requireActor(req as AuthedRequest);
        res.json(
          await service.details(String(req.params.settlementId), actor.userId),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/reconciliation/run",
    requireAuth(verifier),
    idempotency(mutations),
    async (req, res, next) => {
      try {
        const actor = requireActor(req as AuthedRequest);
        if (!actor.roles.includes("compliance")) {
          throw new ForbiddenError("Reconciliation requires compliance access");
        }
        res.json(await reconciliation.run());
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

function requireActor(req: AuthedRequest) {
  if (!req.auth) throw new ValidationError("Authenticated actor is missing");
  return req.auth;
}
