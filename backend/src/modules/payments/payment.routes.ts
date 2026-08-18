import {
  PaymentTransition,
  submitSignedTransitionInputSchema,
} from "@stellartrust/shared";
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

/**
 * Transitions that can require the acting party's own wallet signature. Which
 * of them actually do is a runtime property of the configured gateway (see
 * `GET /capabilities`), so the routes exist either way and answer 409 with a
 * usable message when a client picks the wrong path.
 */
const preparableByRoute = {
  lock: PaymentTransition.Lock,
  confirm: PaymentTransition.Confirm,
  dispute: PaymentTransition.Dispute,
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

  // Raise a dispute on the server-signed path. The wallet-signed deployments
  // answer 409 here and point at prepare/submit below; having both routes
  // exist either way means a client never has to encode which model is active.
  router.post(
    "/orders/:orderId/dispute",
    requireAuth(verifier),
    idempotency(mutations),
    async (req, res, next) => {
      try {
        const actor = requireActor(req as AuthedRequest);
        res.json(await service.raiseDispute(String(req.params.orderId), actor));
      } catch (err) {
        next(err);
      }
    },
  );

  // How this deployment signs each transition. Unauthenticated-safe content,
  // but kept behind auth so the escrow topology is not public.
  router.get("/capabilities", requireAuth(verifier), (req, res, next) => {
    try {
      requireActor(req as AuthedRequest);
      res.json(service.capabilities());
    } catch (err) {
      next(err);
    }
  });

  for (const [route, transition] of Object.entries(preparableByRoute)) {
    // Build the unsigned transaction for the party's wallet. Not idempotency-
    // keyed: preparing is a read-shaped operation the client may legitimately
    // repeat (a user re-opening the wallet), and for a lock it reuses the
    // already-deployed contract rather than creating a second one.
    router.post(
      `/orders/:orderId/${route}/prepare`,
      requireAuth(verifier),
      async (req, res, next) => {
        try {
          const actor = requireActor(req as AuthedRequest);
          res.json(
            await service.prepareTransition(
              String(req.params.orderId),
              transition,
              actor,
            ),
          );
        } catch (err) {
          next(err);
        }
      },
    );

    router.post(
      `/orders/:orderId/${route}/submit`,
      requireAuth(verifier),
      idempotency(mutations),
      async (req, res, next) => {
        try {
          const actor = requireActor(req as AuthedRequest);
          const parsed = submitSignedTransitionInputSchema.safeParse(req.body);
          if (!parsed.success) {
            throw new ValidationError(
              "Invalid signed transaction",
              parsed.error.issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
              })),
            );
          }
          res.json(
            await service.submitSignedTransition(
              String(req.params.orderId),
              transition,
              actor,
              parsed.data.signedXdr,
            ),
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
