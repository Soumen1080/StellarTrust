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
import { ExternalServiceError } from "../../lib/errors.js";
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
    logger.error(
      "auth disabled: configure SUPABASE_JWKS_URL for staging/production",
    );
    return async () => {
      throw new ExternalServiceError("Authentication service is unavailable");
    };
  }

  logger.warn("auth: using DEV STUB bearer verifier — local development only");
  return devStubVerifier;
}
