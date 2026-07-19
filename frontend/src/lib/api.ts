/** Typed API client using @stellartrust/shared contracts of record. */
import type {
  ApiError,
  AuthSessionResponse,
  HealthResponse,
  IdentityProfileResponse,
  KycApplicationInput,
  KycApplicationResponse,
  KycReviewDecisionInput,
  KycReviewItem,
  Sep10ChallengeResponse,
} from "@stellartrust/shared";

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

interface ApiRequestInit extends RequestInit {
  accessToken?: string;
  devApprovalPassword?: string;
}

async function request<T>(
  path: string,
  {
    accessToken,
    devApprovalPassword,
    ...init
  }: ApiRequestInit = {},
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(devApprovalPassword
        ? { "x-dev-approval-password": devApprovalPassword }
        : {}),
      ...init.headers,
    },
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
  createSep10Challenge: (account: string) =>
    request<Sep10ChallengeResponse>("/api/auth/sep10/challenge", {
      method: "POST",
      body: JSON.stringify({ account }),
    }),
  verifySep10Challenge: (
    challengeId: string,
    signedTransactionXdr: string,
  ) =>
    request<AuthSessionResponse>("/api/auth/sep10/verify", {
      method: "POST",
      body: JSON.stringify({ challengeId, signedTransactionXdr }),
    }),
  getIdentity: (accessToken: string) =>
    request<IdentityProfileResponse>("/api/auth/me", { accessToken }),
  submitKyc: (
    accessToken: string,
    idempotencyKey: string,
    input: KycApplicationInput,
  ) =>
    request<KycApplicationResponse>("/api/kyc/applications", {
      method: "POST",
      accessToken,
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(input),
    }),
  listKycReviews: (accessToken: string) =>
    request<{ reviews: KycReviewItem[] }>("/api/kyc/reviews", {
      accessToken,
    }),
  resolveKycReview: (
    accessToken: string,
    reviewId: string,
    idempotencyKey: string,
    input: KycReviewDecisionInput,
  ) =>
    request<KycReviewItem>(`/api/kyc/reviews/${reviewId}/decision`, {
      method: "POST",
      accessToken,
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(input),
    }),
  listDevKycReviews: (password: string) =>
    request<{ reviews: KycReviewItem[] }>("/api/kyc/dev/reviews", {
      devApprovalPassword: password,
    }),
  approveDevKycReview: (
    password: string,
    reviewId: string,
    idempotencyKey: string,
    reason: string,
  ) =>
    request<KycReviewItem>(`/api/kyc/dev/reviews/${reviewId}/approve`, {
      method: "POST",
      devApprovalPassword: password,
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({ reason }),
    }),
};
