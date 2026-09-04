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
  DisputeLogResponse,
  FeedbackDTO,
  FeedbackInput,
  FeedbackListResponse,
  FeedbackMutationResponse,
  OpenDisputeInput,
  OrderDetailsResponse,
  OrderMutationResponse,
  PaymentCapabilitiesResponse,
  PreparedTransitionResponse,
  ReconciliationReportDTO,
  Sep10ChallengeResponse,
  SettlementDetailsResponse,
  SettlementExecuteInput,
  SettlementMutationResponse,
  SettlementQuoteDTO,
  SettlementQuoteInput,
  AssetDTO,
  AssetListResponse,
  CreateAssetInput,
  CreateTokenizationInput,
  InvestorPortfolioResponse,
  PositionsResponse,
  PayoutDistributionDTO,
  PurchaseUnitsInput,
  TokenizationDTO,
  TokenizationDetailsResponse,
  TokenizationListResponse,
  WalletBalancesResponse,
} from "@stellartrust/shared";

const DEFAULT_API_BASE =
  process.env.NODE_ENV === "production"
    ? "https://stellartrust.onrender.com"
    : "http://localhost:8080";
const API_BASE = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? DEFAULT_API_BASE
).replace(/\/+$/, "");

/** Escrow steps the contract may require the acting party's own signature for. */
/**
 * Steps that may need a signature the server cannot produce.
 *
 * `lock`/`confirm`/`dispute` are gated on a counterparty's own key. `release`
 * and `refund` are gated on the arbiter's, which is the server by default but
 * can be an external or multi-sig account — so which of these actually need a
 * wallet is a runtime answer from `paymentCapabilities`, not a fixed list.
 */
export type WalletSignedAction =
  | "lock"
  | "confirm"
  | "dispute"
  | "release"
  | "refund";

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiError | undefined,
  ) {
    super(body?.error.message ?? `Request failed with status ${status}`);
    this.name = "ApiClientError";
  }
}

/**
 * The request never reached the API, or its response was discarded.
 *
 * `fetch` rejects with a bare `TypeError: Failed to fetch` for every such case
 * — server down, DNS failure, offline, or a CORS rule that rejected this
 * origin — and deliberately says no more, because distinguishing them would
 * leak cross-origin information to the page. So the cause has to be read off
 * the browser's Network tab; what the UI can do is stop blaming whichever
 * action happened to be in flight.
 */
export class ApiUnreachableError extends Error {
  constructor(public readonly cause: unknown) {
    super(
      `Could not reach the StellarTrust API at ${API_BASE}. It may be offline, ` +
        "or it may not allow requests from this site.",
    );
    this.name = "ApiUnreachableError";
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
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
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
  } catch (err) {
    // An aborted request is the caller's own doing, not an unreachable API.
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiUnreachableError(err);
  }
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
  /** The connected wallet's real, live Horizon balances (XLM + any bound token). */
  getWalletBalances: (accessToken: string) =>
    request<WalletBalancesResponse>("/api/wallet/balances", { accessToken }),
  /**
   * Every position the caller holds, across all four domains, with the links
   * between them (plane.md §2.4).
   *
   * One call rather than four: the `links` block joins settlements, orders,
   * disputes, and tokenizations, which is a relationship the client cannot
   * compute from the individual list endpoints.
   */
  getPositions: (accessToken: string) =>
    request<PositionsResponse>("/api/positions", { accessToken }),
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
  ): Promise<OrderMutationResponse> =>
    request<OrderMutationResponse>(
      `/api/payments/orders/${orderId}/${action}`,
      {
        method: "POST",
        accessToken,
        headers: { "idempotency-key": idempotencyKey },
        body: "{}",
      },
    ),
  /**
   * How this deployment signs each escrow step. Read once per session so the
   * UI routes an action to the single-call or the wallet-signing path without
   * assuming a gateway.
   */
  paymentCapabilities: (accessToken: string) =>
    request<PaymentCapabilitiesResponse>("/api/payments/capabilities", {
      accessToken,
    }),
  /**
   * Raise a dispute where the server signs as arbiter.
   *
   * Deployments whose gateway wants the party's own signature answer 409 here
   * and take the prepare/sign/submit route instead; `paymentCapabilities`
   * says which. Both routes exist either way, so the client never has to
   * encode the signing model.
   */
  raiseDispute: (
    accessToken: string,
    orderId: string,
    idempotencyKey: string,
  ): Promise<OrderDetailsResponse> =>
    request<OrderDetailsResponse>(`/api/payments/orders/${orderId}/dispute`, {
      method: "POST",
      accessToken,
      headers: { "idempotency-key": idempotencyKey },
      body: "{}",
    }),
  /** Ask the server to assemble the transaction this wallet must sign. */
  prepareTransition: (
    accessToken: string,
    orderId: string,
    action: WalletSignedAction,
  ) =>
    request<PreparedTransitionResponse>(
      `/api/payments/orders/${orderId}/${action}/prepare`,
      { method: "POST", accessToken, body: "{}" },
    ),
  /** Hand the signed envelope back for submission and recording. */
  submitSignedTransition: (
    accessToken: string,
    orderId: string,
    action: WalletSignedAction,
    idempotencyKey: string,
    signedXdr: string,
  ) =>
    request<OrderMutationResponse | OrderDetailsResponse>(
      `/api/payments/orders/${orderId}/${action}/submit`,
      {
        method: "POST",
        accessToken,
        headers: { "idempotency-key": idempotencyKey },
        body: JSON.stringify({ signedXdr }),
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
  /** Disputes the caller is party to; `orderId` narrows it to one order. */
  listDisputes: (accessToken: string, orderId?: string) =>
    request<{ disputes: DisputeDTO[] }>(
      orderId
        ? `/api/disputes?orderId=${encodeURIComponent(orderId)}`
        : "/api/disputes",
      { accessToken },
    ),
  getDisputeLog: (accessToken: string, disputeId: string) =>
    request<DisputeLogResponse>(`/api/disputes/${disputeId}/log`, {
      accessToken,
    }),
  listDisputeQueue: (accessToken: string) =>
    request<{ disputes: DisputeDTO[] }>("/api/disputes/queue", { accessToken }),
  getDispute: (accessToken: string, disputeId: string) =>
    request<{ dispute: DisputeDTO }>(`/api/disputes/${disputeId}`, {
      accessToken,
    }),

  // ── Phase 5: RWA Tokenization (opt-in module) ───────────────────────────
  createAsset: (
    accessToken: string,
    idempotencyKey: string,
    input: CreateAssetInput,
  ) =>
    request<AssetDTO>("/api/rwa/assets", {
      method: "POST",
      accessToken,
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(input),
    }),
  listAssets: (accessToken: string) =>
    request<AssetListResponse>("/api/rwa/assets", { accessToken }),
  createTokenization: (
    accessToken: string,
    idempotencyKey: string,
    input: CreateTokenizationInput,
  ) =>
    request<TokenizationDTO>("/api/rwa/tokenizations", {
      method: "POST",
      accessToken,
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(input),
    }),
  deployTokenization: (
    accessToken: string,
    tokenizationId: string,
    idempotencyKey: string,
  ) =>
    request<TokenizationDTO>(
      `/api/rwa/tokenizations/${tokenizationId}/deploy`,
      {
        method: "POST",
        accessToken,
        headers: { "idempotency-key": idempotencyKey },
        body: "{}",
      },
    ),
  listTokenizations: (
    accessToken: string,
    filters?: { issuerUserId?: string; status?: string },
  ) => {
    const params = new URLSearchParams();
    if (filters?.issuerUserId) params.set("issuerUserId", filters.issuerUserId);
    if (filters?.status) params.set("status", filters.status);
    const query = params.toString();
    return request<TokenizationListResponse>(
      `/api/rwa/tokenizations${query ? `?${query}` : ""}`,
      { accessToken },
    );
  },
  getTokenization: (accessToken: string, tokenizationId: string) =>
    request<TokenizationDetailsResponse>(
      `/api/rwa/tokenizations/${tokenizationId}`,
      { accessToken },
    ),
  purchaseUnits: (
    accessToken: string,
    tokenizationId: string,
    idempotencyKey: string,
    input: PurchaseUnitsInput,
  ) =>
    request<TokenizationDetailsResponse>(
      `/api/rwa/tokenizations/${tokenizationId}/purchase`,
      {
        method: "POST",
        accessToken,
        headers: { "idempotency-key": idempotencyKey },
        body: JSON.stringify(input),
      },
    ),
  freezeTokenization: (
    accessToken: string,
    tokenizationId: string,
    idempotencyKey: string,
  ) =>
    request<TokenizationDTO>(
      `/api/rwa/tokenizations/${tokenizationId}/freeze`,
      {
        method: "POST",
        accessToken,
        headers: { "idempotency-key": idempotencyKey },
        body: "{}",
      },
    ),
  unfreezeTokenization: (
    accessToken: string,
    tokenizationId: string,
    idempotencyKey: string,
  ) =>
    request<TokenizationDTO>(
      `/api/rwa/tokenizations/${tokenizationId}/unfreeze`,
      {
        method: "POST",
        accessToken,
        headers: { "idempotency-key": idempotencyKey },
        body: "{}",
      },
    ),
  getRwaPortfolio: (accessToken: string) =>
    request<InvestorPortfolioResponse>("/api/rwa/portfolio", { accessToken }),
  /** The public feedback wall. No session — anyone may read it. */
  listFeedback: () => request<FeedbackListResponse>("/api/feedback"),
  /** The caller's own entry, or null. Used to hide the form once used. */
  getMyFeedback: (accessToken: string) =>
    request<{ feedback: FeedbackDTO | null }>("/api/feedback/me", {
      accessToken,
    }),
  submitFeedback: (accessToken: string, input: FeedbackInput) =>
    request<FeedbackMutationResponse>("/api/feedback", {
      method: "POST",
      accessToken,
      body: JSON.stringify(input),
    }),
  distributeRwaPayout: (
    accessToken: string,
    tokenizationId: string,
    idempotencyKey: string,
    input: {
      orderId: string;
      transition: string;
      payoutAmount: string;
      payoutCurrency: string;
    },
  ) =>
    request<PayoutDistributionDTO>(
      `/api/rwa/tokenizations/${tokenizationId}/distribute-payout`,
      {
        method: "POST",
        accessToken,
        headers: { "idempotency-key": idempotencyKey },
        body: JSON.stringify(input),
      },
    ),
};
