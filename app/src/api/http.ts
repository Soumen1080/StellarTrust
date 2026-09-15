/**
 * HTTP transport for the StellarTrust API.
 *
 * Adds the three things a mobile client needs that a browser client does not:
 *
 *  - **A deadline.** `fetch` on a phone will hang for minutes on a dead
 *    connection. Every request carries an AbortController.
 *  - **Retries, but only where they are safe.** A GET is retried on a network
 *    fault or a 5xx. A mutation is retried only when it carries an
 *    Idempotency-Key, because the server then collapses the duplicate — that
 *    is exactly what the key is for. A mutation without one is never retried.
 *  - **One place that knows a session died.** A 401 notifies the auth layer so
 *    the whole app can drop to the sign-in screen at once, rather than each
 *    screen discovering it separately.
 */
import type { ApiError } from "@stellartrust/shared";
import { appConfig } from "../lib/config";
import { ApiClientError, ApiTimeoutError, ApiUnreachableError } from "./errors";

const DEFAULT_TIMEOUT_MS = 20_000;
/** Chain calls (deploy, purchase, settlement) wait on ledger close. */
export const CHAIN_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 400;

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  accessToken?: string;
  /** Sent as `Idempotency-Key`; also what makes a mutation retry-safe. */
  idempotencyKey?: string;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Escape hatch for the development KYC approval queue header. */
  devApprovalPassword?: string;
}

type SessionExpiredListener = () => void;
const sessionExpiredListeners = new Set<SessionExpiredListener>();

/** Subscribe to 401s. Returns an unsubscribe function. */
export function onSessionExpired(listener: SessionExpiredListener): () => void {
  sessionExpiredListeners.add(listener);
  return () => void sessionExpiredListeners.delete(listener);
}

function notifySessionExpired(): void {
  for (const listener of sessionExpiredListeners) listener();
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry only faults that a later attempt could plausibly survive.
 *
 * 429 is included because the API's limiter is per-window, so backing off is
 * the correct response rather than a failure to surface.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const {
    method = "GET",
    accessToken,
    idempotencyKey,
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    devApprovalPassword,
  } = options;

  const isRead = method === "GET";
  // A mutation is only safe to repeat if the server can recognize the repeat.
  const retryable = isRead || Boolean(idempotencyKey);
  const maxAttempts = retryable ? MAX_ATTEMPTS : 1;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // A caller-supplied signal (screen unmounted) must also cancel the attempt.
    const onExternalAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onExternalAbort);

    try {
      const response = await fetch(`${appConfig.apiBaseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
          ...(devApprovalPassword
            ? { "x-dev-approval-password": devApprovalPassword }
            : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      if (response.ok) {
        // 204 and other empty bodies must not be fed to `json()`.
        if (response.status === 204) return undefined as T;
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }

      if (response.status === 401) notifySessionExpired();

      if (isRetryableStatus(response.status) && attempt < maxAttempts) {
        lastError = new ApiClientError(response.status, undefined);
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }

      const errorBody = (await response.json().catch(() => undefined)) as
        | ApiError
        | undefined;
      throw new ApiClientError(response.status, errorBody);
    } catch (err) {
      if (err instanceof ApiClientError) throw err;

      // Distinguish our own deadline from the caller cancelling the screen.
      if (controller.signal.aborted) {
        if (signal?.aborted) throw err;
        lastError = new ApiTimeoutError(timeoutMs);
      } else {
        lastError = new ApiUnreachableError(err, appConfig.apiBaseUrl);
      }

      if (attempt < maxAttempts) {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  throw lastError ?? new Error("Request failed");
}
