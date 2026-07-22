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



// ── Phase 5: RWA Tokenization (opt-in module) ─────────────────────────────────
// Contracts of record for the RWA module. All numeric quantities are strings
// (minor units / integer unit counts) to avoid float drift and remain JSON-safe.

/** A real-world asset available for tokenization. */
export interface AssetDTO {
  id: string;
  ownerUserId: string;
  assetType: import("../constants/index.js").AssetType;
  /** Opaque asset reference (e.g. "invoice:INV-001"). Never raw PII. */
  assetRef: string;
  description: string;
  /** Appraised valuation as a minor-unit integer string. */
  valuationAmount: MinorUnitAmount;
  valuationCurrency: CurrencyCode;
  /** Opaque metadata references (documents, appraisals). Never raw content. */
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** An on-chain RWA token contract representing fractional ownership. */
export interface TokenizationDTO {
  id: string;
  assetId: string;
  issuerUserId: string;
  /** Deployed Soroban contract address (null until deployed). */
  contractId: string | null;
  contractDeployedAt: string | null;
  /** Total fractional units (integer string). */
  totalUnits: string;
  /** Units sold to investors so far (integer string). */
  unitsSold: string;
  /** Price per unit as a minor-unit integer string. */
  pricePerUnitAmount: MinorUnitAmount;
  pricePerUnitCurrency: CurrencyCode;
  /** Compliance: transfers restricted to authorized holders. */
  requireAuthorization: boolean;
  /** Compliance: transfers frozen. */
  frozen: boolean;
  /** Escrow order whose release triggers the payout (null if none). */
  linkedOrderId: string | null;
  status: import("../constants/index.js").TokenizationStatus;
  createdAt: string;
  updatedAt: string;
}

/** An investor's ownership record of tokenized units. */
export interface TokenHoldingDTO {
  id: string;
  tokenizationId: string;
  holderUserId: string;
  /** Stellar address holding the units. */
  holderAddress: string;
  /** Units held (integer string). */
  units: string;
  /** Amount paid at purchase (minor-unit integer string). */
  purchaseAmount: MinorUnitAmount;
  purchaseCurrency: CurrencyCode;
  purchasedAt: string;
  authorized: boolean;
  updatedAt: string;
}

/** A pro-rata payout event triggered by a buyer payment. */
export interface PayoutDistributionDTO {
  id: string;
  tokenizationId: string;
  triggeredByOrderId: string | null;
  triggeredByTransition: string | null;
  /** Total payout amount (minor-unit integer string). */
  totalAmount: MinorUnitAmount;
  totalCurrency: CurrencyCode;
  status: import("../constants/index.js").PayoutStatus;
  ledgerTransactionId: string | null;
  initiatedAt: string;
  completedAt: string | null;
}

/** An individual holder's share within a payout distribution. */
export interface PayoutRecordDTO {
  id: string;
  distributionId: string;
  holderUserId: string;
  unitsHeld: string;
  shareAmount: MinorUnitAmount;
  shareCurrency: CurrencyCode;
  ledgerEntryId: string | null;
  createdAt: string;
}

export interface CreateAssetInput {
  assetType: import("../constants/index.js").AssetType;
  assetRef: string;
  description: string;
  valuationAmount: MinorUnitAmount;
  valuationCurrency: CurrencyCode;
  metadata?: Record<string, unknown>;
}

export interface CreateTokenizationInput {
  assetId: string;
  totalUnits: string;
  pricePerUnitAmount: MinorUnitAmount;
  pricePerUnitCurrency: CurrencyCode;
  requireAuthorization?: boolean;
  linkedOrderId?: string;
}

export interface PurchaseUnitsInput {
  units: string;
  holderAddress: string;
}

export interface TokenizationDetailsResponse {
  tokenization: TokenizationDTO;
  asset: AssetDTO;
  holdings: TokenHoldingDTO[];
  distributions: PayoutDistributionDTO[];
  /** Units still available for purchase (integer string). */
  availableUnits: string;
  /** Total raised from investors (minor-unit integer string). */
  totalRaised: MinorUnitAmount;
}

export interface InvestorPortfolioResponse {
  holdings: Array<{
    holding: TokenHoldingDTO;
    tokenization: TokenizationDTO;
    asset: AssetDTO;
  }>;
  totalInvested: MinorUnitAmount;
  totalPayoutsReceived: MinorUnitAmount;
}

export interface TokenizationListResponse {
  tokenizations: TokenizationDTO[];
}

export interface AssetListResponse {
  assets: AssetDTO[];
}
