/**
 * Authentication middleware (Rules.md #5: no unauthenticated money/PII/escrow
 * endpoints).
 *
 * Phase 0 is a STUB: it enforces the *presence* of a bearer token so protected
 * routes cannot be called unauthenticated. Real authentication is SEP-10
 * (Phase 1), which will replace `verifyBearer` behind this same interface.
 */
import type { NextFunction, Request, Response } from "express";
import { config } from "../config/index.js";
import { AuthError } from "../lib/errors.js";

export interface AuthContext {
  userId: string;
}

export interface AuthedRequest extends Request {
  auth?: AuthContext;
}

/** Swappable verifier. Phase 1 replaces the stub with SEP-10 verification. */
export type BearerVerifier = (token: string) => Promise<AuthContext | null>;

/** Local dev stub verifier: accepts the configured dev bearer only. */
export const devStubVerifier: BearerVerifier = async (token) => {
  if (token === config.AUTH_DEV_BEARER) {
    return { userId: "dev-user" };
  }
  return null;
};

export function requireAuth(verifier: BearerVerifier = devStubVerifier) {
  return async function authMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    const header = req.header("authorization");
    if (!header?.startsWith("Bearer ")) {
      next(new AuthError("Missing bearer token"));
      return;
    }
    const token = header.slice("Bearer ".length).trim();
    try {
      const ctx = await verifier(token);
      if (!ctx) {
        next(new AuthError("Invalid or expired token"));
        return;
      }
      (req as AuthedRequest).auth = ctx;
      next();
    } catch (err) {
      next(err);
    }
  };
}
