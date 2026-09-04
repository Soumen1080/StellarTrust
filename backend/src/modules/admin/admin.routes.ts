/**
 * Admin routes — the ops console's API.
 *
 * **Every route requires the `compliance` role.** Not merely authentication:
 * these endpoints return the platform's whole book, every user's queue, and
 * the controls that decide whether a verification needs a human. A signed-in
 * ordinary user must see none of it.
 *
 * The console can change *policy* and decide queued cases through the services
 * that own them. It can never post a ledger entry, move units, or submit a
 * transaction — there is no route here that does, and that absence is the
 * boundary rather than a check someone has to remember.
 */
import { Router } from "express";
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
import type { KycService } from "../kyc/kyc.service.js";
import type { RwaService } from "../rwa/rwa.service.js";
import type { DisputeService } from "../disputes/dispute.service.js";
import type { TreasuryService } from "../treasury/treasury.service.js";
import type { AdminService } from "./admin.service.js";
import {
  VerificationDomain,
  type UpdateVerificationPolicyInput,
  type VerificationMode,
} from "./verification-policy.js";

/**
 * The queues and listings the console shows.
 *
 * Narrow ports rather than the services themselves, so the admin module cannot
 * reach a method that moves money simply because it happens to be on an object
 * it already holds.
 */
export interface AdminConsoleReaders {
  kycReviews(): Promise<unknown[]>;
  assetReviewQueue(): Promise<unknown[]>;
  tokenizations(): Promise<unknown[]>;
  disputes(): Promise<unknown[]>;
  settlements(): Promise<unknown[]>;
  treasuryMovements(): Promise<unknown[]>;
  recentAudit(limit: number): Promise<unknown[]>;
  eventSpineHealth(): Promise<unknown>;
}

function actorFrom(req: AuthedRequest): { userId: string; roles: string[] } {
  const auth = req.auth;
  if (!auth) throw new ValidationError("Missing authentication context");
  return { userId: auth.userId, roles: auth.roles };
}

function parsePositiveInt(raw: unknown, fallback: number, max: number): number {
  if (typeof raw !== "string") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, max);
}

export function createAdminRouter(
  admin: AdminService,
  readers: AdminConsoleReaders,
  services: {
    kyc: KycService;
    rwa: RwaService;
    disputes: DisputeService;
    treasury: TreasuryService;
  },
  verifier?: BearerVerifier,
  idempotencyStore: IdempotencyStore = new InMemoryIdempotencyStore(),
): Router {
  const router = Router();

  // Applied to the whole router rather than route by route. A new route added
  // below is protected by default; one that has to remember its own guard is
  // one that eventually forgets.
  router.use(requireAuth(verifier), requireRole("compliance"));

  // ── Overview ─────────────────────────────────────────────────────────────

  router.get("/metrics", async (_req, res, next) => {
    try {
      res.json(await admin.businessMetrics());
    } catch (err) {
      next(err);
    }
  });

  router.get("/volume", async (req, res, next) => {
    try {
      const days = parsePositiveInt(
        (req.query as Record<string, unknown>).days,
        30,
        365,
      );
      res.json(await admin.volumeSeries(days));
    } catch (err) {
      next(err);
    }
  });

  // ── Queues and listings ──────────────────────────────────────────────────

  router.get("/kyc/reviews", async (_req, res, next) => {
    try {
      res.json({ reviews: await readers.kycReviews() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/assets/reviews", async (_req, res, next) => {
    try {
      res.json({ assets: await readers.assetReviewQueue() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/tokenizations", async (_req, res, next) => {
    try {
      res.json({ tokenizations: await readers.tokenizations() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/disputes", async (_req, res, next) => {
    try {
      res.json({ disputes: await readers.disputes() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/settlements", async (_req, res, next) => {
    try {
      res.json({ settlements: await readers.settlements() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/treasury/movements", async (_req, res, next) => {
    try {
      res.json({ movements: await readers.treasuryMovements() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/audit", async (req, res, next) => {
    try {
      const limit = parsePositiveInt(
        (req.query as Record<string, unknown>).limit,
        100,
        500,
      );
      res.json({ events: await readers.recentAudit(limit) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/events/health", async (_req, res, next) => {
    try {
      res.json(await readers.eventSpineHealth());
    } catch (err) {
      next(err);
    }
  });

  // ── The control surface ──────────────────────────────────────────────────

  router.get("/policies", async (_req, res, next) => {
    try {
      res.json({ policies: await admin.listPolicies() });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/policies/:domain",
    idempotency(idempotencyStore),
    async (req, res, next) => {
      try {
        const actor = actorFrom(req as AuthedRequest);
        const { domain } = req.params as { domain: string };
        if (
          !(Object.values(VerificationDomain) as string[]).includes(domain)
        ) {
          throw new ValidationError(
            `Unknown verification domain "${domain}". Known domains: ` +
              Object.values(VerificationDomain).join(", "),
          );
        }

        const body = (req.body ?? {}) as Record<string, unknown>;
        const update: UpdateVerificationPolicyInput = {};
        if (body.mode !== undefined) {
          update.mode = body.mode as VerificationMode;
        }
        for (const field of [
          "approveMaxRiskBps",
          "rejectMinRiskBps",
          "minConfidenceBps",
        ] as const) {
          if (body[field] !== undefined) {
            if (typeof body[field] !== "number") {
              throw new ValidationError(`${field} must be a number of basis points`);
            }
            update[field] = body[field] as number;
          }
        }
        if (body.humanReviewAboveAmount !== undefined) {
          if (typeof body.humanReviewAboveAmount !== "string") {
            throw new ValidationError(
              "humanReviewAboveAmount must be a string of minor units",
            );
          }
          update.humanReviewAboveAmount = body.humanReviewAboveAmount;
        }

        res.json(
          await admin.updatePolicy(
            domain as VerificationDomain,
            update,
            actor,
          ),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Decisions on queued cases ────────────────────────────────────────────
  //
  // These delegate to the service that owns the decision rather than
  // reimplementing it, so a case decided from the console goes through exactly
  // the same validation, audit, and downstream effects as one decided from the
  // domain's own endpoint.

  router.post(
    "/kyc/reviews/:id",
    idempotency(idempotencyStore),
    async (req, res, next) => {
      try {
        const actor = actorFrom(req as AuthedRequest);
        const { id } = req.params as { id: string };
        const { decision, reason } = (req.body ?? {}) as {
          decision?: unknown;
          reason?: unknown;
        };
        if (decision !== "approve" && decision !== "reject") {
          throw new ValidationError("decision must be 'approve' or 'reject'");
        }
        if (typeof reason !== "string" || reason.trim().length === 0) {
          throw new ValidationError("A reason is required for a KYC decision");
        }
        res.json(
          await services.kyc.resolveReview(id, actor.userId, {
            decision,
            reason,
          }),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/assets/:id/review",
    idempotency(idempotencyStore),
    async (req, res, next) => {
      try {
        const actor = actorFrom(req as AuthedRequest);
        const { id } = req.params as { id: string };
        // `note` is the field name the RWA service uses; accept `reason` too,
        // since every other decision endpoint on this router calls it that and
        // a console posting the wrong key would silently drop the rejection
        // reason the issuer is entitled to.
        const { decision, note, reason } = (req.body ?? {}) as {
          decision?: unknown;
          note?: unknown;
          reason?: unknown;
        };
        if (decision !== "verify" && decision !== "reject") {
          throw new ValidationError("decision must be 'verify' or 'reject'");
        }
        const explanation = typeof note === "string" ? note : reason;
        res.json(
          await services.rwa.reviewAsset(id, actor, {
            decision,
            note: typeof explanation === "string" ? explanation : undefined,
          }),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/treasury/withdrawals/:id/approve",
    idempotency(idempotencyStore),
    async (req, res, next) => {
      try {
        const actor = actorFrom(req as AuthedRequest);
        const { id } = req.params as { id: string };
        res.json(await services.treasury.approveWithdrawal(id, actor));
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/treasury/withdrawals/:id/reject",
    idempotency(idempotencyStore),
    async (req, res, next) => {
      try {
        const actor = actorFrom(req as AuthedRequest);
        const { id } = req.params as { id: string };
        const { reason } = (req.body ?? {}) as { reason?: unknown };
        if (typeof reason !== "string" || reason.trim().length === 0) {
          throw new ValidationError("A reason is required");
        }
        res.json(await services.treasury.rejectWithdrawal(id, actor, reason));
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
