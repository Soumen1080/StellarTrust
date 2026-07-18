/**
 * Shared error taxonomy (contracts of record) — Rules.md §5.
 *
 * This module defines the *codes* and the *wire shape* of errors so every
 * portion (frontend, backend, ai) agrees on them. Runtime Error *classes* live
 * in the backend; shared holds contracts only (no runtime logic).
 */

/** Canonical error codes. Maps to HTTP status at the API boundary. */
export const ErrorCode = {
  VALIDATION: "VALIDATION",
  AUTH: "AUTH",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  EXTERNAL_SERVICE: "EXTERNAL_SERVICE",
  LEDGER: "LEDGER",
  CHAIN: "CHAIN",
  INTERNAL: "INTERNAL",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Default HTTP status for each error code (used by the API edge translator). */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  AUTH: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  RATE_LIMITED: 429,
  EXTERNAL_SERVICE: 502,
  LEDGER: 422,
  CHAIN: 502,
  INTERNAL: 500,
};

/** Standard API error shape (Rules.md §5). Never leak stack traces or internals. */
export interface ApiError {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    /** Optional field-level validation details (safe, non-sensitive). */
    details?: Array<{ path: string; message: string }>;
  };
}
