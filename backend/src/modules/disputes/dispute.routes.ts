/**
 * Dispute REST routes (Phase 4). All endpoints touch escrow/PII-adjacent state
 * so they are authenticated (Rules.md #5); mutations are idempotent (#4).
 */
import { Router } from "express";
import { ValidationError } from "../../lib/errors.js";
import {
  type AuthedRequest,
  type BearerVerifier,
  requireAuth,
} from "../../middleware/auth.js";
import {
  idempotency,
  InMemoryIdempotencyStore,
} from "../../middleware/idempotency.js";
import type { DisputeService } from "./dispute.service.js";

export function createDisputeRouter(
  service: DisputeService,
  verifier?: BearerVerifier,
): Router {
  const router = Router();
  const mutations = new InMemoryIdempotencyStore();

  // Open a dispute against an order (order party only).
  router.post(
    "/",
    requireAuth(verifier),
    idempotency(mutations),
    async (req, res, next) => {
      try {
        const actor = requireActor(req as AuthedRequest);
        res.status(201).json({ dispute: await service.open(actor, req.body) });
      } catch (err) {
        next(err);
      }
    },
  );

  // Disputes the caller is a party to (buyer or seller). `?orderId=` narrows to
  // one order — how the escrow view asks "is there a claim on this order?".
  router.get("/", requireAuth(verifier), async (req, res, next) => {
    try {
      const actor = requireActor(req as AuthedRequest);
      const orderId = req.query.orderId;
      if (orderId !== undefined && typeof orderId !== "string") {
        throw new ValidationError("orderId must be a single value");
      }
      res.json({ disputes: await service.list(actor.userId, orderId) });
    } catch (err) {
      next(err);
    }
  });

  // Compliance-only open-dispute queue.
  router.get("/queue", requireAuth(verifier), async (req, res, next) => {
    try {
      const actor = requireActor(req as AuthedRequest);
      res.json({ disputes: await service.queue(actor) });
    } catch (err) {
      next(err);
    }
  });

  // Append-only history of the dispute, role-labelled for the parties.
  // Declared before "/:disputeId" so "log" is never read as a dispute id.
  router.get(
    "/:disputeId/log",
    requireAuth(verifier),
    async (req, res, next) => {
      try {
        const actor = requireActor(req as AuthedRequest);
        const disputeId = String(req.params.disputeId);
        res.json({
          disputeId,
          entries: await service.log(disputeId, actor),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get("/:disputeId", requireAuth(verifier), async (req, res, next) => {
    try {
      const actor = requireActor(req as AuthedRequest);
      res.json({
        dispute: await service.details(String(req.params.disputeId), actor),
      });
    } catch (err) {
      next(err);
    }
  });

  // Submit evidence within the open window (order party only).
  router.post(
    "/:disputeId/evidence",
    requireAuth(verifier),
    idempotency(mutations),
    async (req, res, next) => {
      try {
        const actor = requireActor(req as AuthedRequest);
        res.status(201).json({
          dispute: await service.submitEvidence(
            actor,
            String(req.params.disputeId),
            req.body,
          ),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // Resolve. With a body decision => human compliance sign-off; empty body =>
  // attempt policy auto-resolve (rejected unless within thresholds).
  router.post(
    "/:disputeId/resolve",
    requireAuth(verifier),
    idempotency(mutations),
    async (req, res, next) => {
      try {
        const actor = requireActor(req as AuthedRequest);
        const body = req.body as Record<string, unknown> | undefined;
        const hasDecision = Boolean(body && "decision" in body);
        res.json({
          dispute: await service.resolve(
            actor,
            String(req.params.disputeId),
            hasDecision ? (body as never) : undefined,
          ),
        });
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
