/**
 * Supabase JWT verifier (JWKS-based).
 *
 * Verifies Supabase Auth access tokens using the project's public JWKS endpoint
 * (asymmetric signing — RS256/ES256). No secret is required to verify; the
 * secret key stays server-side for admin operations only.
 *
 * Implements the {@link BearerVerifier} contract so it drops into the existing
 * `requireAuth()` middleware without changing call sites.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AuthContext, BearerVerifier } from "../../middleware/auth.js";
import { logger } from "../../lib/logger.js";

/**
 * Build a verifier that validates tokens against the given JWKS URL.
 * The remote key set is cached and refreshed by `jose` automatically.
 */
export function createSupabaseJwtVerifier(jwksUrl: string): BearerVerifier {
  const jwks = createRemoteJWKSet(new URL(jwksUrl));

  return async function verifySupabaseJwt(
    token: string,
  ): Promise<AuthContext | null> {
    try {
      const { payload } = await jwtVerify(token, jwks);
      const userId = typeof payload.sub === "string" ? payload.sub : undefined;
      if (!userId) return null;
      const appMetadata = payload.app_metadata;
      const metadataRoles =
        appMetadata && typeof appMetadata === "object" && "roles" in appMetadata
          ? (appMetadata as { roles?: unknown }).roles
          : undefined;
      const roles = Array.isArray(metadataRoles)
        ? metadataRoles.filter((role): role is string => typeof role === "string")
        : ["user"];
      return { userId, roles };
    } catch (err) {
      // Invalid/expired token or JWKS fetch failure → unauthenticated.
      logger.debug({ err: (err as Error).message }, "supabase jwt verification failed");
      return null;
    }
  };
}
