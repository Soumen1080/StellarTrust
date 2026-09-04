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
import { isAllowedOrigin } from "./lib/cors.js";
import { getPool, pingDatabase } from "./db/index.js";
import { ReconciliationJob } from "./jobs/reconciliation.job.js";
import { logger } from "./lib/logger.js";
import { metrics } from "./lib/metrics.js";
import { LoggingAlertSink } from "./lib/alerts.js";
import { getRedis } from "./lib/redis.js";
import { createIdempotencyStore } from "./middleware/idempotency.js";
import { RedisRateLimitStore } from "./middleware/rate-limit.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { httpMetrics } from "./middleware/metrics.js";
import { requestId, type RequestWithId } from "./middleware/requestId.js";
import type { BearerVerifier } from "./middleware/auth.js";
import {
  InMemoryAuditRepository,
  type AuditRepository,
} from "./modules/audit/audit.repository.js";
import { PgAuditRepository } from "./modules/audit/pg-audit.repository.js";
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
import {
  InMemoryKycRepository,
  type KycRepository,
} from "./modules/kyc/kyc.repository.js";
import { PgKycRepository } from "./modules/kyc/pg-kyc.repository.js";
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
import {
  InMemoryLedgerRepository,
  type LedgerRepository,
} from "./modules/ledger/ledger.repository.js";
import { PgLedgerRepository } from "./modules/ledger/pg-ledger.repository.js";
import { LedgerService } from "./modules/ledger/ledger.service.js";
import { createEscrowGateway } from "./modules/escrow/escrow.gateway.js";
import { IdentityWalletAddressResolver } from "./modules/identity/wallet.resolver.js";
import { InMemoryPaymentRepository } from "./modules/payments/payment.repository.js";
import type { PaymentRepository } from "./modules/payments/payment.repository.js";
import { PgPaymentRepository } from "./modules/payments/pg-payment.repository.js";
import { createPaymentRouter } from "./modules/payments/payment.routes.js";
import { PaymentService } from "./modules/payments/payment.service.js";
import { createSigner } from "./modules/stellar/signer.js";
import { StellarClient } from "./modules/stellar/stellar.client.js";
import { createWalletBalancesRouter } from "./modules/stellar/wallet-balances.routes.js";
import { createAnchorGateway } from "./modules/settlement/anchor.gateway.js";
import { createLiquidityGateway } from "./modules/settlement/liquidity.gateway.js";
import {
  InMemorySettlementRepository,
  type SettlementRepository,
} from "./modules/settlement/settlement.repository.js";
import { SettlementService } from "./modules/settlement/settlement.service.js";
import { SettlementReconciliationJob } from "./modules/settlement/settlement.reconciliation.job.js";
import { createSettlementRouter } from "./modules/settlement/settlement.routes.js";
import {
  DeterministicDisputeRiskClient,
  HttpDisputeRiskClient,
} from "./modules/disputes/dispute-risk.client.js";
import {
  InMemoryDisputeRepository,
  type DisputeRepository,
} from "./modules/disputes/dispute.repository.js";
import { PgDisputeRepository } from "./modules/disputes/pg-dispute.repository.js";
import { PgSettlementRepository } from "./modules/settlement/pg-settlement.repository.js";
import { DisputeService } from "./modules/disputes/dispute.service.js";
import { createDisputeRouter } from "./modules/disputes/dispute.routes.js";
import { createRwaGateway } from "./modules/rwa/rwa.gateway.js";
import {
  InMemoryRwaRepository,
  type RwaRepository,
} from "./modules/rwa/rwa.repository.js";
import { PgRwaRepository } from "./modules/rwa/pg-rwa.repository.js";
import { RwaService } from "./modules/rwa/rwa.service.js";
import { RwaReconciliationJob } from "./modules/rwa/rwa.reconciliation.job.js";
import { RwaLifecycleJob } from "./modules/rwa/rwa.lifecycle.job.js";
import { EventBus } from "./modules/events/event.bus.js";
import {
  InMemoryEventRepository,
  type EventRepository,
} from "./modules/events/event.repository.js";
import { PgEventRepository } from "./modules/events/pg-event.repository.js";
import {
  rwaHoldOnDispute,
  rwaPayoutOnRelease,
  rwaResumeOnDisputeResolved,
} from "./modules/rwa/rwa.subscribers.js";
import { orderDepositOnSettlement } from "./modules/payments/payment.subscribers.js";
import { createTreasuryGateway } from "./modules/treasury/treasury.gateway.js";
import {
  InMemoryTreasuryRepository,
  type TreasuryRepository,
} from "./modules/treasury/treasury.repository.js";
import { PgTreasuryRepository } from "./modules/treasury/pg-treasury.repository.js";
import { TreasuryService } from "./modules/treasury/treasury.service.js";
import { createTreasuryRouter } from "./modules/treasury/treasury.routes.js";
import { PositionsService } from "./modules/positions/positions.service.js";
import { createPositionsRouter } from "./modules/positions/positions.routes.js";
import { createRwaRouter } from "./modules/rwa/rwa.routes.js";
import {
  InMemoryReputationRepository,
  type ReputationRepository,
} from "./modules/reputation/reputation.repository.js";
import { PgReputationRepository } from "./modules/reputation/pg-reputation.repository.js";
import { ReputationService } from "./modules/reputation/reputation.service.js";
import { createReputationRouter } from "./modules/reputation/reputation.routes.js";
import {
  type FeedbackRepository,
  InMemoryFeedbackRepository,
} from "./modules/feedback/feedback.repository.js";
import { PgFeedbackRepository } from "./modules/feedback/pg-feedback.repository.js";
import { FeedbackService } from "./modules/feedback/feedback.service.js";
import { createFeedbackRouter } from "./modules/feedback/feedback.routes.js";

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
  // Behind Vercel (and most managed platforms) the app runs behind a reverse
  // proxy that terminates TLS and sets `X-Forwarded-For` / `Forwarded`. Trust
  // the first proxy hop so `req.ip` resolves to the real client IP instead of
  // the internal 127.0.0.1 socket address. Without this, express-rate-limit
  // v8 throws ERR_ERL_FORWARDED_HEADER / ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
  // and rate limiting would otherwise bucket every request under one IP.
  app.set("trust proxy", 1);
  app.use(helmet());
  // Allow the primary origin plus explicitly configured deployment origins.
  // Credentials are not used because SEP-10 bearer sessions are sent explicitly.
  const allowedOrigins = [config.FRONTEND_ORIGIN, ...config.FRONTEND_ORIGINS];
  // A rejected origin is otherwise invisible server-side: the request is served
  // normally and the browser discards the response, so the only symptom is a
  // "Failed to fetch" on someone else's screen. Warn once per origin — enough
  // to diagnose a misconfigured deployment, not enough to spam on a scan.
  const rejectedOrigins = new Set<string>();
  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (origin && isAllowedOrigin(origin, allowedOrigins)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader(
        "access-control-allow-headers",
        "authorization,content-type,idempotency-key,x-request-id,x-dev-approval-password",
      );
      res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
      res.setHeader("vary", "Origin");
    } else if (origin && !rejectedOrigins.has(origin)) {
      rejectedOrigins.add(origin);
      logger.warn(
        { origin, allowedOrigins },
        "CORS: rejected browser origin; requests from it will fail in the browser",
      );
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

  // ── Cross-instance idempotency and rate limiting (plane.md §4.1) ─────────
  //
  // Both were per-process, which is the standing Golden Rule #4 hole: two API
  // instances each kept their own copy, so a retry that landed on the other
  // one found nothing stored and re-executed. On a money-mutating endpoint
  // that is a double spend, and a 300/minute limit behind two instances is
  // really 600/minute.
  //
  // Redis closes both when it is configured. When it is not, each falls back
  // to its in-memory implementation and the single-instance constraint stands
  // — announced at boot rather than discovered in production. Failing closed
  // here would mean an operator who has not yet provisioned Redis cannot run
  // the platform at all, which trades a known limitation for an outage.
  const redis = getRedis();
  if (redis) {
    logger.info("idempotency/rate-limit: using Redis — limits are global");
  } else {
    logger.warn(
      "idempotency/rate-limit: using in-memory stores — SINGLE INSTANCE ONLY. " +
        "Set REDIS_URL before running more than one API instance.",
    );
  }
  // One store for every router. A store per router is a store per route group,
  // so a retry is only recognised by the group that first served it.
  const idempotencyStore = createIdempotencyStore(redis);

  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: true,
      legacyHeaders: false,
      ...(redis ? { store: new RedisRateLimitStore(redis) } : {}),
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
    const rwaReconciliationJob = app.locals.rwaReconciliationJob as
      | { lastUnresolved?: () => number }
      | undefined;
    const ledgerUnresolved = reconciliation?.lastUnresolved?.() ?? 0;
    const settlementUnresolved =
      settlementReconciliation?.lastUnresolved?.() ?? 0;
    const rwaUnresolved = rwaReconciliationJob?.lastUnresolved?.() ?? 0;

    const ready =
      (database === true || database === "not_configured") &&
      ledgerUnresolved === 0 &&
      settlementUnresolved === 0 &&
      rwaUnresolved === 0;

    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "degraded",
      checks: {
        database,
        ledgerUnresolvedMismatches: ledgerUnresolved,
        settlementUnresolvedMismatches: settlementUnresolved,
        rwaUnresolvedMismatches: rwaUnresolved,
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
  const audit: AuditRepository = usePersistentStore
    ? new PgAuditRepository(getPool())
    : new InMemoryAuditRepository();
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
  // Persisted whenever a database is configured (plane.md §4.2, migration
  // 0022). KYC gates an investor purchase (§3.2), so an in-memory store meant
  // a deploy silently reset every user to unverified and re-opened every
  // review a compliance officer had already closed.
  const kycRepository: KycRepository = usePersistentStore
    ? new PgKycRepository(getPool())
    : new InMemoryKycRepository();
  const kyc = new KycService(
    createKycProvider(),
    kycRiskClient,
    kycRepository,
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
  // Contracts take Stellar addresses, not internal user ids. The only
  // trustworthy mapping is the wallet each party proved control of during
  // SEP-10, so escrow and RWA both resolve through the identity store.
  const walletAddresses = new IdentityWalletAddressResolver(identities);
  const stellarClient = new StellarClient();

  // One ledger service for the whole app. RWA payouts post through it, so a
  // payout that cannot write balanced entries fails instead of silently
  // completing (Golden Rule #1).
  //
  // Persisted whenever a database is configured. An in-memory system of record
  // makes every balance a function of process uptime, and — because payout
  // idempotency is a lookup by reference id — a restart would turn a completed
  // payout back into an unposted one, leaving the token contract's one-shot
  // `distributed` flag as the only thing standing between a retry and paying
  // twice.
  const ledgerRepository: LedgerRepository = usePersistentStore
    ? new PgLedgerRepository(getPool())
    : new InMemoryLedgerRepository();
  const ledgerService = new LedgerService(ledgerRepository);

  // ── Treasury: how a ledger balance comes to exist (plane.md §4.5) ────────
  //
  // Per-user accounts made "this investor's balance" a real thing; treasury is
  // how one comes to hold anything. A deposit is the platform verifying a
  // payment that already happened on Stellar and crediting exactly what
  // arrived — never a number the user types.
  //
  // Constructed before RWA because nothing here depends on it, and after the
  // ledger because it posts through the same service every other money path
  // does.
  const treasuryRepository: TreasuryRepository = usePersistentStore
    ? new PgTreasuryRepository(getPool())
    : new InMemoryTreasuryRepository();
  const treasury = new TreasuryService(
    treasuryRepository,
    createTreasuryGateway(createSigner()),
    ledgerService,
    walletAddresses,
    audit,
    {
      minDepositMinor: BigInt(config.TREASURY_MIN_DEPOSIT_MINOR),
      withdrawalAutoMaxMinor: BigInt(
        config.TREASURY_WITHDRAWAL_AUTO_MAX_MINOR,
      ),
    },
  );

  const rwaRepository: RwaRepository = usePersistentStore
    ? new PgRwaRepository(getPool())
    : new InMemoryRwaRepository();
  // Under issuer custody the on-chain issuer is the user's own SEP-10 wallet,
  // so the gateway needs the same identity-backed resolver escrow uses.
  const rwaGateway = createRwaGateway(walletAddresses);

  // ── The domain event spine (plane.md §2.3) ───────────────────────────────
  // Constructed before the services that publish to it. Subscribers are
  // registered further down, once the services they call exist — the bus is
  // deliberately the only thing the four domains share.
  const eventRepository: EventRepository = usePersistentStore
    ? new PgEventRepository(getPool())
    : new InMemoryEventRepository();
  const eventBus = new EventBus(eventRepository, metrics);
  app.locals.eventBus = eventBus;

  // RWA must refuse a payout while a dispute is open, but the dispute service
  // is constructed further down and itself depends (via settlement) on
  // payments, which depends on RWA. Rather than reorder four services around
  // one boolean, the reader is bound late: the closure below resolves through
  // this holder, which is filled in once `disputes` exists. It is only ever
  // called during a request, never during wiring.
  const disputeRef: {
    current?: { hasOpenDispute(orderId: string): Promise<boolean> };
  } = {};

  // ── Phase 6: Reputation store (advisory prior for dispute risk) ───────────
  // Constructed here rather than after RWA because RWA now reads it to score
  // an asset's counterparty (plane.md §3.1). It depends only on a repository
  // and the audit log, so it can sit this early without a cycle.
  // Persisted for the same reason KYC is (plane.md §4.2): reputation feeds
  // dispute risk and counterparty scoring at asset verification, so a restart
  // discarded exactly the history those signals are built from — and a seller
  // with fifty clean orders read the same as one with none.
  const reputationRepository: ReputationRepository = usePersistentStore
    ? new PgReputationRepository(getPool())
    : new InMemoryReputationRepository();
  const reputationService = new ReputationService(
    reputationRepository,
    audit,
  );

  const rwa = new RwaService(
    rwaRepository,
    rwaGateway,
    audit,
    ledgerService,
    walletAddresses,
    // Late-bound; see `disputeRef` above.
    {
      hasOpenDispute: (orderId) =>
        disputeRef.current?.hasOpenDispute(orderId) ?? Promise.resolve(false),
    },
    // Investor protection (plane.md §3.2). KYC is read through the service so
    // the RWA path refuses at the money-moving step rather than trusting that
    // onboarding checked; the limits are configuration because the right
    // numbers are a policy decision, not a code one. They approximate
    // regulatory controls and are not legal compliance (plane.md §7).
    kyc,
    {
      maxConcentrationBps: config.RWA_MAX_CONCENTRATION_BPS,
      maxExposure: BigInt(config.RWA_MAX_INVESTOR_EXPOSURE),
      minTicketAmount: BigInt(config.RWA_MIN_TICKET_AMOUNT),
      unitGranularity: BigInt(config.RWA_UNIT_GRANULARITY),
      coolingOffHours: config.RWA_COOLING_OFF_HOURS,
    },
    reputationService,
  );

  // ── Phase 6: Product feedback (public wall) ───────────────────────────────
  // Persisted when a database is configured: the wall is public evidence of
  // real users, and evidence that disappears on restart proves nothing
  // (migration 0013).
  const feedbackRepository: FeedbackRepository = usePersistentStore
    ? new PgFeedbackRepository(getPool())
    : new InMemoryFeedbackRepository();
  const feedback = new FeedbackService(feedbackRepository, audit);

  // Wire RWA + reputation into payment service. RWA payout distributes on
  // release; a completed release also records a positive reputation signal.
  const paymentRepository: PaymentRepository = usePersistentStore
    ? new PgPaymentRepository(getPool())
    : new InMemoryPaymentRepository();
  const escrowGateway = createEscrowGateway(walletAddresses, stellarClient);
  const payments = new PaymentService(
    paymentRepository,
    escrowGateway,
    audit,
    rwa,
    reputationService,
    eventBus,
  );
  const reconciliation = new ReconciliationJob(
    paymentRepository,
    escrowGateway,
    config.RECONCILIATION_INTERVAL_MS,
    alerts,
    metrics,
  );
  app.locals.reconciliationJob = reconciliation;

  // Tokenization mints transferable property and had no reconciliation loop at
  // all: a transfer that succeeded on-chain while the holdings write failed, or
  // a holder moving units directly, went unnoticed until a payout tried to use
  // the stale records.
  const rwaReconciliation = new RwaReconciliationJob(
    rwaRepository,
    rwaGateway,
    config.RECONCILIATION_INTERVAL_MS,
    alerts,
    metrics,
  );
  app.locals.rwaReconciliationJob = rwaReconciliation;

  // Time is what moves a receivable from funded to matured to defaulted. Without
  // this sweep a position whose debtor never paid stayed `funded` forever,
  // indistinguishable from one paying on schedule (plane.md §1.4).
  const rwaLifecycle = new RwaLifecycleJob(
    rwaRepository,
    audit,
    config.RWA_LIFECYCLE_INTERVAL_MS,
    config.RWA_DEFAULT_GRACE_DAYS,
    alerts,
    metrics,
    // Production reads the real clock; only tests pin it.
    undefined,
    // Maturity and default are announced on the spine, not just written to a
    // row (plane.md §2.3).
    eventBus,
  );
  app.locals.rwaLifecycleJob = rwaLifecycle;

  // ── Phase 3: Cross-Border Settlement ─────────────────────────────────────
  // Settlement moves fiat across borders; its records must outlive the process
  // that made them (migration 0011).
  const settlementRepository: SettlementRepository = usePersistentStore
    ? new PgSettlementRepository(getPool())
    : new InMemorySettlementRepository();
  const liquidityGateway = createLiquidityGateway();
  const anchorGateway = createAnchorGateway();
  const settlement = new SettlementService(
    settlementRepository,
    liquidityGateway,
    anchorGateway,
    audit,
    // Settlement reads the order it funds; it never writes one. The deposit
    // itself happens through the subscriber below, on the payments side.
    { findOrder: (orderId: string) => paymentRepository.findOrder(orderId) },
    eventBus,
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
  const disputeRepository: DisputeRepository = usePersistentStore
    ? new PgDisputeRepository(getPool())
    : new InMemoryDisputeRepository();
  const disputeOrders = {
    getOrder: (orderId: string) => paymentRepository.findOrder(orderId),
    getEscrow: (orderId: string) => paymentRepository.findEscrow(orderId),
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
    {
      // Freeze the custody a dispute is about, so the claim binds on-chain and
      // the arbiter can actually settle it later. Best-effort: where the
      // contract wants the party's own signature this cannot run server-side,
      // and the dispute record still stands.
      markDisputed: ({ orderId, actorUserId }) =>
        payments
          .raiseDispute(orderId, { userId: actorUserId, roles: ["user"] })
          .then(() => undefined),
    },
    eventBus,
  );
  // Close the late binding declared above, now that the service exists.
  disputeRef.current = disputes;

  // ── Event subscribers (plane.md §2.1, §2.2, §2.3) ────────────────────────
  //
  // Registered here, at the one place that already knows every service, so no
  // module has to import another to react to it. Everything below replaces a
  // direct cross-module call that either existed (payments → RWA) or would
  // have had to be written (settlement → payments, disputes → RWA).
  eventBus.subscribe(rwaPayoutOnRelease(rwa, rwaRepository, disputes));
  eventBus.subscribe(rwaHoldOnDispute(rwaRepository));
  eventBus.subscribe(rwaResumeOnDisputeResolved(rwaRepository));
  eventBus.subscribe(orderDepositOnSettlement(payments));

  // ── The unified position view (plane.md §2.4) ────────────────────────────
  // Assembles one story from the four domains. Read-only, caller-scoped, and
  // built from the same services the individual consoles use.
  const positions = new PositionsService({
    listOrders: (userId) => payments.list(userId),
    listSettlements: (userId) => settlement.list(userId),
    listDisputes: (userId) => disputes.list(userId),
    portfolio: (userId) => rwa.getInvestorPortfolio(userId),
    tokenizationIdsForOrder: async (orderId) =>
      (await rwaRepository.listTokenizations({ linkedOrderId: orderId })).map(
        (tokenization) => tokenization.id,
      ),
  });

  // ── Module routers ────────────────────────────────────────────────────────
  app.use("/api/auth", createAuthRouter(sep10, identities, bearerVerifier));
  app.use(
    "/api/wallet",
    createWalletBalancesRouter(stellarClient, walletAddresses, bearerVerifier),
  );
  app.use("/api/kyc", createKycRouter(kyc, bearerVerifier, idempotencyStore));
  // Same instance the RWA payouts write through, so `/api/ledger` reads back
  // the transactions those payouts posted rather than a second, empty store.
  app.use("/api/ledger", createLedgerRouter(ledgerService, bearerVerifier, idempotencyStore));
  app.use("/api/treasury", createTreasuryRouter(treasury, bearerVerifier, idempotencyStore));
  app.use("/api/positions", createPositionsRouter(positions, bearerVerifier));
  app.use(
    "/api/payments",
    createPaymentRouter(payments, reconciliation, bearerVerifier, idempotencyStore),
  );
  app.use(
    "/api/settlement",
    createSettlementRouter(
      settlement,
      settlementReconciliation,
      bearerVerifier,
      idempotencyStore,
    ),
  );
  app.use(
    "/api/disputes",
    createDisputeRouter(disputes, bearerVerifier, idempotencyStore),
  );
  app.use("/api/rwa", createRwaRouter(rwa, rwaReconciliation, bearerVerifier, idempotencyStore));
  app.use(
    "/api/reputation",
    createReputationRouter(reputationService, bearerVerifier),
  );
  // Public wall: GET is unauthenticated by design, POST is not.
  app.use("/api/feedback", createFeedbackRouter(feedback, bearerVerifier));

  // ── Error boundary ──────────────────────────────────────────────────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
