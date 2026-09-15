/**
 * Typed StellarTrust API client.
 *
 * Every method is typed against `@stellartrust/shared` — the same contracts of
 * record the backend validates with and the web client calls through. The app
 * defines no DTO of its own: if a shape changes, this file fails to compile
 * rather than drifting from the server.
 *
 * Money-mutating calls take an `idempotencyKey` because the API requires one
 * (Rules.md #4), and because it is what lets the transport retry a mutation
 * safely over a flaky mobile connection.
 */
import type {
  AssetDTO,
  AssetListResponse,
  AuthSessionResponse,
  ClaimDepositInput,
  CorridorDTO,
  CreateAssetInput,
  CreateOrderInput,
  CreateTokenizationInput,
  DisputeDTO,
  DisputeDecisionInput,
  DisputeDetailsResponse,
  DisputeEvidenceInput,
  DisputeListResponse,
  DisputeLogResponse,
  FeedbackDTO,
  FeedbackInput,
  FeedbackListResponse,
  FeedbackMutationResponse,
  HealthResponse,
  IdentityProfileResponse,
  InvestorPortfolioResponse,
  KycApplicationInput,
  KycApplicationResponse,
  KycStatusResponse,
  OpenDisputeInput,
  OrderDetailsResponse,
  OrderMutationResponse,
  PaymentCapabilitiesResponse,
  PayoutDistributionDTO,
  PositionsResponse,
  PreparedTransitionResponse,
  PurchaseUnitsInput,
  ReconciliationReportDTO,
  ReputationResponse,
  RwaCapabilitiesResponse,
  SecondaryTransferInput,
  SecondaryTransferResponse,
  Sep10ChallengeResponse,
  SettlementDetailsResponse,
  SettlementExecuteInput,
  SettlementMutationResponse,
  SettlementQuoteDTO,
  SettlementQuoteInput,
  TokenizationDetailsResponse,
  TokenizationListResponse,
  TreasuryBalancesResponse,
  TreasuryDepositAddressResponse,
  TreasuryMovementDTO,
  TreasuryMovementsResponse,
  WalletBalancesResponse,
  WithdrawInput,
} from "@stellartrust/shared";
import { apiRequest, CHAIN_TIMEOUT_MS, type RequestOptions } from "./http";

/**
 * Escrow steps whose signature the contract may require from the acting
 * party's own key rather than the server's. Which of these actually need a
 * wallet is a runtime answer from `paymentCapabilities`, not a fixed list.
 */
export type WalletSignedAction =
  | "lock"
  | "confirm"
  | "dispute"
  | "release"
  | "refund";

const get = <T>(path: string, accessToken: string, opts: RequestOptions = {}) =>
  apiRequest<T>(path, { ...opts, accessToken });

const post = <T>(
  path: string,
  accessToken: string,
  body: unknown,
  idempotencyKey?: string,
  opts: RequestOptions = {},
) =>
  apiRequest<T>(path, {
    ...opts,
    method: "POST",
    accessToken,
    idempotencyKey,
    body: body ?? {},
  });

export const api = {
  // ── Health ────────────────────────────────────────────────────────────────
  health: () => apiRequest<HealthResponse>("/health"),

  // ── SEP-10 wallet authentication ──────────────────────────────────────────
  createSep10Challenge: (account: string) =>
    apiRequest<Sep10ChallengeResponse>("/api/auth/sep10/challenge", {
      method: "POST",
      body: { account },
    }),
  verifySep10Challenge: (challengeId: string, signedTransactionXdr: string) =>
    apiRequest<AuthSessionResponse>("/api/auth/sep10/verify", {
      method: "POST",
      body: { challengeId, signedTransactionXdr },
    }),

  // ── Identity ──────────────────────────────────────────────────────────────
  getIdentity: (accessToken: string) =>
    get<IdentityProfileResponse>("/api/auth/me", accessToken),
  /** Claims the caller's permanent username. 409 if taken or already set. */
  updateProfile: (accessToken: string, username: string) =>
    apiRequest<IdentityProfileResponse>("/api/auth/me", {
      method: "PATCH",
      accessToken,
      body: { username },
    }),
  /** Uploads a profile picture as a base64 data URL. */
  uploadAvatar: (accessToken: string, dataUrl: string) =>
    post<IdentityProfileResponse>("/api/auth/me/avatar", accessToken, {
      dataUrl,
    }),

  // ── Wallet / positions ────────────────────────────────────────────────────
  getWalletBalances: (accessToken: string) =>
    get<WalletBalancesResponse>("/api/wallet/balances", accessToken),
  getPositions: (accessToken: string) =>
    get<PositionsResponse>("/api/positions", accessToken),

  // ── Verification (KYC/KYB) ────────────────────────────────────────────────
  submitKyc: (
    accessToken: string,
    idempotencyKey: string,
    input: KycApplicationInput,
  ) =>
    post<KycApplicationResponse>(
      "/api/kyc/applications",
      accessToken,
      input,
      idempotencyKey,
    ),
  kycStatus: (accessToken: string) =>
    get<KycStatusResponse>("/api/kyc/status", accessToken),

  // ── Escrow payments ───────────────────────────────────────────────────────
  createOrder: (
    accessToken: string,
    idempotencyKey: string,
    input: CreateOrderInput,
  ) =>
    post<OrderMutationResponse>(
      "/api/payments/orders",
      accessToken,
      input,
      idempotencyKey,
    ),
  listOrders: (accessToken: string) =>
    get<{ orders: OrderDetailsResponse[] }>("/api/payments/orders", accessToken),
  getOrder: (accessToken: string, orderId: string) =>
    get<OrderDetailsResponse>(`/api/payments/orders/${orderId}`, accessToken),
  /** Server-signed escrow step. 409 when this deployment needs the party's key. */
  transitionOrder: (
    accessToken: string,
    orderId: string,
    action: string,
    idempotencyKey: string,
  ) =>
    post<OrderMutationResponse>(
      `/api/payments/orders/${orderId}/${action}`,
      accessToken,
      {},
      idempotencyKey,
      { timeoutMs: CHAIN_TIMEOUT_MS },
    ),
  /** How this deployment signs each escrow step. Read once per session. */
  paymentCapabilities: (accessToken: string) =>
    get<PaymentCapabilitiesResponse>("/api/payments/capabilities", accessToken),
  raiseDispute: (
    accessToken: string,
    orderId: string,
    idempotencyKey: string,
  ) =>
    post<OrderDetailsResponse>(
      `/api/payments/orders/${orderId}/dispute`,
      accessToken,
      {},
      idempotencyKey,
      { timeoutMs: CHAIN_TIMEOUT_MS },
    ),
  /** Ask the server to assemble the transaction this wallet must sign. */
  prepareTransition: (
    accessToken: string,
    orderId: string,
    action: WalletSignedAction,
  ) =>
    post<PreparedTransitionResponse>(
      `/api/payments/orders/${orderId}/${action}/prepare`,
      accessToken,
      {},
      undefined,
      { timeoutMs: CHAIN_TIMEOUT_MS },
    ),
  /** Hand the signed envelope back for submission and recording. */
  submitSignedTransition: (
    accessToken: string,
    orderId: string,
    action: WalletSignedAction,
    idempotencyKey: string,
    signedXdr: string,
  ) =>
    post<OrderMutationResponse | OrderDetailsResponse>(
      `/api/payments/orders/${orderId}/${action}/submit`,
      accessToken,
      { signedXdr },
      idempotencyKey,
      { timeoutMs: CHAIN_TIMEOUT_MS },
    ),
  runReconciliation: (accessToken: string, idempotencyKey: string) =>
    post<ReconciliationReportDTO>(
      "/api/payments/reconciliation/run",
      accessToken,
      {},
      idempotencyKey,
    ),

  // ── Cross-border settlement ───────────────────────────────────────────────
  listCorridors: (accessToken: string) =>
    get<{ corridors: CorridorDTO[] }>("/api/settlement/corridors", accessToken),
  quoteSettlement: (accessToken: string, input: SettlementQuoteInput) =>
    post<SettlementQuoteDTO>("/api/settlement/quotes", accessToken, input),
  executeSettlement: (
    accessToken: string,
    idempotencyKey: string,
    input: SettlementExecuteInput,
  ) =>
    post<SettlementMutationResponse>(
      "/api/settlement/orders",
      accessToken,
      input,
      idempotencyKey,
      { timeoutMs: CHAIN_TIMEOUT_MS },
    ),
  listSettlements: (accessToken: string) =>
    get<{ settlements: SettlementDetailsResponse[] }>(
      "/api/settlement/orders",
      accessToken,
    ),
  getSettlement: (accessToken: string, settlementId: string) =>
    get<SettlementDetailsResponse>(
      `/api/settlement/orders/${settlementId}`,
      accessToken,
    ),

  // ── Disputes ──────────────────────────────────────────────────────────────
  openDispute: (
    accessToken: string,
    idempotencyKey: string,
    input: OpenDisputeInput,
  ) => post<DisputeDTO>("/api/disputes", accessToken, input, idempotencyKey),
  listDisputes: (accessToken: string) =>
    get<DisputeListResponse>("/api/disputes", accessToken),
  getDispute: (accessToken: string, disputeId: string) =>
    get<DisputeDetailsResponse>(`/api/disputes/${disputeId}`, accessToken),
  getDisputeLog: (accessToken: string, disputeId: string) =>
    get<DisputeLogResponse>(`/api/disputes/${disputeId}/log`, accessToken),
  submitDisputeEvidence: (
    accessToken: string,
    disputeId: string,
    idempotencyKey: string,
    input: DisputeEvidenceInput,
  ) =>
    post<DisputeDTO>(
      `/api/disputes/${disputeId}/evidence`,
      accessToken,
      input,
      idempotencyKey,
    ),
  resolveDispute: (
    accessToken: string,
    disputeId: string,
    idempotencyKey: string,
    input: DisputeDecisionInput,
  ) =>
    post<DisputeDTO>(
      `/api/disputes/${disputeId}/resolve`,
      accessToken,
      input,
      idempotencyKey,
      { timeoutMs: CHAIN_TIMEOUT_MS },
    ),

  // ── RWA tokenization ──────────────────────────────────────────────────────
  createAsset: (
    accessToken: string,
    idempotencyKey: string,
    input: CreateAssetInput,
  ) => post<AssetDTO>("/api/rwa/assets", accessToken, input, idempotencyKey),
  listAssets: (accessToken: string) =>
    get<AssetListResponse>("/api/rwa/assets", accessToken),
  createTokenization: (
    accessToken: string,
    idempotencyKey: string,
    input: CreateTokenizationInput,
  ) =>
    post<TokenizationDetailsResponse>(
      "/api/rwa/tokenizations",
      accessToken,
      input,
      idempotencyKey,
    ),
  deployTokenization: (
    accessToken: string,
    tokenizationId: string,
    idempotencyKey: string,
  ) =>
    post<TokenizationDetailsResponse>(
      `/api/rwa/tokenizations/${tokenizationId}/deploy`,
      accessToken,
      {},
      idempotencyKey,
      { timeoutMs: CHAIN_TIMEOUT_MS },
    ),
  listTokenizations: (accessToken: string) =>
    get<TokenizationListResponse>("/api/rwa/tokenizations", accessToken),
  getTokenization: (accessToken: string, tokenizationId: string) =>
    get<TokenizationDetailsResponse>(
      `/api/rwa/tokenizations/${tokenizationId}`,
      accessToken,
    ),
  purchaseUnits: (
    accessToken: string,
    tokenizationId: string,
    idempotencyKey: string,
    input: PurchaseUnitsInput,
  ) =>
    post<TokenizationDetailsResponse>(
      `/api/rwa/tokenizations/${tokenizationId}/purchase`,
      accessToken,
      input,
      idempotencyKey,
      { timeoutMs: CHAIN_TIMEOUT_MS },
    ),
  transferUnits: (
    accessToken: string,
    tokenizationId: string,
    idempotencyKey: string,
    input: SecondaryTransferInput,
  ) =>
    post<SecondaryTransferResponse>(
      `/api/rwa/tokenizations/${tokenizationId}/transfer`,
      accessToken,
      input,
      idempotencyKey,
      { timeoutMs: CHAIN_TIMEOUT_MS },
    ),
  freezeTokenization: (
    accessToken: string,
    tokenizationId: string,
    idempotencyKey: string,
    reason: string,
  ) =>
    post<TokenizationDetailsResponse>(
      `/api/rwa/tokenizations/${tokenizationId}/freeze`,
      accessToken,
      { reason },
      idempotencyKey,
    ),
  unfreezeTokenization: (
    accessToken: string,
    tokenizationId: string,
    idempotencyKey: string,
    reason: string,
  ) =>
    post<TokenizationDetailsResponse>(
      `/api/rwa/tokenizations/${tokenizationId}/unfreeze`,
      accessToken,
      { reason },
      idempotencyKey,
    ),
  distributeRwaPayout: (
    accessToken: string,
    tokenizationId: string,
    idempotencyKey: string,
    input: unknown,
  ) =>
    post<PayoutDistributionDTO>(
      `/api/rwa/tokenizations/${tokenizationId}/distribute-payout`,
      accessToken,
      input,
      idempotencyKey,
      { timeoutMs: CHAIN_TIMEOUT_MS },
    ),
  getRwaPortfolio: (accessToken: string) =>
    get<InvestorPortfolioResponse>("/api/rwa/portfolio", accessToken),
  rwaCapabilities: (accessToken: string) =>
    get<RwaCapabilitiesResponse>("/api/rwa/capabilities", accessToken),

  // ── Reputation ────────────────────────────────────────────────────────────
  getMyReputation: (accessToken: string) =>
    get<ReputationResponse>("/api/reputation/me", accessToken),
  getReputation: (accessToken: string, userId: string) =>
    get<ReputationResponse>(`/api/reputation/${userId}`, accessToken),

  // ── Treasury ──────────────────────────────────────────────────────────────
  treasuryDepositAddress: (accessToken: string) =>
    get<TreasuryDepositAddressResponse>(
      "/api/treasury/deposit-address",
      accessToken,
    ),
  treasuryBalances: (accessToken: string) =>
    get<TreasuryBalancesResponse>("/api/treasury/balances", accessToken),
  treasuryMovements: (accessToken: string) =>
    get<TreasuryMovementsResponse>("/api/treasury/movements", accessToken),
  /**
   * Claim a deposit: "this transaction paid you, credit me for it."
   * The body carries a hash, never an amount — the amount comes from the chain.
   */
  claimDeposit: (
    accessToken: string,
    idempotencyKey: string,
    input: ClaimDepositInput,
  ) =>
    post<TreasuryMovementDTO>(
      "/api/treasury/deposits",
      accessToken,
      input,
      idempotencyKey,
      { timeoutMs: CHAIN_TIMEOUT_MS },
    ),
  withdraw: (
    accessToken: string,
    idempotencyKey: string,
    input: WithdrawInput,
  ) =>
    post<TreasuryMovementDTO>(
      "/api/treasury/withdrawals",
      accessToken,
      input,
      idempotencyKey,
      { timeoutMs: CHAIN_TIMEOUT_MS },
    ),

  // ── Feedback ──────────────────────────────────────────────────────────────
  listFeedback: () => apiRequest<FeedbackListResponse>("/api/feedback"),
  getMyFeedback: (accessToken: string) =>
    get<{ feedback: FeedbackDTO | null }>("/api/feedback/me", accessToken),
  submitFeedback: (accessToken: string, input: FeedbackInput) =>
    post<FeedbackMutationResponse>("/api/feedback", accessToken, input),
} as const;
