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
  // Additional allowed browser origins (comma-separated). Env-driven; no
  // deployment URLs hardcoded in source. Falls back to FRONTEND_ORIGIN alone.
  FRONTEND_ORIGINS: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().url())),
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

  // ── Development / demo shortcuts (see devlopement.md §6/§7) ──────────────
  // DEMO_MODE unlocks a stable testnet-only signer loaded from the environment
  // so deployed demos work without KMS. Forbidden on the public network.
  DEMO_MODE: z
    .string()
    .default("false")
    .transform((value) => value === "true" || value === "1"),
  // Stellar Ed25519 secret seed used ONLY by the demo signer on testnet.
  // Provide via the host secret manager, never commit it.
  DEMO_SIGNER_SECRET: z
    .string()
    .regex(/^S[A-Z2-7]{55}$/, "Must be a Stellar Ed25519 secret seed")
    .optional(),
  // Temporary KYC auto-approval for smooth development. Ignored in production.
  KYC_AUTO_APPROVE: z
    .string()
    .default("false")
    .transform((value) => value === "true" || value === "1"),
  KYC_AUTO_APPROVE_DELAY_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(600_000)
    .default(10_000),

  AI_SERVICE_URL: z.string().url().default("http://localhost:8000"),

  AUTH_DEV_BEARER: z.string().default("dev-local-token"),
  AUTH_DEMO_WALLET: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, "Must be a Stellar Ed25519 public key")
    .optional(),
  AUTH_DEMO_NAME: z.string().trim().min(1).default("sam"),

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

  // ── Phase 3: Cross-Border Settlement ────────────────────────────────────
  // Sandbox anchor + deterministic liquidity for local/test; live adapters are
  // required (and the sandbox/deterministic ones refused) in staging/production.
  ANCHOR_GATEWAY: z.enum(["sandbox", "live"]).default("sandbox"),
  LIQUIDITY_GATEWAY: z
    .enum(["deterministic", "horizon"])
    .default("deterministic"),
  // How long a settlement quote stays executable before it must be re-quoted.
  SETTLEMENT_QUOTE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(10)
    .max(600)
    .default(120),
  // Default max slippage applied when a quote request omits the constraint.
  SETTLEMENT_DEFAULT_MAX_SLIPPAGE_BPS: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(100),

  AUTO_RESOLVE_MAX_AMOUNT: z.coerce.number().nonnegative().default(50000),
  AUTO_RESOLVE_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.9),

  // ── Phase 4: Disputes + AI (advisory) ────────────────────────────────────
  // Evidence submission window after a dispute is opened (PRD: 24h).
  DISPUTE_EVIDENCE_WINDOW_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(720)
    .default(24),
  // Timeout for the advisory AI dispute call; on timeout we degrade to human
  // review rather than block the dispute (Rules.md §6).
  DISPUTE_AI_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(30_000)
    .default(3000),
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
