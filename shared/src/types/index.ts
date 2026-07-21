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

export interface DisputeDTO {
  id: string;
  escrowId: string;
  status: DisputeStatus;
  aiAdvisory: AiAdvisory | null;
  humanDecision: AiRecommendation | null;
  createdAt: string;
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
