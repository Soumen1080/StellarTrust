/**
 * Typed API client for the StellarTrust backend.
 * Uses shared contracts (@stellartrust/shared) so the frontend and backend agree
 * on request/response shapes.
 */
import type { ApiError, HealthResponse } from "@stellartrust/shared";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiError | undefined,
  ) {
    super(body?.error.message ?? `Request failed with status ${status}`);
    this.name = "ApiClientError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as
      | ApiError
      | undefined;
    throw new ApiClientError(res.status, body);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => request<HealthResponse>("/health"),
};
