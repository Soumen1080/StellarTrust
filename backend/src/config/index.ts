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

/**
 * Treat a blank environment variable as unset.
 *
 * `FOO=` in a .env file, and an empty value in a hosting dashboard, both mean
 * "not configured" to a human — but arrive as `""`, which fails a format check
 * instead of falling through to `.optional()`. Every optional formatted value
 * goes through this so clearing a variable actually clears it.
 */
function optionalEnv<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (value === "" ? undefined : value),
    schema.optional(),
  );
}

/**
 * Currency → Soroban token contract bindings. Kept here rather than in the
 * shared package because it is deployment configuration, not a wire contract.
 * The currency keys are validated loosely (any code) so adding a currency to
 * `@stellartrust/shared` does not require a config-schema change; resolution
 * failures surface at `resolveToken()` with the currency named.
 */
const tokenContractMapSchema = z.record(
  z.string().min(1),
  z.object({
    contractId: z
      .string()
      .regex(/^C[A-Z2-7]{55}$/, "Must be a Stellar contract address"),
    decimals: z.coerce.number().int().min(0).max(38).default(7),
  }),
);

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "staging", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  FRONTEND_ORIGIN: z.string().url().default("http://localhost:3000"),
  // Additional allowed browser origins (comma-separated). Env-driven; the
  // deployed frontend origin is included by default so production works even
  // before a dashboard override is set. Override via FRONTEND_ORIGINS env.
  FRONTEND_ORIGINS: z
    .string()
    .default("https://stellar-trust-frontend.vercel.app")
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
  // Session-mode pooler URL used only by the Prisma schema engine
  // (migrate/db push/db pull), never by application queries.
  DIRECT_URL: z.string().optional(),
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
  DEMO_SIGNER_SECRET: optionalEnv(
    z.string().regex(/^S[A-Z2-7]{55}$/, "Must be a Stellar Ed25519 secret seed"),
  ),
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

  // ── OpenAI advisory engine (optional KYC profile-review backend) ─────────
  // When KYC_RISK_ENGINE=openai and OPENAI_API_KEY is set, KYC profile risk is
  // scored by OpenAI (advisory only — never moves funds/ledger; a failure
  // degrades to human review). The key is a secret: provide it via the
  // gitignored local .env or a secret manager, never in committed source.
  KYC_RISK_ENGINE: z.enum(["service", "openai"]).default("service"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(15_000),

  AUTH_DEV_BEARER: z.string().default("dev-local-token"),
  AUTH_DEMO_WALLET: optionalEnv(
    z.string().regex(/^G[A-Z2-7]{55}$/, "Must be a Stellar Ed25519 public key"),
  ),
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

  // ── Phase 5: RWA Tokenization ────────────────────────────────────────────
  // Gateway for RWA token contract operations (deterministic for local/test,
  // soroban-rpc for staging/production with KMS-backed signing).
  RWA_GATEWAY: z.enum(["deterministic", "soroban-rpc"]).default("deterministic"),
  // Who holds the tokenized supply on-chain.
  //   platform — the server signer is the on-chain issuer and holds every
  //     unit. Simple, and the only mode where the platform can act alone; the
  //     issuer's units are custodied by us.
  //   issuer   — the issuer's own SEP-10 wallet is the on-chain issuer. They
  //     hold their units and sign every contract operation themselves. The
  //     platform cannot move units, freeze, or set the payout guard on their
  //     behalf, which is the point.
  RWA_CUSTODY: z.enum(["platform", "issuer"]).default("platform"),
  // Hex-encoded WASM hash of the RWA token contract, already uploaded on-chain
  // (via `stellar contract deploy`/`install`). Required when RWA_GATEWAY=
  // soroban-rpc so the gateway can deploy per-tokenization contract instances.
  RWA_WASM_HASH: optionalEnv(
    z.string().regex(/^[0-9a-fA-F]{64}$/, "Must be a 32-byte hex WASM hash"),
  ),
  // Hex-encoded WASM hash of the escrow contract (same rationale as above).
  // Required when ESCROW_GATEWAY=soroban-rpc.
  ESCROW_WASM_HASH: optionalEnv(
    z.string().regex(/^[0-9a-fA-F]{64}$/, "Must be a 32-byte hex WASM hash"),
  ),
  // Soroban token contracts backing each ledger currency, as JSON:
  //   {"USDC":{"contractId":"C…","decimals":7}}
  // `decimals` is optional and defaults to 7 (classic Stellar asset contract).
  // Required for any currency that must reach on-chain escrow.
  STELLAR_TOKEN_CONTRACTS: z
    .string()
    .default("{}")
    .transform((value, ctx) => {
      let raw: unknown;
      try {
        raw = JSON.parse(value);
      } catch {
        ctx.addIssue({ code: "custom", message: "Must be valid JSON" });
        return z.NEVER;
      }
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        ctx.addIssue({
          code: "custom",
          message: "Must be a JSON object keyed by currency code",
        });
        return z.NEVER;
      }
      const parsed = tokenContractMapSchema.safeParse(raw);
      if (!parsed.success) {
        ctx.addIssue({
          code: "custom",
          message: parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        });
        return z.NEVER;
      }
      return parsed.data;
    }),
  // On-chain arbiter for new escrows (release/refund authority). Defaults to
  // the server signer's own address, which is what lets the backend settle
  // disputes without a counterparty signature. Point it at a multi-sig account
  // to take that authority out of a single server key.
  ESCROW_ARBITER_ADDRESS: optionalEnv(
    z.string().regex(/^G[A-Z2-7]{55}$/, "Must be a Stellar account address"),
  ),
  // Seconds a prepared (unsigned) escrow transaction stays submittable. Short
  // by design: the buyer signs it in the browser within one interaction.
  ESCROW_PREPARED_TX_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(3_600)
    .default(300),
})
  // A gateway that cannot deploy is a gateway that fails on the first lock.
  // Catch it at boot rather than mid-payment (Rules.md: never boot the money
  // system half-configured).
  .superRefine((env, ctx) => {
    if (env.ESCROW_GATEWAY === "soroban-rpc" && !env.ESCROW_WASM_HASH) {
      ctx.addIssue({
        code: "custom",
        path: ["ESCROW_WASM_HASH"],
        message: "Required when ESCROW_GATEWAY=soroban-rpc",
      });
    }
    if (env.RWA_GATEWAY === "soroban-rpc" && !env.RWA_WASM_HASH) {
      ctx.addIssue({
        code: "custom",
        path: ["RWA_WASM_HASH"],
        message: "Required when RWA_GATEWAY=soroban-rpc",
      });
    }
    if (
      env.ESCROW_GATEWAY === "soroban-rpc" &&
      Object.keys(env.STELLAR_TOKEN_CONTRACTS).length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["STELLAR_TOKEN_CONTRACTS"],
        message:
          "At least one currency → token contract binding is required when " +
          "ESCROW_GATEWAY=soroban-rpc",
      });
    }
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
