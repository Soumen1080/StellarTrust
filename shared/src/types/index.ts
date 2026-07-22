/**
 * Cross-portion domain types / API DTOs (contracts of record).
 * These are the shapes exchanged over REST between portions. No runtime logic.
 */
import type {
  AiRecommendation,
  ChainTxStatus,
  CurrencyCode,
  DisputeStatus,
  EntryDirection,
  EscrowState,
  KycDecision,
  KycStatus,
  LedgerAccountType,
  OrderStatus,
  PaymentTransition,
  ReconciliationStatus,
  AnchorKycStatus,
  AnchorProtocol,
  AnchorTransferStatus,
  RouteType,
  SettlementStatus,
  SettlementTransition,
  DisputeDecisionMaker,
  DisputeResolution,
  EvidenceKind,
} from "../constants/index.js";

/** Monetary amount as a fixed-precision minor-unit string to avoid float drift. */
export type MinorUnitAmount = string; // e.g. "10000" = 100.00 for a 2-dp currency

export interface Money {
  /** Integer amount in the currency's minor units, as a string. */
  amount: MinorUnitAmount;
  currency: CurrencyCode;
}

export interface UserProfile {
  id: string;
  email: string;
  displayName?: string;
  kycStatus: KycStatus;
  createdAt: string;
}

export interface BusinessProfile {
  id: string;
  ownerUserId: string;
  legalName: string;
  country: string;
  createdAt: string;
}

export interface WalletRef {
  id: string;
  userId: string;
  stellarPublicKey: string;
  custodyType: "self" | "contract";
}

// ── Ledger contracts ────────────────────────────────────────────────────────

export interface LedgerAccountDTO {
  id: string;
  type: LedgerAccountType;
  currency: CurrencyCode;
  ownerRef: string | null;
  name: string;
}

/** A single leg of a balanced ledger transaction. */
export interface LedgerEntryInput {
  accountId: string;
  direction: EntryDirection;
  /** Positive minor-unit amount for this leg. */
  amount: MinorUnitAmount;
  currency: CurrencyCode;
}

/** A ledger transaction: N legs whose signed sum must be exactly zero per currency. */
export interface LedgerTransactionInput {
  /** Idempotency / correlation reference. */
  referenceId: string;
  description: string;
  entries: LedgerEntryInput[];
}

export interface LedgerEntryDTO extends LedgerEntryInput {
  id: string;
  transactionId: string;
  createdAt: string;
}

export interface LedgerTransactionDTO {
  id: string;
  referenceId: string;
  description: string;
  entries: LedgerEntryDTO[];
  createdAt: string;
}

// ── Orders / Escrow ───────────────────────────────────────────────────────────

export interface OrderDTO {
  id: string;
  buyerId: string;
  sellerId: string;
  amount: Money;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
}

export interface EscrowDTO {
  id: string;
  orderId: string;
  contractId: string | null;
  state: EscrowState;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOrderInput {
  sellerId: string;
  amount: Money;
}

export interface PaymentTransitionDTO {
  id: string;
  orderId: string;
  transition: PaymentTransition;
  actorId: string;
  ledgerTransaction: LedgerTransactionDTO;
  stellarTransaction: StellarTxRecord;
  createdAt: string;
}

export interface OrderMutationResponse {
  order: OrderDTO;
  escrow: EscrowDTO | null;
  transition: PaymentTransitionDTO;
}

export interface OrderDetailsResponse {
  order: OrderDTO;
  escrow: EscrowDTO | null;
  transitions: PaymentTransitionDTO[];
  blockedByReconciliation: boolean;
}

export interface ReconciliationMismatchDTO {
  id: string;
  orderId: string;
  transitionId: string;
  reason: string;
  resolvedAt: string | null;
  createdAt: string;
}

export interface ReconciliationReportDTO {
  status: ReconciliationStatus;
  checked: number;
  matched: number;
  unresolved: number;
  mismatches: ReconciliationMismatchDTO[];
  ranAt: string;
}

// ── Disputes / AI (advisory) ──────────────────────────────────────────────────

export interface AiAdvisory {
  recommendation: AiRecommendation;
  /** 0..1 confidence. */
  confidence: number;
  explanation: string;
  signals: string[];
}

// ── Disputes (Phase 4) ────────────────────────────────────────────────────────

/**
 * A single piece of dispute evidence. `supports` indicates which fund outcome
 * the evidence lends weight to; `weight` is a bounded 0..1 advisory strength.
 * Never store raw PII/documents — `reference` is an opaque storage handle.
 */
export interface DisputeEvidenceInput {
  kind: EvidenceKind;
  supports: DisputeResolution;
  weight: number;
  /** Opaque storage/sandbox reference (e.g. "storage://..."). Not raw content. */
  reference: string;
  description?: string;
}

export interface DisputeEvidenceDTO extends DisputeEvidenceInput {
  id: string;
  submittedBy: string;
  createdAt: string;
}

export interface OpenDisputeInput {
  orderId: string;
  reason: string;
}

/** Human compliance decision on a dispute (mandatory reason, Rules.md #6). */
export interface DisputeDecisionInput {
  decision: DisputeResolution;
  reason: string;
}

export interface DisputeResolutionDTO {
  outcome: DisputeResolution;
  decidedBy: DisputeDecisionMaker;
  /** "auto_policy" or "user:<id>". */
  actor: string;
  reason: string;
  decidedAt: string;
}

export interface DisputeDTO {
  id: string;
  orderId: string;
  escrowId: string | null;
  status: DisputeStatus;
  amount: Money;
  openedBy: string;
  reason: string;
  evidence: DisputeEvidenceDTO[];
  /** Latest advisory snapshot (reproducible from the stored evidence). */
  advisory: AiAdvisory | null;
  /** True only when the advisory + amount satisfied the auto-resolve gate. */
  autoResolvable: boolean;
  resolution: DisputeResolutionDTO | null;
  /** ISO time after which no further evidence is accepted. */
  evidenceWindowClosesAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface DisputeDetailsResponse {
  dispute: DisputeDTO;
}

export interface DisputeListResponse {
  disputes: DisputeDTO[];
}

// ── Stellar reconciliation ────────────────────────────────────────────────────

export interface StellarTxRecord {
  id: string;
  hash: string | null;
  type: string;
  status: ChainTxStatus;
  ledgerTransactionId: string | null;
  createdAt: string;
}

// ── Health / meta ─────────────────────────────────────────────────────────────

export interface HealthResponse {
  status: "ok";
  service: string;
  version: string;
  time: string;
}


// ── Phase 1: Identity & Wallet ────────────────────────────────────────────────

export interface Sep10ChallengeRequest {
  account: string;
  memo?: string;
}

export interface Sep10ChallengeResponse {
  challengeId: string;
  transactionXdr: string;
  networkPassphrase: string;
  expiresAt: string;
}

export interface Sep10VerifyRequest {
  challengeId: string;
  signedTransactionXdr: string;
}

export interface AuthSessionResponse {
  accessToken: string;
  tokenType: "Bearer";
  expiresAt: string;
  user: UserProfile;
  wallet: WalletRef;
}

export interface KycDocumentInput {
  kind: "passport" | "national_id" | "drivers_license";
  issuingCountry: string;
  /** Sandbox-only test value. Never log this field. */
  number: string;
  expiryDate: string;
  frontImageRef: string;
  backImageRef?: string;
}

export interface KycApplicationInput {
  applicantType: import("../constants/index.js").ApplicantType;
  email: string;
  legalName: string;
  country: string;
  dateOfBirth?: string;
  registrationNumber?: string;
  document: KycDocumentInput;
  faceImageRef: string;
  businessName?: string;
}

export interface KycProviderChecks {
  document: import("../constants/index.js").ProviderCheckStatus;
  ocr: import("../constants/index.js").ProviderCheckStatus;
  faceMatch: import("../constants/index.js").ProviderCheckStatus;
  liveness: import("../constants/index.js").ProviderCheckStatus;
  aml: import("../constants/index.js").ProviderCheckStatus;
}

export interface KycRiskAdvisory {
  riskScore: number;
  decision: KycDecision;
  confidence: number;
  explanation: string;
  signals: string[];
}

export interface KycApplicationResponse {
  verificationId: string;
  providerReference: string;
  status: KycStatus;
  checks: KycProviderChecks;
  advisory: KycRiskAdvisory;
  reviewId: string | null;
  submittedAt: string;
  /**
   * When set (development auto-approval only), the verification will
   * automatically transition to `verified` at or after this ISO timestamp.
   * Never set in production. See devlopement.md §6.
   */
  autoApproveAt?: string | null;
}

/** Current KYC status snapshot (used for auto-approval polling). */
export interface KycStatusResponse {
  status: KycStatus;
  verification: KycApplicationResponse | null;
}

export interface KycReviewItem {
  id: string;
  verificationId: string;
  userId: string;
  status: import("../constants/index.js").ReviewStatus;
  advisory: KycRiskAdvisory;
  providerChecks: KycProviderChecks;
  resolvedBy: string | null;
  resolution: import("../constants/index.js").HumanKycDecision | null;
  resolutionReason: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface KycReviewDecisionInput {
  decision: import("../constants/index.js").HumanKycDecision;
  reason: string;
}

export interface IdentityProfileResponse {
  user: UserProfile;
  business: BusinessProfile | null;
  wallets: WalletRef[];
  latestVerification: KycApplicationResponse | null;
}


// ── Phase 3: Cross-Border Settlement ──────────────────────────────────────────

/**
 * A supported settlement corridor: a source→destination currency pair served by
 * a specific anchor, bridged on-chain through a Stellar asset.
 */
export interface CorridorDTO {
  id: string;
  sourceCurrency: CurrencyCode;
  destinationCurrency: CurrencyCode;
  anchorId: string;
  anchorName: string;
  /** Stellar asset used as the on-chain settlement bridge (e.g. "USDC"). */
  bridgeAsset: CurrencyCode;
  anchorProtocol: AnchorProtocol;
  estimatedSeconds: number;
}

/** A single conversion hop within a route (classic Stellar liquidity only). */
export interface RouteHop {
  type: RouteType;
  fromCurrency: CurrencyCode;
  toCurrency: CurrencyCode;
  /** Human-readable indicative price (destination units per 1 source unit). */
  price: string;
}

/**
 * A fully-costed candidate route. `destinationAmount` already reflects fees and
 * the quoted slippage; `effectiveRate` is destination-per-source for display.
 */
export interface SettlementRouteDTO {
  type: RouteType;
  hops: RouteHop[];
  source: Money;
  destinationAmount: Money;
  /** Protocol/liquidity fee retained on the source side. */
  fee: Money;
  effectiveRate: string;
  slippageBps: number;
  estimatedSeconds: number;
}

export interface SettlementQuoteInput {
  sourceCurrency: CurrencyCode;
  destinationCurrency: CurrencyCode;
  /** Source amount in minor units (integer string). */
  sourceAmount: MinorUnitAmount;
  /** Optional constraint: reject routes above this slippage (basis points). */
  maxSlippageBps?: number;
  /** Optional constraint: reject routes whose source-side fee exceeds this. */
  maxFeeAmount?: MinorUnitAmount;
}

export interface SettlementQuoteDTO {
  id: string;
  corridorId: string;
  source: Money;
  /** The best selected route. */
  route: SettlementRouteDTO;
  /** All routes considered, best-first (for transparency/auditability). */
  consideredRoutes: SettlementRouteDTO[];
  maxSlippageBps: number;
  maxFeeAmount: MinorUnitAmount | null;
  expiresAt: string;
  createdAt: string;
}

export interface SettlementExecuteInput {
  quoteId: string;
  /** Destination beneficiary reference (opaque; never raw bank/PII in logs). */
  destinationReference: string;
}

/** Anchor-side transfer record (SEP-6/24/31). No raw PII is stored. */
export interface AnchorTransferDTO {
  id: string;
  kind: "deposit" | "withdrawal";
  protocol: AnchorProtocol;
  status: AnchorTransferStatus;
  amount: MinorUnitAmount;
  currency: CurrencyCode;
  /** Opaque anchor-side reference id. */
  reference: string;
  /** SEP-12 customer id used for this transfer. */
  customerId: string;
  createdAt: string;
}

export interface SettlementTransitionDTO {
  id: string;
  settlementId: string;
  transition: SettlementTransition;
  ledgerTransaction: LedgerTransactionDTO;
  anchorTransfer: AnchorTransferDTO | null;
  stellarTransaction: StellarTxRecord | null;
  createdAt: string;
}

export interface SettlementDTO {
  id: string;
  userId: string;
  quoteId: string;
  corridorId: string;
  status: SettlementStatus;
  source: Money;
  destination: Money;
  route: SettlementRouteDTO;
  destinationReference: string;
  createdAt: string;
  updatedAt: string;
}

export interface SettlementMutationResponse {
  settlement: SettlementDTO;
  transitions: SettlementTransitionDTO[];
}

export interface SettlementDetailsResponse {
  settlement: SettlementDTO;
  transitions: SettlementTransitionDTO[];
  blockedByReconciliation: boolean;
}

export interface SettlementReconciliationMismatchDTO {
  id: string;
  settlementId: string;
  transitionId: string;
  reason: string;
  resolvedAt: string | null;
  createdAt: string;
}

export interface SettlementReconciliationReportDTO {
  status: ReconciliationStatus;
  checked: number;
  matched: number;
  unresolved: number;
  mismatches: SettlementReconciliationMismatchDTO[];
  ranAt: string;
}
