/**
 * Boundary error translation (Rules.md §5).
 * Maps internal errors to the standard API error shape + HTTP status.
 * Never leaks stack traces or internal details to clients.
 */
import type { ApiError } from "@stellartrust/shared";
import { ErrorCode } from "@stellartrust/shared";
import type { NextFunction, Request, Response } from "express";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import type { RequestWithId } from "./requestId.js";

export function notFoundHandler(req: Request, res: Response): void {
  const requestId = (req as RequestWithId).requestId ?? "unknown";
  const body: ApiError = {
    error: {
      code: ErrorCode.NOT_FOUND,
      message: "Route not found",
      requestId,
    },
  };
  res.status(404).json(body);
}

// Express identifies error handlers by their 4-arg arity; `_next` is required
// to keep that signature even though it is unused.
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const requestId = (req as RequestWithId).requestId ?? "unknown";

  if (err instanceof AppError) {
    // Expected, typed error. Log at warn; return safe message.
    logger.warn(
      { err: { code: err.code, message: err.message }, requestId },
      "handled application error",
    );
    const body: ApiError = {
      error: {
        code: err.code,
        message: err.expose ? err.message : "Request could not be processed",
        requestId,
        ...(err.details ? { details: err.details } : {}),
      },
    };
    res.status(err.httpStatus).json(body);
    return;
  }

  // Unexpected error: log full detail server-side, return generic message.
  logger.error({ err, requestId }, "unhandled error");
  const body: ApiError = {
    error: {
      code: ErrorCode.INTERNAL,
      message: "Internal server error",
      requestId,
    },
  };
  res.status(500).json(body);
}
