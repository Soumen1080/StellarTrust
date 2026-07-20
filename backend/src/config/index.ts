/**
 * Typed configuration loaded from the environment (validated with Zod).
 * No secret keys are stored here — only non-secret config and *references*
 * to secrets that are resolved at runtime by the signing boundary / DB client.
 */
import { createRequire } from "node:module";
import { z } from "zod";

// Load .env via CJS require — robust under both Node ESM and Vitest's Vite SSR
// transform (which mishandles the dotenv CJS interop on a bare import).
try {
  const require = createRequire(import.meta.url);
  (require("dotenv") as { config: () => void }).config();
} catch {
  // dotenv is optional at runtime; env may be provided by the platform.
}

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "staging", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  FRONTEND_ORIGIN: z.string().url().default("http://localhost:3000"),
  TEMP_KYC_APPROVAL_PASSWORD: z.string().min(8).optional(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),

  // Supabase project (Auth / Storage / API). Optional in Phase 0.
  // SUPABASE_SECRET_KEY is a server-only secret — never sent to the client.
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
  SUPABASE_SECRET_KEY: z.string().optional(),
  SUPABASE_JWKS_URL: z.string().url().optional(),

  STELLAR_NETWORK: z.enum(["testnet", "public"]).default("testnet"),
  HORIZON_URL: z.string().url().default("https://horizon-testnet.stellar.org"),
  SOROBAN_RPC_URL: z
    .string()
    .url()
    .default("https://soroban-testnet.stellar.org"),

  SIGNER_PROVIDER: z
    .enum(["local-stub", "aws-kms", "gcp-kms"])
    .default("local-stub"),
  SIGNER_KEY_REF: z.string().default("local-stub-key-ref"),

  AI_SERVICE_URL: z.string().url().default("http://localhost:8000"),

  AUTH_DEV_BEARER: z.string().default("dev-local-token"),

  // SEP-10 wallet authentication (Phase 1).
  SEP10_HOME_DOMAIN: z.string().min(1).default("localhost"),
  SEP10_WEB_AUTH_DOMAIN: z
    .string()
    .min(1)
    .default("localhost:8080"),
  SEP10_CHALLENGE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(900)
    .default(300),
  AUTH_SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(86_400)
    .default(3600),

  KYC_PROVIDER: z.enum(["sandbox"]).default("sandbox"),
  KYC_AI_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3000),
  KYC_APPROVE_MAX_RISK: z.coerce.number().min(0).max(1).default(0.35),
  KYC_REJECT_MIN_RISK: z.coerce.number().min(0).max(1).default(0.7),
  KYC_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),

  RECONCILIATION_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(60_000),
  ESCROW_GATEWAY: z.enum(["deterministic", "soroban-rpc"]).default("deterministic"),

  AUTO_RESOLVE_MAX_AMOUNT: z.coerce.number().nonnegative().default(50000),
  AUTO_RESOLVE_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.9),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast on misconfiguration — never boot the money system half-configured.
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const config = Object.freeze({
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === "production",
  isTest: parsed.data.NODE_ENV === "test",
  serviceName: "stellartrust-backend",
  version: process.env.npm_package_version ?? "0.0.0",
});

export type AppConfig = typeof config;
