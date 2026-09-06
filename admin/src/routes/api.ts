/**
 * The console's own API. Session-guarded by the caller (`app.ts` mounts this
 * behind `requireSession`), so nothing here re-checks authentication.
 *
 * Reads are thin wrappers over `lib/db.ts`. Writes validate first and say
 * plainly what they refused, because an operator acting on a queue needs to
 * know whether their decision landed.
 */
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import {
  decideAssetReview,
  decideKycReview,
  listAssetReviews,
  listAudit,
  listDisputes,
  listKycReviews,
  listOrders,
  listPolicies,
  listTokenizations,
  listTreasuryMovements,
  rejectWithdrawal,
  updatePolicy,
} from "../lib/db.js";
import { computeMetrics } from "../lib/metrics.js";

/** Wrap an async handler so a rejection reaches the error boundary. */
function handle(
  fn: (req: import("express").Request) => Promise<unknown>,
): import("express").RequestHandler {
  return (req, res, next) => {
    fn(req)
      .then((body) => res.json(body))
      .catch(next);
  };
}

const decisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().min(3, "A reason is required"),
});

const assetDecisionSchema = z.object({
  decision: z.enum(["verify", "reject"]),
  note: z.string().trim().optional(),
});

const policySchema = z.object({
  mode: z.enum(["auto", "ai", "human"]),
  approveMaxRiskBps: z.number().int().min(0).max(10_000),
  rejectMinRiskBps: z.number().int().min(0).max(10_000),
  minConfidenceBps: z.number().int().min(0).max(10_000),
  humanReviewAboveAmount: z.string().regex(/^\d+$/),
});

const rejectSchema = z.object({
  reason: z.string().trim().min(3, "A reason is required"),
});

export function createApiRouter(): Router {
  const router = Router();

  router.get(
    "/overview",
    handle(async () => {
      const [tokenizations, orders, disputes] = await Promise.all([
        listTokenizations(),
        listOrders(),
        listDisputes(),
      ]);
      return {
        metrics: computeMetrics(tokenizations, orders, disputes),
        tokenizations,
        orders,
        disputes,
      };
    }),
  );

  router.get(
    "/queues",
    handle(async () => {
      const [kyc, assets, treasury] = await Promise.all([
        listKycReviews(),
        listAssetReviews(),
        listTreasuryMovements(),
      ]);
      return { kyc, assets, treasury };
    }),
  );

  router.get(
    "/audit",
    handle(async () => ({ events: await listAudit(100) })),
  );

  router.get(
    "/policies",
    handle(async () => ({ policies: await listPolicies() })),
  );

  // ── Decisions ─────────────────────────────────────────────────────────────

  router.post("/kyc/:id", (req, res, next) => {
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "VALIDATION", message: parsed.error.issues[0]?.message },
      });
      return;
    }
    const { id } = req.params as { id: string };
    decideKycReview(
      id,
      parsed.data.decision,
      parsed.data.reason,
      config.ADMIN_REVIEWER_USER_ID,
    )
      .then((applied) => {
        // `false` means the row was no longer queued — another operator got
        // there first. That is a real answer, not an error, and saying so is
        // how the operator knows not to re-decide it.
        if (!applied) {
          res.status(409).json({
            error: {
              code: "CONFLICT",
              message: "That review was already resolved by someone else",
            },
          });
          return;
        }
        res.json({ ok: true });
      })
      .catch(next);
  });

  router.post("/assets/:id", (req, res, next) => {
    const parsed = assetDecisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "VALIDATION", message: parsed.error.issues[0]?.message },
      });
      return;
    }
    // A rejection without a stated reason leaves the issuer nothing to act on.
    if (parsed.data.decision === "reject" && !parsed.data.note) {
      res.status(400).json({
        error: { code: "VALIDATION", message: "A note is required to reject" },
      });
      return;
    }
    const { id } = req.params as { id: string };
    decideAssetReview(
      id,
      parsed.data.decision,
      parsed.data.note ?? null,
      config.ADMIN_REVIEWER_USER_ID,
    )
      .then((applied) => {
        if (!applied) {
          res.status(409).json({
            error: {
              code: "CONFLICT",
              message: "That asset was already decided",
            },
          });
          return;
        }
        res.json({ ok: true });
      })
      .catch(next);
  });

  /**
   * Refuse a held withdrawal.
   *
   * There is deliberately no *approve* route. Approving one submits a real
   * Stellar payment, which needs the signing key — and putting that key in a
   * separately deployed console would mean two systems able to move funds
   * instead of one. This console can stop a payout; only the backend can send
   * one.
   */
  router.post("/withdrawals/:id/reject", (req, res, next) => {
    const parsed = rejectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "VALIDATION", message: parsed.error.issues[0]?.message },
      });
      return;
    }
    const { id } = req.params as { id: string };
    rejectWithdrawal(id, parsed.data.reason)
      .then((applied) => {
        if (!applied) {
          res.status(409).json({
            error: {
              code: "CONFLICT",
              message: "That withdrawal is no longer pending",
            },
          });
          return;
        }
        res.json({ ok: true });
      })
      .catch(next);
  });

  router.post("/policies/:domain", (req, res, next) => {
    const parsed = policySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "VALIDATION", message: parsed.error.issues[0]?.message },
      });
      return;
    }
    // An approval band overlapping the rejection band is not a policy, it is
    // two contradictory instructions. The database refuses it too; catching it
    // here gives the operator a message they can act on rather than a
    // constraint violation they have to decode.
    if (parsed.data.approveMaxRiskBps >= parsed.data.rejectMinRiskBps) {
      res.status(400).json({
        error: {
          code: "VALIDATION",
          message:
            "The approval threshold must be below the rejection threshold",
        },
      });
      return;
    }
    const { domain } = req.params as { domain: string };
    if (domain !== "kyc" && domain !== "rwa_asset") {
      res.status(400).json({
        error: { code: "VALIDATION", message: `Unknown domain "${domain}"` },
      });
      return;
    }
    updatePolicy(domain, parsed.data)
      .then(() => res.json({ ok: true }))
      .catch(next);
  });

  return router;
}
