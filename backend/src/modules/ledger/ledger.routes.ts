/**
 * Ledger routes. Recording money movement is a mutating, authenticated,
 * idempotent operation (Rules.md #1, #4, #5).
 */
import { Router } from "express";
import type { RequestWithId } from "../../middleware/requestId.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  idempotency,
  InMemoryIdempotencyStore,
} from "../../middleware/idempotency.js";
import { InMemoryLedgerRepository } from "./ledger.repository.js";
import { LedgerService } from "./ledger.service.js";

export function createLedgerRouter(
  service: LedgerService = new LedgerService(new InMemoryLedgerRepository()),
): Router {
  const router = Router();
  const idempotencyStore = new InMemoryIdempotencyStore();

  // Record a balanced double-entry transaction.
  router.post(
    "/transactions",
    requireAuth(),
    idempotency(idempotencyStore),
    async (req, res, next) => {
      try {
        const tx = await service.record(req.body);
        res.status(201).json(tx);
      } catch (err) {
        next(err);
      }
    },
  );

  // Look up a transaction by its money-movement reference id.
  router.get("/transactions/:referenceId", requireAuth(), async (req, res, next) => {
    try {
      const referenceId = (req.params as { referenceId: string }).referenceId;
      const tx = await service.getByReference(referenceId);
      if (!tx) {
        const requestId = (req as RequestWithId).requestId;
        res
          .status(404)
          .json({ error: { code: "NOT_FOUND", message: "Not found", requestId } });
        return;
      }
      res.json(tx);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
