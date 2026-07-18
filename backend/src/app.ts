/**
 * Express application factory (modular monolith).
 * Wires middleware and per-module routers. Kept separate from the server
 * bootstrap so tests can import the app without opening a port.
 */
import express, { type Express } from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { pinoHttp } from "pino-http";
import type { IncomingMessage } from "node:http";
import type { HealthResponse } from "@stellartrust/shared";
import { config } from "./config/index.js";
import { logger } from "./lib/logger.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { requestId, type RequestWithId } from "./middleware/requestId.js";
import { createLedgerRouter } from "./modules/ledger/ledger.routes.js";

export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "1mb" }));
  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req: IncomingMessage) =>
        (req as unknown as RequestWithId).requestId,
    }),
  );

  // Baseline rate limiting on all routes; money/auth routes tighten later.
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  // ── Health (the "empty end-to-end request" for CI) ───────────────────────
  app.get("/health", (_req, res) => {
    const body: HealthResponse = {
      status: "ok",
      service: config.serviceName,
      version: config.version,
      time: new Date().toISOString(),
    };
    res.json(body);
  });

  // ── Module routers ────────────────────────────────────────────────────────
  app.use("/api/ledger", createLedgerRouter());

  // ── Error boundary ──────────────────────────────────────────────────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
