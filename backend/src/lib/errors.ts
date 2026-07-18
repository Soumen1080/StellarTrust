/**
 * Runtime error classes implementing the shared error taxonomy (Rules.md §5).
 * The shared package holds the *codes* and *wire shape*; these classes are the
 * runtime carriers used inside the backend.
 */
import { ERROR_HTTP_STATUS, ErrorCode } from "@stellartrust/shared";

export interface ErrorDetail {
  path: string;
  message: string;
}

/** Base application error. Carries a taxonomy code + safe client message. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: ErrorDetail[];
  /** Whether the message is safe to expose to clients (default true). */
  readonly expose: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: ErrorDetail[]; expose?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = ERROR_HTTP_STATUS[code];
    if (options.details) this.details = options.details;
    this.expose = options.expose ?? true;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: ErrorDetail[]) {
    super(ErrorCode.VALIDATION, message, { details });
  }
}

export class AuthError extends AppError {
  constructor(message = "Authentication required") {
    super(ErrorCode.AUTH, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(ErrorCode.FORBIDDEN, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(ErrorCode.NOT_FOUND, message);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict") {
    super(ErrorCode.CONFLICT, message);
  }
}

export class IdempotencyConflictError extends AppError {
  constructor(message = "Idempotency key reused with a different request") {
    super(ErrorCode.IDEMPOTENCY_CONFLICT, message);
  }
}

export class ExternalServiceError extends AppError {
  constructor(message = "Upstream service failed", cause?: unknown) {
    super(ErrorCode.EXTERNAL_SERVICE, message, { cause });
  }
}

/** Raised when a ledger transaction is not balanced (Golden Rule #1). */
export class LedgerError extends AppError {
  constructor(message: string, details?: ErrorDetail[]) {
    super(ErrorCode.LEDGER, message, { details });
  }
}

export class ChainError extends AppError {
  constructor(message = "Stellar chain operation failed", cause?: unknown) {
    super(ErrorCode.CHAIN, message, { cause });
  }
}
