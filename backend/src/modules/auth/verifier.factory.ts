/**
 * Selects the active bearer-token verifier for the environment.
 *
 *  - test               → dev stub (keeps tests hermetic; no network JWKS fetch)
 *  - SUPABASE_JWKS_URL set → Supabase JWT verification (real auth)
 *  - otherwise           → dev stub (local dev without Supabase)
 *
 * The dev stub is refused in staging/production so real deployments cannot fall
 * back to a shared bearer (Rules.md #5).
 */
import { config } from "../../config/index.js";
import { logger } from "../../lib/logger.js";
import { devStubVerifier, type BearerVerifier } from "../../middleware/auth.js";
import { createSupabaseJwtVerifier } from "./jwt.verifier.js";

export function getBearerVerifier(): BearerVerifier {
  if (config.isTest) {
    return devStubVerifier;
  }

  if (config.SUPABASE_JWKS_URL) {
    logger.info("auth: using Supabase JWT verification (JWKS)");
    return createSupabaseJwtVerifier(config.SUPABASE_JWKS_URL);
  }

  if (config.isProduction || config.NODE_ENV === "staging") {
    throw new Error(
      "No real auth verifier configured. Set SUPABASE_JWKS_URL (or wire SEP-10) before staging/production.",
    );
  }

  logger.warn("auth: using DEV STUB bearer verifier — local development only");
  return devStubVerifier;
}
