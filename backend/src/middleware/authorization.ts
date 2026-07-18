/** Role-based authorization after authentication. */
import type { NextFunction, Request, Response } from "express";
import { ForbiddenError } from "../lib/errors.js";
import type { AuthedRequest } from "./auth.js";

export function requireRole(role: string) {
  return function roleMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): void {
    const auth = (req as AuthedRequest).auth;
    if (!auth?.roles.includes(role)) {
      next(new ForbiddenError("This operation requires compliance access"));
      return;
    }
    next();
  };
}
