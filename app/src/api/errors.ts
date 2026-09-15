/** Error taxonomy for the API transport. Mirrors the web client's shape. */
import type { ApiError } from "@stellartrust/shared";

/** The server answered, and the answer was an error. */
export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiError | undefined,
  ) {
    super(body?.error.message ?? `Request failed with status ${status}`);
    this.name = "ApiClientError";
  }

  /** Machine-readable code from the shared error catalogue, when present. */
  get code(): string | undefined {
    return this.body?.error.code;
  }

  /** The session is gone or was never valid — the caller must sign in again. */
  get isAuthFailure(): boolean {
    return this.status === 401;
  }

  /** Field-level validation detail, for attaching messages to inputs. */
  get details(): { path: string; message: string }[] {
    const details = this.body?.error.details;
    return Array.isArray(details) ? details : [];
  }
}

/**
 * The request never reached the API, or its response was discarded.
 *
 * On a phone this is the common case, not the exceptional one: a tunnel, a
 * lift, a handoff between wifi and cellular. It is distinguished from
 * `ApiClientError` so the UI can offer "retry" rather than blaming the action.
 */
export class ApiUnreachableError extends Error {
  constructor(
    public override readonly cause: unknown,
    baseUrl: string,
  ) {
    super(
      `Could not reach StellarTrust at ${baseUrl}. Check your connection and try again.`,
    );
    this.name = "ApiUnreachableError";
  }
}

/** The request exceeded its deadline and was aborted by the client. */
export class ApiTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`The request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    this.name = "ApiTimeoutError";
  }
}

/** A human-facing message for any error this app can produce. */
export function messageFor(error: unknown): string {
  if (
    error instanceof ApiClientError ||
    error instanceof ApiUnreachableError ||
    error instanceof ApiTimeoutError
  ) {
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}
