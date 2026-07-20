import { PaymentTransition } from "@stellartrust/shared";
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
import type { ReconciliationJob } from "../../jobs/reconciliation.job.js";
import type { PaymentService } from "./payment.service.js";

const transitionByRoute = {
  accept: PaymentTransition.Accept,
  deposit: PaymentTransition.Deposit,
  lock: PaymentTransition.Lock,
  confirm: PaymentTransition.Confirm,
  release: PaymentTransition.Release,
  refund: PaymentTransition.Refund,
} as const;

export function createPaymentRouter(
  service: PaymentService,
  reconciliation: ReconciliationJob,
  verifier?: BearerVerifier,
): Router {
  const router = Router();
  const mutations = new InMemoryIdempotencyStore();

  router.post(
    "/orders",
    requireAuth(verifier),
    idempotency(mutations),
    async (req, res, next) => {
      try {
        const actor = requireActor(req as AuthedRequest);
        res.status(201).json(await service.createOrder(actor.userId, req.body));
      } catch (err) {
        next(err);
      }
    },
  );

  router.get("/orders", requireAuth(verifier), async (req, res, next) => {
    try {
      const actor = requireActor(req as AuthedRequest);
      res.json({ orders: await service.list(actor.userId) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/orders/:orderId", requireAuth(verifier), async (req, res, next) => {
    try {
      const actor = requireActor(req as AuthedRequest);
      res.json(await service.details(String(req.params.orderId), actor.userId));
    } catch (err) {
      next(err);
    }
  });

  for (const [route, transition] of Object.entries(transitionByRoute)) {
    router.post(
      `/orders/:orderId/${route}`,
      requireAuth(verifier),
      idempotency(mutations),
      async (req, res, next) => {
        try {
          const actor = requireActor(req as AuthedRequest);
          res.json(
            await service.transition(String(req.params.orderId), transition, actor),
          );
        } catch (err) {
          next(err);
        }
      },
    );
  }

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
