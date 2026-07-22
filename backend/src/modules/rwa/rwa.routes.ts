/**
 * Phase 5: RWA Routes
 * REST API endpoints for tokenization operations.
 */

import { Router } from "express";
import { CurrencyCode, SUPPORTED_CURRENCIES } from "@stellartrust/shared";
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
import type { RwaService } from "./rwa.service.js";
import { AssetType, TokenizationStatus } from "./rwa.types.js";

export function createRwaRouter(
  service: RwaService,
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

  // ── Tokenizations ───────────────────────────────────────────────────────────

  /** POST /rwa/tokenizations — create a tokenization for an asset. */
  router.post(
    "/tokenizations",
    requireAuth(verifier),
    idempotency(mutations),
    async (req, res, next) => {
      try {
        const actor = requireActor(req as AuthedRequest);
        const input = {
          assetId: String(req.body.assetId ?? ""),
          totalUnits: parseIntegerString(req.body.totalUnits, "totalUnits"),
          pricePerUnitAmount: parseIntegerString(
            req.body.pricePerUnitAmount,
            "pricePerUnitAmount",
          ),
          pricePerUnitCurrency: parseCurrency(req.body.pricePerUnitCurrency),
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
