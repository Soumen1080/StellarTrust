/**
 * Signed session cookies, and the guards around signing in.
 *
 * Sessions are stateless and signed rather than stored: this app runs as a
 * single small process and a session table would be one more thing to migrate,
 * back up, and clean out. The trade is that a session cannot be revoked
 * individually — rotating `SESSION_SECRET` invalidates all of them, which is
 * the correct blunt response to a suspected compromise anyway.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";

const COOKIE_NAME = "stellartrust_admin";

interface SessionPayload {
  /** Issued-at, epoch milliseconds. */
  iat: number;
  /** Expires-at, epoch milliseconds. */
  exp: number;
  /** Random per-session id, so two sessions are never byte-identical. */
  sid: string;
}

function sign(value: string): string {
  return createHmac("sha256", config.SESSION_SECRET).update(value).digest("hex");
}

/** Mint a signed cookie value for a fresh session. */
export function createSession(): { cookie: string; expiresAt: Date } {
  const now = Date.now();
  const expiresAt = new Date(now + config.SESSION_TTL_MINUTES * 60_000);
  const payload: SessionPayload = {
    iat: now,
    exp: expiresAt.getTime(),
    sid: randomBytes(16).toString("hex"),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { cookie: `${encoded}.${sign(encoded)}`, expiresAt };
}

/** True when the cookie is well-formed, correctly signed, and unexpired. */
export function verifySession(cookie: string | undefined): boolean {
  if (!cookie) return false;
  const separator = cookie.lastIndexOf(".");
  if (separator <= 0) return false;

  const encoded = cookie.slice(0, separator);
  const signature = cookie.slice(separator + 1);

  const expected = Buffer.from(sign(encoded), "utf8");
  const actual = Buffer.from(signature, "utf8");
  // Length is checked first because `timingSafeEqual` throws on a mismatch,
  // and a thrown error here would be an unauthenticated request crashing the
  // handler rather than being refused.
  if (expected.length !== actual.length) return false;
  if (!timingSafeEqual(expected, actual)) return false;

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as SessionPayload;
    return typeof payload.exp === "number" && payload.exp > Date.now();
  } catch {
    return false;
  }
}

export function sessionCookieHeader(cookie: string, expiresAt: Date): string {
  // HttpOnly: script cannot read it, so an XSS bug cannot exfiltrate a
  // session. SameSite=Strict: a link from another site cannot carry it, which
  // closes CSRF without a separate token. Secure outside development, because
  // a cookie sent over plain HTTP is a cookie on the wire.
  const flags = [
    `${COOKIE_NAME}=${cookie}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (config.NODE_ENV !== "development") flags.push("Secure");
  return flags.join("; ");
}

export function clearCookieHeader(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

/** Read our cookie out of the request without a cookie-parser dependency. */
export function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return undefined;
}

/**
 * Refuse anything without a valid session.
 *
 * An API request gets 401; a page request is redirected to the sign-in form,
 * because showing raw JSON to someone whose session merely expired is a
 * confusing way to say "log in again".
 */
export function requireSession(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (verifySession(readSessionCookie(req))) {
    next();
    return;
  }
  if (req.path.startsWith("/api/")) {
    res.status(401).json({ error: { code: "AUTH", message: "Sign in required" } });
    return;
  }
  res.redirect("/login");
}

// ── Login attempt throttling ────────────────────────────────────────────────
//
// A password with no rate limit is a password that will eventually be guessed.
// Held in memory: this app is one process, and a lockout that does not survive
// a restart is a weaker guarantee than a shared store would give but still
// raises the cost of guessing by orders of magnitude.

interface AttemptRecord {
  failures: number;
  lockedUntil: number;
}

const attempts = new Map<string, AttemptRecord>();

export function isLockedOut(key: string): number {
  const record = attempts.get(key);
  if (!record) return 0;
  const remaining = record.lockedUntil - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

export function recordFailure(key: string): void {
  const record = attempts.get(key) ?? { failures: 0, lockedUntil: 0 };
  record.failures += 1;
  if (record.failures >= config.LOGIN_MAX_ATTEMPTS) {
    record.lockedUntil = Date.now() + config.LOGIN_LOCKOUT_MINUTES * 60_000;
    record.failures = 0;
  }
  attempts.set(key, record);
}

export function clearFailures(key: string): void {
  attempts.delete(key);
}

/** Test-only: reset the throttle between cases. */
export function resetAttempts(): void {
  attempts.clear();
}
