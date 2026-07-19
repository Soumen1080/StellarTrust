/**
 * Express application factory (modular monolith).
 * Wires middleware and per-module routers. Kept separate from the server
 * bootstrap so tests can import the app without opening a port.
 */
import type { IncomingMessage } from "node:http";
import type { HealthResponse } from "@stellartrust/shared";
import express, { type Express, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import helmetImport from "helmet";
import { pinoHttp } from "pino-http";
import { config } from "./config/index.js";
import { logger } from "./lib/logger.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { requestId, type RequestWithId } from "./middleware/requestId.js";
import { InMemoryAuditRepository } from "./modules/audit/audit.repository.js";
import { InMemoryAuthRepository } from "./modules/auth/auth.repository.js";
import { createAuthRouter } from "./modules/auth/auth.routes.js";
import {
  composeBearerVerifiers,
  Sep10Service,
} from "./modules/auth/sep10.service.js";
import { getBearerVerifier } from "./modules/auth/verifier.factory.js";
import { InMemoryIdentityRepository } from "./modules/identity/identity.repository.js";
import { InMemoryKycRepository } from "./modules/kyc/kyc.repository.js";
import { createKycRouter } from "./modules/kyc/kyc.routes.js";
import {
  DeterministicKycRiskClient,
  HttpKycRiskClient,
} from "./modules/kyc/kyc-risk.client.js";
import { KycService } from "./modules/kyc/kyc.service.js";
import { createKycProvider } from "./modules/kyc/providers/provider.factory.js";
import { createLedgerRouter } from "./modules/ledger/ledger.routes.js";
import { createSigner } from "./modules/stellar/signer.js";

type HelmetFactory = () => RequestHandler;

function resolveHelmetFactory(imported: unknown): HelmetFactory {
  if (typeof imported === "function") return imported as HelmetFactory;
  if (imported && typeof imported === "object" && "default" in imported) {
    const defaultExport = (imported as { default: unknown }).default;
    if (typeof defaultExport === "function") {
      return defaultExport as HelmetFactory;
    }
  }
  throw new TypeError("Helmet did not expose a callable middleware factory");
}

const helmet = resolveHelmetFactory(helmetImport);

export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  // Single-origin CORS for the separately deployed frontend. Credentials are
  // not used because SEP-10 bearer sessions are sent explicitly.
  app.use((req, res, next) => {
    if (req.header("origin") === config.FRONTEND_ORIGIN) {
      res.setHeader("access-control-allow-origin", config.FRONTEND_ORIGIN);
      res.setHeader(
        "access-control-allow-headers",
        "authorization,content-type,idempotency-key,x-request-id,x-dev-approval-password",
      );
      res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
      res.setHeader("vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req: IncomingMessage) =>
        (req as unknown as RequestWithId).requestId,
    }),
  );

  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  app.get("/health", (_req, res) => {
    const body: HealthResponse = {
      status: "ok",
      service: config.serviceName,
      version: config.version,
      time: new Date().toISOString(),
    };
    res.json(body);
  });

  // ── Shared Phase 1 dependency graph ──────────────────────────────────────
  const identities = new InMemoryIdentityRepository();
  const sep10 = new Sep10Service(
    new InMemoryAuthRepository(),
    identities,
    createSigner(),
  );
  const externalVerifier = getBearerVerifier();
  const bearerVerifier = composeBearerVerifiers(
    sep10.sessionVerifier,
    externalVerifier,
  );
  const kyc = new KycService(
    createKycProvider(),
    config.isTest
      ? new DeterministicKycRiskClient()
      : new HttpKycRiskClient(),
    new InMemoryKycRepository(),
    identities,
    new InMemoryAuditRepository(),
  );

  // ── Module routers ────────────────────────────────────────────────────────
  app.use("/api/auth", createAuthRouter(sep10, identities, bearerVerifier));
  app.use("/api/kyc", createKycRouter(kyc, bearerVerifier));
  app.use("/api/ledger", createLedgerRouter(undefined, bearerVerifier));

  // ── Error boundary ──────────────────────────────────────────────────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
