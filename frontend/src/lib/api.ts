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
  KycStatusResponse,
  CreateOrderInput,
  CorridorDTO,
  DisputeDTO,
  DisputeDecisionInput,
  DisputeEvidenceInput,
  OpenDisputeInput,
  OrderDetailsResponse,
  OrderMutationResponse,
  ReconciliationReportDTO,
  Sep10ChallengeResponse,
  SettlementDetailsResponse,
  SettlementExecuteInput,
  SettlementMutationResponse,
  SettlementQuoteDTO,
  SettlementQuoteInput,
} from "@stellartrust/shared";

const DEFAULT_API_BASE =
  process.env.NODE_ENV === "production"
    ? "https://stellar-trust-backend.vercel.app"
    : "http://localhost:8080";
const API_BASE = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? DEFAULT_API_BASE
).replace(/\/+$/, "");

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
  kycStatus: (accessToken: string) =>
    request<KycStatusResponse>("/api/kyc/status", { accessToken }),
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
  createOrder: (
    accessToken: string,
    idempotencyKey: string,
    input: CreateOrderInput,
  ) =>
    request<OrderMutationResponse>("/api/payments/orders", {
      method: "POST",
      accessToken,
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(input),
    }),
  listOrders: (accessToken: string) =>
    request<{ orders: OrderDetailsResponse[] }>("/api/payments/orders", {
      accessToken,
    }),
  transitionOrder: (
    accessToken: string,
    orderId: string,
    action: "accept" | "deposit" | "lock" | "confirm" | "release" | "refund",
    idempotencyKey: string,
  ) =>
    request<OrderMutationResponse>(
      `/api/payments/orders/${orderId}/${action}`,
      {
        method: "POST",
        accessToken,
        headers: { "idempotency-key": idempotencyKey },
        body: "{}",
      },
    ),
  runReconciliation: (accessToken: string, idempotencyKey: string) =>
    request<ReconciliationReportDTO>("/api/payments/reconciliation/run", {
      method: "POST",
      accessToken,
      headers: { "idempotency-key": idempotencyKey },
      body: "{}",
    }),

  // ── Phase 3: Cross-Border Settlement ────────────────────────────────────
  listCorridors: (accessToken: string) =>
    request<{ corridors: CorridorDTO[] }>("/api/settlement/corridors", {
      accessToken,
    }),
  quoteSettlement: (accessToken: string, input: SettlementQuoteInput) =>
    request<SettlementQuoteDTO>("/api/settlement/quotes", {
      method: "POST",
      accessToken,
      body: JSON.stringify(input),
    }),
  executeSettlement: (
    accessToken: string,
    idempotencyKey: string,
    input: SettlementExecuteInput,
  ) =>
    request<SettlementMutationResponse>("/api/settlement/orders", {
      method: "POST",
      accessToken,
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(input),
    }),
  listSettlements: (accessToken: string) =>
    request<{ settlements: SettlementDetailsResponse[] }>(
      "/api/settlement/orders",
      { accessToken },
    ),
  getSettlement: (accessToken: string, settlementId: string) =>
    request<SettlementDetailsResponse>(
      `/api/settlement/orders/${settlementId}`,
      { accessToken },
    ),

  // ── Phase 4: Disputes + AI (advisory) ───────────────────────────────────
  openDispute: (
    accessToken: string,
    idempotencyKey: string,
    input: OpenDisputeInput,
  ) =>
    request<{ dispute: DisputeDTO }>("/api/disputes", {
      method: "POST",
      accessToken,
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(input),
    }),
  submitDisputeEvidence: (
    accessToken: string,
    disputeId: string,
    idempotencyKey: string,
    input: DisputeEvidenceInput,
  ) =>
    request<{ dispute: DisputeDTO }>(`/api/disputes/${disputeId}/evidence`, {
      method: "POST",
      accessToken,
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(input),
    }),
  resolveDispute: (
    accessToken: string,
    disputeId: string,
    idempotencyKey: string,
    decision?: DisputeDecisionInput,
  ) =>
    request<{ dispute: DisputeDTO }>(`/api/disputes/${disputeId}/resolve`, {
      method: "POST",
      accessToken,
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(decision ?? {}),
    }),
  listDisputes: (accessToken: string) =>
    request<{ disputes: DisputeDTO[] }>("/api/disputes", { accessToken }),
  listDisputeQueue: (accessToken: string) =>
    request<{ disputes: DisputeDTO[] }>("/api/disputes/queue", { accessToken }),
  getDispute: (accessToken: string, disputeId: string) =>
    request<{ dispute: DisputeDTO }>(`/api/disputes/${disputeId}`, {
      accessToken,
    }),
};
