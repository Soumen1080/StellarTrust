/**
 * Browser-origin matching for the API's CORS boundary.
 *
 * Kept separate from `app.ts` so the rule is directly testable: a mismatch here
 * is invisible on the server (the request is served normally, the browser just
 * discards the response) and reaches the user only as `TypeError: Failed to
 * fetch`, which names neither CORS nor the origin that was rejected.
 */

/** A `*` in a configured origin stands for exactly one host label. */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `[^.]*` keeps a wildcard inside one label, so `https://acme-*.vercel.app`
  // matches a preview subdomain but never `https://evil.acme-x.vercel.app`.
  return new RegExp(`^${escaped.replace(/\\\*/g, "[^.]*")}$`);
}

/**
 * Whether `origin` — the raw `Origin` header — is allowed by `allowed`.
 *
 * Entries are already normalized to scheme + host + port by the config layer,
 * so this is an exact comparison except where an entry contains a wildcard.
 */
export function isAllowedOrigin(
  origin: string,
  allowed: readonly string[],
): boolean {
  return allowed.some((entry) =>
    entry.includes("*")
      ? patternToRegExp(entry).test(origin)
      : entry === origin,
  );
}
