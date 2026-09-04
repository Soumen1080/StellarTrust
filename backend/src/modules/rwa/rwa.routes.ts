/**
 * Phase 5: RWA Routes
 * REST API endpoints for tokenization operations.
 */

import { Router } from "express";
import {
  CurrencyCode,
  RwaTransition,
  SUPPORTED_CURRENCIES,
} from "@stellartrust/shared";
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
import type { RwaReconciliationJob } from "./rwa.reconciliation.job.js";
import type { RwaService } from "./rwa.service.js";
import { AssetType, TokenizationStatus } from "./rwa.types.js";
import type {
  AssetCounterpartyInput,
  AssetDocumentInput,
} from "./rwa.types.js";

/**
 * Contract operations that can require the issuer's own wallet signature.
 * Which of them actually do is a runtime property of `RWA_CUSTODY` (see
 * `GET /rwa/capabilities`), so the routes exist either way and answer 409 with
 * a usable message when a client picks the wrong path.
 */
const preparableByRoute = {
  deploy: RwaTransition.Deploy,
  transfer: RwaTransition.Transfer,
  authorize: RwaTransition.Authorize,
  revoke: RwaTransition.Revoke,
  freeze: RwaTransition.Freeze,
  unfreeze: RwaTransition.Unfreeze,
  distribute: RwaTransition.Distribute,
} as const;

/** The optional targets an operation can act on, read off the request body. */
function operationArgs(body: unknown): {
  holdingId?: string;
  holderAddress?: string;
} {
  if (typeof body !== "object" || body === null) return {};
  const { holdingId, holderAddress } = body as Record<string, unknown>;
  return {
    holdingId: typeof holdingId === "string" ? holdingId : undefined,
    holderAddress:
      typeof holderAddress === "string" ? holderAddress : undefined,
  };
}

export function createRwaRouter(
  service: RwaService,
  reconciliation: RwaReconciliationJob,
  verifier?: BearerVerifier,
): Router {
  const router = Router();
  const mutations = new InMemoryIdempotencyStore();

  // ── Assets ────────────────────────────────────────────────────────────────

  /** POST /rwa/assets — create a new asset for tokenization. */
  router.post(
    "/assets",
    requireAuth(verifier),
    idempotency(mutations),
    async (req, res, next) => {
      try {
        const actor = requireActor(req as AuthedRequest);
        const input = {
          assetType: parseAssetType(req.body.assetType),
          assetRef: String(req.body.assetRef ?? ""),
          description: String(req.body.description ?? ""),
          valuationAmount: parseIntegerString(
            req.body.valuationAmount,
            "valuationAmount",
          ),
          valuationCurrency: parseCurrency(req.body.valuationCurrency),
          metadata: req.body.metadata,
          ...(req.body.documents === undefined
            ? {}
            : { documents: parseDocuments(req.body.documents) }),
          ...(req.body.counterparty === undefined
            ? {}
            : { counterparty: parseCounterparty(req.body.counterparty) }),
        };
        res.status(201).json(await service.createAsset(actor.userId, input));
      } catch (err) {
        next(err);
      }
    },
  );

  /** GET /rwa/assets — list assets owned by the authenticated user. */
  router.get("/assets", requireAuth(verifier), async (req, res, next) => {
    try {
      const actor = requireActor(req as AuthedRequest);
      res.json({ assets: await service.listAssets(actor.userId) });
    } catch (err) {
      next(err);
    }
  });

  // ── Asset verification (plane.md §3.1) ────────────────────────────────────
  //
  // Declared before `/assets/:assetId/...` would be reachable by a wildcard:
  // `/assets/review-queue` is a fixed path and must not be parsed as an asset
  // id by a route registered above it.

  /** GET /rwa/assets/review-queue — assets awaiting a compliance decision. */
  router.get(
    "/assets/review-queue",
    requireAuth(verifier),
    async (req, res, next) => {
      try {
        const actor = requireActor(req as AuthedRequest);
        res.json({ assets: await service.listAssetsForReview(actor) });
      } catch (err) {
        next(err);
      }
    },
  );

  /** POST /rwa/assets/:assetId/documents — attach supporting evidence. */
  router.post(
    "/assets/:assetId/documents",
    requireAuth(verifier),
    idempotency(mutations),
    async (req, res, next) => {
      try {
        const actor = requireActor(req as AuthedRequest);
        res.json(
          await service.addAssetDocuments(
            String(req.params.assetId),
            actor,
            parseDocuments(req.body.documents),
          ),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  /** POST /rwa/assets/:assetId/submit — submit for compliance review. */
  router.post(
    "/assets/:assetId/submit",
    requireAuth(verifier),
    idempotency(mutations),
    async (req, res, next) => {
      try {
        const actor = requireActor(req as AuthedRequest);
        res.json(
          await service.submitAssetForReview(String(req.params.assetId), actor),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  /** POST /rwa/assets/:assetId/review — compliance verdict on an asset. */
  router.post(
    "/assets/:assetId/review",
    requireAuth(verifier),
    idempotency(mutations),
    async (req, res, next) => {
      try {
        const actor = requireActor(req as AuthedRequest);
        const decision = String(req.body.decision ?? "");
        if (decision !== "verify" && decision !== "reject") {
          throw new ValidationError(
            'decision must be "verify" or "reject"',
          );
        }
        res.json(
          await service.reviewAsset(String(req.params.assetId), actor, {
            decision,
            ...(req.body.note === undefined
              ? {}
              : { note: String(req.body.note) }),
          }),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Tokenizations ───────────────────────────────────────────────────────────

  /** POST /rwa/tokenizations — create a tokenization for an asset. */
  router.post(
    "/tokenizations",
    requireAuth(verifier),
    idempotency(mutations),
    async (req, res, next) => {
      try {
        const actor = requireActor(req as AuthedRequest);
        // The unit price is deliberately not accepted from the client: it is
        // derived server-side from the financing terms, because a price that
        // disagrees with the terms produces a payout waterfall that cannot be
        // paid. Callers send the terms; the server does the arithmetic.
        const input = {
          assetId: String(req.body.assetId ?? ""),
          totalUnits: parseIntegerString(req.body.totalUnits, "totalUnits"),
          faceValueAmount: parseIntegerString(
            req.body.faceValueAmount,
            "faceValueAmount",
          ),
          faceValueCurrency: parseCurrency(req.body.faceValueCurrency),
          advanceRateBps: parseBps(req.body.advanceRateBps, "advanceRateBps"),
          discountRateBps: parseBps(req.body.discountRateBps, "discountRateBps"),
          ...(req.body.platformFeeBps === undefined
            ? {}
            : {
                platformFeeBps: parseBps(
                  req.body.platformFeeBps,
                  "platformFeeBps",
                ),
              }),
          maturityDate: String(req.body.maturityDate ?? ""),
          requireAuthorization: Boolean(req.body.requireAuthorization),
          linkedOrderId: req.body.linkedOrderId
            ? String(req.body.linkedOrderId)
            : undefined,
        };
        res
          .status(201)
          .json(await service.createTokenization(actor.userId, input));
      } catch (err) {
        next(err);
      }
    },
  );

  /** POST /rwa/tokenizations/:id/deploy — deploy to the blockchain. */
  router.post(
    "/tokenizations/:tokenizationId/deploy",
    requireAuth(verifier),
    idempotency(mutations),
    async (req, res, next) => {
      try {
        const actor = requireActor(req as AuthedRequest);
        res.json(
          await service.deployTokenization(
            String(req.params.tokenizationId),
            actor,
          ),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  /** GET /rwa/tokenizations/:id — detailed tokenization information. */
  router.get(
    "/tokenizations/:tokenizationId",
    requireAuth(verifier),
    async (req, res, next) => {
      try {
        res.json(
          await service.getTokenizationDetails(
            String(req.params.tokenizationId),
          ),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  /** GET /rwa/tokenizations — list tokenizations (with optional filters). */
  router.get("/tokenizations", requireAuth(verifier), async (req, res, next) => {
    try {
      const filters: {
        issuerUserId?: string;
        status?: TokenizationStatus;
      } = {};
      if (req.query.issuerUserId) {
        filters.issuerUserId = String(req.query.issuerUserId);
      }
      if (req.query.status) {
        filters.status = parseTokenizationStatus(String(req.query.status));
      }
      res.json({ tokenizations: await service.listTokenizations(filters) });
    } catch (err) {
      next(err);
    }
  });

  /** POST /rwa/tokenizations/:id/freeze — freeze transfers (compliance). */
  router.post(
    "/tokenizations/:tokenizationId/freeze",
    requireAuth(verifier),
    idempotency(mutations),
    async (req, res, next) => {
      try {
        const actor = requireActor(req as AuthedRequest);
        res.json(
          await service.freezeTokenization(
            String(req.params.tokenizationId),
            actor,
          ),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  /** POST /rwa/tokenizations/:id/unfreeze — unfreeze transfers. */
  router.post(
    "/tokenizations/:tokenizationId/unfreeze",
    requireAuth(verifier),
    idempotency(mutations),
    async (req, res, next) => {
      try {
        const actor = requireActor(req as AuthedRequest);
        res.json(
          await service.unfreezeTokenization(
            String(req.params.tokenizationId),
            actor,
          ),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Investor operations ──────────────────────────────────────────────────────

  /** POST /rwa/tokenizations/:id/purchase — buy tokenized units. */
  router.post(
    "/tokenizations/:tokenizationId/purchase",
    requireAuth(verifier),
    idempotency(mutations),
    async (req, res, next) => {
      try {
        const actor = requireActor(req as AuthedRequest);
        const input = {
          units: parseIntegerString(req.body.units, "units"),
          holderAddress: String(req.body.holderAddress ?? ""),
        };
        res.json(
          await service.purchaseUnits(
            String(req.params.tokenizationId),
            actor,
            input,
          ),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * POST /rwa/tokenizations/:id/cancel — unwind a purchase within the
   * cooling-off window (plane.md §3.2).
   *
   * A POST rather than a DELETE on the holding: this posts a reversing ledger
   * transaction and may move units back on-chain, so it is an operation with
   * consequences, not the removal of a resource.
   */
  router.post(
    "/tokenizations/:tokenizationId/cancel",
    requireAuth(verifier),
    idempotency(mutations),
    async (req, res, next) => {
      try {
        const actor = requireActor(req as AuthedRequest);
        res.json(
          await service.cancelPurchase(
            String(req.params.tokenizationId),
            actor,
          ),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  /** GET /rwa/portfolio — investor portfolio across all holdings. */
  router.get("/portfolio", requireAuth(verifier), async (req, res, next) => {
    try {
      const actor = requireActor(req as AuthedRequest);
      res.json(await service.getInvestorPortfolio(actor.userId));
    } catch (err) {
      next(err);
    }
  });

  // ── System operations (typically invoked by other modules) ───────────────────

  /**
   * POST /rwa/tokenizations/:id/distribute-payout — distribute payout to holders.
   * Normally triggered automatically by escrow release; exposed for
   * compliance-driven recovery/testing.
   */
  router.post(
    "/tokenizations/:tokenizationId/distribute-payout",
    requireAuth(verifier),
    idempotency(mutations),
    async (req, res, next) => {
      try {
        const actor = requireActor(req as AuthedRequest);
        const payoutAmount = parseIntegerString(
          req.body.payoutAmount,
          "payoutAmount",
        );
        res.json(
          await service.distributePayout(
            String(req.params.tokenizationId),
            String(req.body.orderId ?? ""),
            String(req.body.transition ?? ""),
            BigInt(payoutAmount),
            String(req.body.payoutCurrency ?? ""),
            actor,
          ),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Issuer-signed operations (RWA_CUSTODY=issuer) ─────────────────────────

  /**
   * GET /rwa/capabilities — who signs each contract operation here.
   *
   * Mirrors the payments equivalent so a client reads the custody model rather
   * than assuming one.
   */
  router.get("/capabilities", requireAuth(verifier), async (req, res, next) => {
    try {
      requireActor(req as AuthedRequest);
      res.json(await service.capabilities());
    } catch (err) {
      next(err);
    }
  });

  for (const [route, transition] of Object.entries(preparableByRoute)) {
    // Preparing is read-shaped and legitimately repeatable (a user reopening
    // their wallet), so it is not idempotency-keyed. For a deploy it reuses
    // the already-created contract rather than making a second one.
    router.post(
      `/tokenizations/:id/${route}/prepare`,
      requireAuth(verifier),
      async (req, res, next) => {
        try {
          const actor = requireActor(req as AuthedRequest);
          res.json(
            await service.prepareOperation(
              String(req.params.id),
              transition,
              { userId: actor.userId, roles: actor.roles },
              operationArgs(req.body),
            ),
          );
        } catch (err) {
          next(err);
        }
      },
    );

    router.post(
      `/tokenizations/:id/${route}/submit`,
      requireAuth(verifier),
      idempotency(mutations),
      async (req, res, next) => {
        try {
          const actor = requireActor(req as AuthedRequest);
          const signedXdr = req.body?.signedXdr;
          if (typeof signedXdr !== "string" || signedXdr.length === 0) {
            throw new ValidationError("A signed transaction is required", [
              { path: "signedXdr", message: "expected a base64 XDR envelope" },
            ]);
          }
          res.json(
            await service.submitSignedOperation(
              String(req.params.id),
              transition,
              { userId: actor.userId, roles: actor.roles },
              signedXdr,
              operationArgs(req.body),
            ),
          );
        } catch (err) {
          next(err);
        }
      },
    );
  }

  /**
   * POST /rwa/reconciliation/run — compare holdings against the token
   * contracts on demand.
   *
   * Mirrors the payments equivalent. A compliance operator investigating a
   * blocked payout needs to be able to ask the question now rather than wait
   * for the next scheduled pass.
   */
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

// ── Helpers ─────────────────────────────────────────────────────────────────

function requireActor(req: AuthedRequest) {
  if (!req.auth) throw new ValidationError("Authenticated actor is missing");
  return req.auth;
}

/** Parse a positive integer value provided as a number or string into a string. */
function parseIntegerString(value: unknown, field: string): string {
  if (typeof value === "number" && Number.isInteger(value)) {
    return String(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return value.trim();
  }
  throw new ValidationError(`${field} must be a non-negative integer`);
}

/**
 * A basis-point rate: a whole number in [0, 10000].
 *
 * Accepted as a number or a numeric string, because a JSON body typed by hand
 * and one produced by a form both reach here. The upper bound is enforced at
 * the boundary as well as in the domain: 10001 bps is not a rate, and rejecting
 * it here names the field the caller got wrong.
 */
function parseBps(value: unknown, field: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_000) {
    throw new ValidationError(
      `${field} must be a whole number of basis points between 0 and 10000`,
    );
  }
  return parsed;
}

/**
 * Parse supporting-document references (plane.md §3.1).
 *
 * References only. A caller that sends file contents here gets them rejected
 * by the shape rather than stored: this platform records that a document
 * exists and can prove which one was reviewed, and never holds the file
 * (Rules.md §3).
 */
function parseDocuments(value: unknown): AssetDocumentInput[] {
  if (!Array.isArray(value)) {
    throw new ValidationError("documents must be an array");
  }
  if (value.length === 0) {
    throw new ValidationError("At least one document is required");
  }
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new ValidationError(`documents[${index}] must be an object`);
    }
    const { docRef, docType, sha256 } = entry as Record<string, unknown>;
    if (typeof docRef !== "string" || docRef.trim().length === 0) {
      throw new ValidationError(`documents[${index}].docRef is required`);
    }
    if (typeof docType !== "string" || docType.trim().length === 0) {
      throw new ValidationError(`documents[${index}].docType is required`);
    }
    if (sha256 !== undefined && typeof sha256 !== "string") {
      throw new ValidationError(`documents[${index}].sha256 must be a string`);
    }
    return {
      docRef: docRef.trim(),
      docType: docType.trim(),
      ...(sha256 === undefined ? {} : { sha256: sha256.trim() }),
    };
  });
}

/** Parse the counterparty (the debtor) on an asset. */
function parseCounterparty(value: unknown): AssetCounterpartyInput {
  if (typeof value !== "object" || value === null) {
    throw new ValidationError("counterparty must be an object");
  }
  const { ref, name } = value as Record<string, unknown>;
  if (typeof ref !== "string" || ref.trim().length === 0) {
    throw new ValidationError("counterparty.ref is required");
  }
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new ValidationError("counterparty.name is required");
  }
  return { ref: ref.trim(), name: name.trim() };
}

function parseCurrency(value: unknown): CurrencyCode {
  if (typeof value === "string") {
    const upper = value.toUpperCase();
    if ((SUPPORTED_CURRENCIES as readonly string[]).includes(upper)) {
      return upper as CurrencyCode;
    }
  }
  throw new ValidationError(
    `Unsupported currency: ${value}. Supported: ${SUPPORTED_CURRENCIES.join(", ")}`,
  );
}

function parseAssetType(value: unknown): AssetType {
  if (!value || typeof value !== "string") {
    throw new ValidationError("assetType is required");
  }
  switch (value.toLowerCase()) {
    case "invoice":
      return AssetType.Invoice;
    case "commodity":
      return AssetType.Commodity;
    case "real_estate":
    case "realestate":
      return AssetType.RealEstate;
    case "other":
      return AssetType.Other;
    default:
      throw new ValidationError(
        `Invalid asset type: ${value}. Must be one of: invoice, commodity, real_estate, other`,
      );
  }
}

function parseTokenizationStatus(value: string): TokenizationStatus {
  switch (value.toLowerCase()) {
    case "draft":
      return TokenizationStatus.Draft;
    case "active":
      return TokenizationStatus.Active;
    case "funded":
      return TokenizationStatus.Funded;
    case "distributing":
      return TokenizationStatus.Distributing;
    case "distributed":
      return TokenizationStatus.Distributed;
    case "frozen":
      return TokenizationStatus.Frozen;
    case "cancelled":
      return TokenizationStatus.Cancelled;
    default:
      throw new ValidationError(`Invalid tokenization status: ${value}`);
  }
}
