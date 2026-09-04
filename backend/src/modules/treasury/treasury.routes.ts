/**
 * Treasury routes — funding and withdrawing a ledger balance (plane.md §4.5).
 *
 * Every mutating route is authenticated and idempotent (Rules.md #4, #5). The
 * deposit address is the one read that is not user-specific; it is still
 * authenticated, because publishing the platform's receiving address to
 * unauthenticated callers invites payments from people who have no account to
 * credit.
 */
import { Router } from "express";
import { SUPPORTED_CURRENCIES, type CurrencyCode } from "@stellartrust/shared";
import { ValidationError } from "../../lib/errors.js";
import {
  type AuthedRequest,
  type BearerVerifier,
  requireAuth,
} from "../../middleware/auth.js";
import { requireRole } from "../../middleware/authorization.js";
import {
  idempotency,
  type IdempotencyStore,
  InMemoryIdempotencyStore,
} from "../../middleware/idempotency.js";
import type { TreasuryService } from "./treasury.service.js";

function actorFrom(req: AuthedRequest): { userId: string; roles: string[] } {
  const auth = req.auth;
  if (!auth) throw new ValidationError("Missing authentication context");
  return { userId: auth.userId, roles: auth.roles };
}

export function createTreasuryRouter(
  service: TreasuryService,
  verifier?: BearerVerifier,
  idempotencyStore: IdempotencyStore = new InMemoryIdempotencyStore(),
): Router {
  const router = Router();

  /** Where to send funds to top up a balance. */
  router.get("/deposit-address", requireAuth(verifier), async (_req, res, next) => {
    try {
      res.json(await service.depositAddress());
    } catch (err) {
      next(err);
    }
  });

  /** The caller's own deposits and withdrawals. */
  router.get("/movements", requireAuth(verifier), async (req, res, next) => {
    try {
      const actor = actorFrom(req as AuthedRequest);
      res.json({ movements: await service.listForUser(actor.userId) });
    } catch (err) {
      next(err);
    }
  });

  /** The caller's balances, one per currency they hold. */
  router.get("/balances", requireAuth(verifier), async (req, res, next) => {
    try {
      const actor = actorFrom(req as AuthedRequest);
      res.json({ balances: await service.balances(actor.userId) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Claim a deposit: "this transaction paid you, credit me for it."
   *
   * The body carries a hash, never an amount — the amount comes from the
   * chain, which is the whole point (see `TreasuryService.claimDeposit`).
   */
  router.post(
    "/deposits",
    requireAuth(verifier),
    idempotency(idempotencyStore),
    async (req, res, next) => {
      try {
        const actor = actorFrom(req as AuthedRequest);
        const { stellarTxHash } = (req.body ?? {}) as {
          stellarTxHash?: unknown;
        };
        if (typeof stellarTxHash !== "string") {
          throw new ValidationError("stellarTxHash is required");
        }
        const movement = await service.claimDeposit(actor, { stellarTxHash });
        res.status(201).json(movement);
      } catch (err) {
        next(err);
      }
    },
  );

  /** Withdraw to a Stellar address. */
  router.post(
    "/withdrawals",
    requireAuth(verifier),
    idempotency(idempotencyStore),
    async (req, res, next) => {
      try {
        const actor = actorFrom(req as AuthedRequest);
        const { amount, currency, destinationAddress } = (req.body ?? {}) as {
          amount?: unknown;
          currency?: unknown;
          destinationAddress?: unknown;
        };
        if (typeof amount !== "string" || !/^\d+$/.test(amount)) {
          throw new ValidationError(
            "amount must be a string of minor units (integer)",
          );
        }
        if (
          typeof currency !== "string" ||
          !(SUPPORTED_CURRENCIES as readonly string[]).includes(currency)
        ) {
          throw new ValidationError("currency must be a supported currency");
        }
        if (
          destinationAddress !== undefined &&
          typeof destinationAddress !== "string"
        ) {
          throw new ValidationError("destinationAddress must be a string");
        }
        const movement = await service.withdraw(actor, {
          amount,
          currency: currency as CurrencyCode,
          destinationAddress,
        });
        res.status(201).json(movement);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Compliance decisions on held withdrawals (Rules.md §6) ────────────────

  router.post(
    "/withdrawals/:id/approve",
    requireAuth(verifier),
    requireRole("compliance"),
    idempotency(idempotencyStore),
    async (req, res, next) => {
      try {
        const actor = actorFrom(req as AuthedRequest);
        const { id } = req.params as { id: string };
        res.json(await service.approveWithdrawal(id, actor));
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/withdrawals/:id/reject",
    requireAuth(verifier),
    requireRole("compliance"),
    idempotency(idempotencyStore),
    async (req, res, next) => {
      try {
        const actor = actorFrom(req as AuthedRequest);
        const { id } = req.params as { id: string };
        const { reason } = (req.body ?? {}) as { reason?: unknown };
        if (typeof reason !== "string" || reason.trim().length === 0) {
          throw new ValidationError("A reason is required");
        }
        res.json(await service.rejectWithdrawal(id, actor, reason));
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
