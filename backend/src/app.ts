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
import { getPool, pingDatabase } from "./db/index.js";
import { ReconciliationJob } from "./jobs/reconciliation.job.js";
import { logger } from "./lib/logger.js";
import { metrics } from "./lib/metrics.js";
import { LoggingAlertSink } from "./lib/alerts.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { httpMetrics } from "./middleware/metrics.js";
import { requestId, type RequestWithId } from "./middleware/requestId.js";
import type { BearerVerifier } from "./middleware/auth.js";
import { InMemoryAuditRepository } from "./modules/audit/audit.repository.js";
import {
  InMemoryAuthRepository,
  type AuthRepository,
} from "./modules/auth/auth.repository.js";
import { PgAuthRepository } from "./modules/auth/pg-auth.repository.js";
import { createAuthRouter } from "./modules/auth/auth.routes.js";
import {
  composeBearerVerifiers,
  Sep10Service,
} from "./modules/auth/sep10.service.js";
import { getBearerVerifier } from "./modules/auth/verifier.factory.js";
import {
  InMemoryIdentityRepository,
  type IdentityRepository,
} from "./modules/identity/identity.repository.js";
import { PgIdentityRepository } from "./modules/identity/pg-identity.repository.js";
import { InMemoryKycRepository } from "./modules/kyc/kyc.repository.js";
import { createKycRouter } from "./modules/kyc/kyc.routes.js";
import {
  DeterministicKycRiskClient,
  HttpKycRiskClient,
} from "./modules/kyc/kyc-risk.client.js";
import { OpenAiKycRiskClient } from "./modules/kyc/openai-kyc.client.js";
import type { KycRiskClient } from "./modules/kyc/kyc-risk.client.js";
import { KycService } from "./modules/kyc/kyc.service.js";
import { createKycProvider } from "./modules/kyc/providers/provider.factory.js";
import { createLedgerRouter } from "./modules/ledger/ledger.routes.js";
import { createEscrowGateway } from "./modules/escrow/escrow.gateway.js";
import { InMemoryPaymentRepository } from "./modules/payments/payment.repository.js";
import { createPaymentRouter } from "./modules/payments/payment.routes.js";
import { PaymentService } from "./modules/payments/payment.service.js";
import { createSigner } from "./modules/stellar/signer.js";
import { createAnchorGateway } from "./modules/settlement/anchor.gateway.js";
import { createLiquidityGateway } from "./modules/settlement/liquidity.gateway.js";
import { InMemorySettlementRepository } from "./modules/settlement/settlement.repository.js";
import { SettlementService } from "./modules/settlement/settlement.service.js";
import { SettlementReconciliationJob } from "./modules/settlement/settlement.reconciliation.job.js";
import { createSettlementRouter } from "./modules/settlement/settlement.routes.js";
import {
  DeterministicDisputeRiskClient,
  HttpDisputeRiskClient,
} from "./modules/disputes/dispute-risk.client.js";
import { InMemoryDisputeRepository } from "./modules/disputes/dispute.repository.js";
import { DisputeService } from "./modules/disputes/dispute.service.js";
import { createDisputeRouter } from "./modules/disputes/dispute.routes.js";
import { createRwaGateway } from "./modules/rwa/rwa.gateway.js";
import { InMemoryRwaRepository } from "./modules/rwa/rwa.repository.js";
import { RwaService } from "./modules/rwa/rwa.service.js";
import { createRwaRouter } from "./modules/rwa/rwa.routes.js";
import { InMemoryReputationRepository } from "./modules/reputation/reputation.repository.js";
import { ReputationService } from "./modules/reputation/reputation.service.js";
import { createReputationRouter } from "./modules/reputation/reputation.routes.js";

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
  // Allow the primary origin plus explicitly configured deployment origins.
  // Credentials are not used because SEP-10 bearer sessions are sent explicitly.
  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (
      origin &&
      (origin === config.FRONTEND_ORIGIN ||
        config.FRONTEND_ORIGINS.includes(origin))
    ) {
      res.setHeader("access-control-allow-origin", origin);
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
  app.use(httpMetrics(metrics));

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

  // ── Phase 6: liveness, readiness, and metrics ─────────────────────────────
  // Liveness answers "is the process up?" — never touches dependencies so an
  // orchestrator does not kill a pod during a transient dependency blip.
  app.get("/health/live", (_req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  // Readiness answers "can we serve traffic?" — probes configured dependencies
  // and any hard-failed reconciliation state. Returns 503 when degraded so the
  // load balancer stops routing until recovery.
  app.get("/health/ready", async (_req, res) => {
    const databaseConfigured = Boolean(config.DATABASE_URL);
    const database = databaseConfigured ? await pingDatabase() : "not_configured";
    const reconciliation = app.locals.reconciliationJob as
      | ReconciliationJob
      | undefined;
    const settlementReconciliation = app.locals
      .settlementReconciliationJob as { lastUnresolved?: () => number } | undefined;
    const ledgerUnresolved = reconciliation?.lastUnresolved?.() ?? 0;
    const settlementUnresolved =
      settlementReconciliation?.lastUnresolved?.() ?? 0;

    const ready =
      (database === true || database === "not_configured") &&
      ledgerUnresolved === 0 &&
      settlementUnresolved === 0;

    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "degraded",
      checks: {
        database,
        ledgerUnresolvedMismatches: ledgerUnresolved,
        settlementUnresolvedMismatches: settlementUnresolved,
      },
      time: new Date().toISOString(),
    });
  });

  // Prometheus text-exposition endpoint (operational signals only, no PII).
  app.get("/metrics", (_req, res) => {
    res.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(metrics.render());
  });

  // ── Shared Phase 1 dependency graph ──────────────────────────────────────
  // The configured demo account is development-only and still authenticates by
  // signing a SEP-10 challenge with its wallet. Production ignores these values.
  const demoAccount =
    config.NODE_ENV === "development" && config.AUTH_DEMO_WALLET
      ? {
          stellarPublicKey: config.AUTH_DEMO_WALLET,
          displayName: config.AUTH_DEMO_NAME,
        }
      : undefined;
  const demoAccounts = demoAccount ? [demoAccount] : [];

  // Persist identities and sessions in Postgres when a database is configured
  // so opaque SEP-10 bearer tokens survive restarts. Tests stay hermetic on the
  // in-memory implementations (no DB connection).
  const usePersistentStore = Boolean(config.DATABASE_URL) && !config.isTest;
  if (usePersistentStore) {
    logger.info("identity/auth: using Postgres-backed repositories");
  } else {
    logger.warn(
      "identity/auth: using in-memory repositories — sessions reset on restart",
    );
  }

  const identities: IdentityRepository = usePersistentStore
    ? new PgIdentityRepository(getPool(), demoAccounts)
    : new InMemoryIdentityRepository(demoAccounts);
  const authRepository: AuthRepository = usePersistentStore
    ? new PgAuthRepository(getPool())
    : new InMemoryAuthRepository();
  const sep10 = new Sep10Service(
    authRepository,
    identities,
    createSigner(),
    new Set(demoAccount ? [demoAccount.stellarPublicKey] : []),
  );
  const externalVerifier = getBearerVerifier();

  // ── DEV-ONLY AUTH BYPASS ──────────────────────────────────────────────────
  // When enabled (development + a configured demo wallet), any request bearing
  // `AUTH_DEV_BEARER` is accepted and mapped to the seeded demo identity — no
  // SEP-10 challenge/signature required. This is strictly local: the guard
  // below never activates in staging/production (mirrors the demoAccount gate),
  // so protected money/PII/escrow routes remain authenticated in real
  // deployments (Rules.md #5). Resolving to the real demo identity (a valid
  // user UUID) keeps identity-backed endpoints working under Postgres.
  const verifiers: BearerVerifier[] = [sep10.sessionVerifier];
  if (config.NODE_ENV === "development" && config.AUTH_DEMO_WALLET) {
    const demoWallet = config.AUTH_DEMO_WALLET;
    logger.warn(
      "auth: DEV BYPASS active — AUTH_DEV_BEARER grants the demo identity without SEP-10",
    );
    verifiers.push(async (token) => {
      if (token !== config.AUTH_DEV_BEARER) return null;
      const { user, wallet } = await identities.upsertWalletIdentity(demoWallet);
      return {
        userId: user.id,
        walletId: wallet.id,
        roles: ["user", "compliance"],
      };
    });
  }
  verifiers.push(externalVerifier);
  const bearerVerifier = composeBearerVerifiers(...verifiers);
  const audit = new InMemoryAuditRepository();
  // Phase 6: shared alert sink (structured log + metrics; swap for PagerDuty/
  // Slack in staging/production without touching call sites).
  const alerts = new LoggingAlertSink(metrics);
  const kycRiskClient: KycRiskClient = config.isTest
    ? new DeterministicKycRiskClient()
    : config.KYC_RISK_ENGINE === "openai" && config.OPENAI_API_KEY
      ? new OpenAiKycRiskClient(config.OPENAI_API_KEY)
      : new HttpKycRiskClient();
  if (config.KYC_RISK_ENGINE === "openai" && !config.OPENAI_API_KEY && !config.isTest) {
    logger.warn(
      "KYC_RISK_ENGINE=openai but OPENAI_API_KEY is unset; falling back to the AI service client",
    );
  }
  const kyc = new KycService(
    createKycProvider(),
    kycRiskClient,
    new InMemoryKycRepository(),
    identities,
    audit,
    {
      // Development shortcut only — never auto-approve in production.
      autoApprove: config.KYC_AUTO_APPROVE && !config.isProduction,
      autoApproveDelayMs: config.KYC_AUTO_APPROVE_DELAY_MS,
    },
  );
  // ── Phase 5: RWA Tokenization (opt-in module) ────────────────────────────
  // RWA module is separate from the escrow happy path. Tokenization enables
  // sellers to unlock working capital and investors to get transparent
  // fractional ownership. Payouts distribute automatically when buyer pays.
  const rwaRepository = new InMemoryRwaRepository();
  const rwaGateway = createRwaGateway();
  const rwa = new RwaService(rwaRepository, rwaGateway, audit);

  // ── Phase 6: Reputation store (advisory prior for dispute risk) ───────────
  const reputationService = new ReputationService(
    new InMemoryReputationRepository(),
    audit,
  );

  // Wire RWA + reputation into payment service. RWA payout distributes on
  // release; a completed release also records a positive reputation signal.
  const paymentRepository = new InMemoryPaymentRepository();
  const escrowGateway = createEscrowGateway();
  const payments = new PaymentService(
    paymentRepository,
    escrowGateway,
    audit,
    rwa,
    reputationService,
  );
  const reconciliation = new ReconciliationJob(
    paymentRepository,
    escrowGateway,
    config.RECONCILIATION_INTERVAL_MS,
    alerts,
    metrics,
  );
  app.locals.reconciliationJob = reconciliation;

  // ── Phase 3: Cross-Border Settlement ─────────────────────────────────────
  const settlementRepository = new InMemorySettlementRepository();
  const liquidityGateway = createLiquidityGateway();
  const anchorGateway = createAnchorGateway();
  const settlement = new SettlementService(
    settlementRepository,
    liquidityGateway,
    anchorGateway,
    audit,
  );
  const settlementReconciliation = new SettlementReconciliationJob(
    settlementRepository,
    anchorGateway,
    config.RECONCILIATION_INTERVAL_MS,
    alerts,
    metrics,
  );
  app.locals.settlementReconciliationJob = settlementReconciliation;

  // ── Phase 4: Disputes + AI (advisory) ────────────────────────────────────
  // The AI dispute recommender is advisory only; the backend owns the human
  // gate and any fund movement stays on the compliance arbiter path.
  const disputeRepository = new InMemoryDisputeRepository();
  const disputeOrders = {
    getOrder: (orderId: string) => paymentRepository.findOrder(orderId),
  };
  const disputes = new DisputeService(
    disputeRepository,
    disputeOrders,
    config.isTest
      ? new DeterministicDisputeRiskClient()
      : new HttpDisputeRiskClient(),
    audit,
    reputationService,
    {
      // Auto-execute a resolved dispute's outcome through the Phase 2 arbiter
      // payments path (Phase 6). System-authorized; non-fatal on failure.
      settle: ({ orderId, outcome }) =>
        payments
          .settleDisputedOrder(orderId, outcome, {
            userId: "system:dispute-resolver",
            roles: ["system"],
          })
          .then(() => undefined),
    },
  );

  // ── Module routers ────────────────────────────────────────────────────────
  app.use("/api/auth", createAuthRouter(sep10, identities, bearerVerifier));
  app.use("/api/kyc", createKycRouter(kyc, bearerVerifier));
  app.use("/api/ledger", createLedgerRouter(undefined, bearerVerifier));
  app.use(
    "/api/payments",
    createPaymentRouter(payments, reconciliation, bearerVerifier),
  );
  app.use(
    "/api/settlement",
    createSettlementRouter(settlement, settlementReconciliation, bearerVerifier),
  );
  app.use("/api/disputes", createDisputeRouter(disputes, bearerVerifier));
  app.use("/api/rwa", createRwaRouter(rwa, bearerVerifier));
  app.use(
    "/api/reputation",
    createReputationRouter(reputationService, bearerVerifier),
  );

  // ── Error boundary ──────────────────────────────────────────────────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
