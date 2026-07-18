/**
 * Structured logging (pino) with PII/secret redaction.
 * Rules.md §3: never log PII, secrets, full card/bank numbers, or raw Stellar
 * secret keys.
 */
import { pino } from "pino";
import { config } from "../config/index.js";

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: config.serviceName },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.password",
      "*.secret",
      "*.secretKey",
      "*.privateKey",
      "*.seed",
      "*.mnemonic",
      "*.token",
      "*.email",
      "*.ssn",
      "*.pan",
      "*.cardNumber",
      "*.bankAccount",
    ],
    censor: "[REDACTED]",
  },
  transport: config.isProduction
    ? undefined
    : { target: "pino/file", options: { destination: 1 } },
});

export type Logger = typeof logger;
