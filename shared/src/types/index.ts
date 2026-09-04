/**
 * Cross-portion domain types / API DTOs (contracts of record).
 * These are the shapes exchanged over REST between portions. No runtime logic.
 */
import type {
  AiRecommendation,
  ChainSigningMode,
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
  DisputeLogActor,
  DisputeResolution,
  DisputeSettlementStatus,
  EvidenceKind,
} from "../constants/index.js";
import type {
  PayoutCountry,
  PayoutDestinationInput,
  PayoutRail,
  PayoutRailSpec,
} from "../payouts/index.js";

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

// ── Wallet-signed escrow transitions ─────────────────────────────────────────

/**
 * How each transition reaches the chain in the current deployment. Clients read
 * this instead of hard-coding a signing model, so switching
 * `ESCROW_GATEWAY=deterministic` → `soroban-rpc` needs no frontend change.
 */
export interface PaymentCapabilitiesResponse {
  gateway: "deterministic" | "soroban-rpc";
  network: "testnet" | "public";
  networkPassphrase: string;
  /** Signing mode keyed by transition; absent keys mean the mode is `none`. */
  signingModes: Record<string, ChainSigningMode>;
  /** Transitions requiring a wallet round trip, for quick client checks. */
  walletSignedTransitions: PaymentTransition[];
  /**
   * Currencies this deployment can actually escrow on-chain (i.e. have a
   * configured Soroban token contract binding). A client reads this instead
   * of hard-coding a currency list, so a newly bound currency (e.g. XLM)
   * appears in the order-creation UI without a frontend redeploy.
   */
  supportedCurrencies: CurrencyCode[];
}

/** One asset balance held by a Stellar account, as read from Horizon. */
export interface WalletBalanceEntry {
  currency: CurrencyCode;
  /** Horizon's own decimal string, e.g. "128.5000000". Human-readable. */
  balance: string;
  /** The same balance as an integer string at the chain's own scale (stroops for XLM, 7dp for a classic SAC). */
  rawUnits: string;
}

/** A connected wallet's live testnet/mainnet balances, read from Horizon. */
export interface WalletBalancesResponse {
  address: string;
  network: "testnet" | "public";
  balances: WalletBalanceEntry[];
}

/**
 * An unsigned Stellar transaction the acting party's wallet must sign. The
 * server never sees the party's key; it only assembles and later submits.
 */
export interface PreparedTransitionResponse {
  orderId: string;
  transition: PaymentTransition;
  /** Base64 transaction envelope, already simulated and fee-bumped. */
  unsignedXdr: string;
  networkPassphrase: string;
  /** The address the wallet must sign as (the transaction source account). */
  signerAddress: string;
  /** Escrow contract instance this transaction targets. */
  contractId: string;
  /** Transaction time bound; the client must submit before this. */
  expiresAt: string;
}

export interface SubmitSignedTransitionInput {
  signedXdr: string;
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

/**
 * Whether the funds a resolution ordered actually moved.
 *
 * Kept beside the decision rather than only in the audit log, because both
 * parties read the dispute record — and a decision whose transfer failed must
 * not present itself to them as money delivered.
 */
export interface DisputeSettlementOutcomeDTO {
  status: DisputeSettlementStatus;
  /** Failure message or the reason no transfer was owed. */
  detail: string | null;
  updatedAt: string;
}

export interface DisputeResolutionDTO {
  outcome: DisputeResolution;
  decidedBy: DisputeDecisionMaker;
  /** "auto_policy" or "user:<id>". */
  actor: string;
  reason: string;
  decidedAt: string;
  /** Execution state of the fund movement this decision ordered. */
  settlement: DisputeSettlementOutcomeDTO;
}

/**
 * One line of a dispute's append-only history, projected from the audit log.
 *
 * The audit log is already the record of what happened (Rules.md #6); this is
 * that record rendered for the people involved — role-labelled, with ids
 * reduced to roles so a counterparty reads "Seller submitted evidence" rather
 * than a UUID they cannot resolve.
 */
export interface DisputeLogEntryDTO {
  id: string;
  /** Raw audit action, e.g. "dispute.evidence_submitted". */
  action: string;
  actor: DisputeLogActor;
  /** Human-readable one-liner for the timeline. */
  summary: string;
  /** Non-sensitive detail already present in the audit metadata. */
  metadata: Record<string, unknown>;
  at: string;
}

export interface DisputeLogResponse {
  disputeId: string;
  entries: DisputeLogEntryDTO[];
}

export interface DisputeDTO {
  id: string;
  orderId: string;
  escrowId: string | null;
  /**
   * The Soroban custody instance this dispute is about, captured when the
   * dispute is opened.
   *
   * A dispute record with no link to custody is an argument about money whose
   * location nobody recorded: resolution moves funds out of a specific
   * contract, and the audit trail should say which one at the moment the claim
   * was made, not infer it later from whatever the order points at then. Null
   * when the order has no escrow yet.
   */
  contractId: string | null;
  status: DisputeStatus;
  amount: Money;
  openedBy: string;
  /**
   * Both sides of the order, captured when the dispute is opened.
   *
   * A dispute is between two people, so both must be able to find it: without
   * the parties on the record the counterparty cannot list the claim against
   * them, and therefore cannot answer it inside the evidence window.
   */
  buyerId: string;
  sellerId: string;
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
  /** Country (or SEPA region) the beneficiary is paid in. */
  destinationCountry: PayoutCountry;
  /**
   * Local delivery rails available on the destination side, fastest first.
   * Carries each scheme's limits, fee, and required beneficiary fields so the
   * client can render and pre-validate the payout form without a second call.
   */
  payoutRails: PayoutRailSpec[];
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
  /**
   * Local delivery rail for the destination leg. Defaults to the fastest rail
   * serving the destination currency. The rail decides the payout fee, the
   * credit time, and the per-transaction limits the quote is checked against,
   * so it is priced INTO the quote rather than chosen afterwards.
   */
  payoutRail?: PayoutRail;
  /** Optional constraint: reject routes above this slippage (basis points). */
  maxSlippageBps?: number;
  /** Optional constraint: reject routes whose source-side fee exceeds this. */
  maxFeeAmount?: MinorUnitAmount;
}

export interface SettlementQuoteDTO {
  id: string;
  /** Owner of the quote; only this user may execute it. */
  userId: string;
  corridorId: string;
  source: Money;
  /** The best selected route. */
  route: SettlementRouteDTO;
  /** All routes considered, best-first (for transparency/auditability). */
  consideredRoutes: SettlementRouteDTO[];
  maxSlippageBps: number;
  maxFeeAmount: MinorUnitAmount | null;
  /** Local rail this quote is priced for. */
  payoutRail: PayoutRail;
  /** Flat rail fee deducted from the converted amount (destination currency). */
  payoutFee: Money;
  /** What the beneficiary actually receives: converted amount minus rail fee. */
  netDestinationAmount: Money;
  /** Conversion + local clearing time for the chosen rail. */
  totalEstimatedSeconds: number;
  expiresAt: string;
  createdAt: string;
}

export interface SettlementExecuteInput {
  quoteId: string;
  /**
   * Escrow order this settlement funds (plane.md §2.1). When set, the
   * settlement's completion drives the order's deposit rather than the buyer
   * paying the corridor and then the escrow separately.
   */
  orderId?: string;
  /**
   * Beneficiary handle for the quoted rail (UPI ID, IFSC account, IBAN, ABA
   * account, NUBAN). Validated against the scheme's own checksums; only a
   * masked form and a fingerprint are persisted.
   */
  destination: PayoutDestinationInput;
}

/**
 * Persisted beneficiary record. Deliberately non-reversible: the raw handle is
 * used for the anchor payout call and dropped (Rules.md §7 — no raw PII at
 * rest). The fingerprint gives duplicate detection and support lookups without
 * ever storing an account number.
 */
export interface PayoutDestinationDTO {
  rail: PayoutRail;
  country: PayoutCountry;
  currency: CurrencyCode;
  /** Masked handle, e.g. "••••4321 · HDFC0001234". */
  masked: string;
  /** Beneficiary initials only, e.g. "S. M.". */
  holderMasked: string;
  /** SHA-256 (hex) of the normalized handle. */
  fingerprint: string;
  /** Remittance memo shown on the beneficiary's statement, if provided. */
  reference: string | null;
}

/** The destination-leg delivery plan attached to a settlement. */
export interface SettlementPayoutDTO {
  rail: PayoutRail;
  /** Clearing scheme that moves the local money (e.g. "NPCI UPI"). */
  network: string;
  destination: PayoutDestinationDTO;
  /** Flat rail fee deducted from the converted amount. */
  fee: Money;
  /** Amount actually credited to the beneficiary. */
  netAmount: Money;
  /** Local clearing time for this rail, once the anchor releases funds. */
  estimatedSeconds: number;
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
  /** Local scheme the anchor delivered on (withdrawals only). */
  payoutRail: PayoutRail | null;
  /**
   * Fingerprint of the beneficiary handle the anchor was instructed to pay.
   * Reconciliation compares it to the settlement's own record, so a payout
   * sent to a different account is caught without either side storing one.
   */
  destinationFingerprint: string | null;
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
  /** Converted amount before the local rail fee. */
  destination: Money;
  route: SettlementRouteDTO;
  /** Local delivery leg: rail, masked beneficiary, fee, net credited amount. */
  payout: SettlementPayoutDTO;
  /** Remittance memo (falls back to the masked handle). Never a raw account. */
  destinationReference: string;
  /**
   * Escrow order this settlement funds, if any (plane.md §2.1). At most one
   * settlement may fund a given order, enforced by a partial unique index.
   */
  orderId: string | null;
  /** Set when the settlement reaches a terminal state. */
  completedAt: string | null;
  /** Why the settlement failed, when it did. */
  failureReason: string | null;
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

  // ── Verification (plane.md §3.1) ────────────────────────────────────────
  // A valuation is an assertion until someone has looked at the evidence
  // behind it. These carry that review; only a `Verified` asset may be
  // tokenized.
  verificationStatus: import("../constants/index.js").AssetVerificationStatus;
  /**
   * Supporting evidence: opaque references only (a storage key, a document
   * hash), never the document itself and never its contents. At least one is
   * required to submit an asset for review.
   */
  documents: AssetDocumentDTO[];
  /**
   * The party who owes on this asset — an invoice debtor, a warehouse
   * operator. Recorded because the credit risk an investor takes is the
   * counterparty's, not the issuer's.
   */
  counterparty: AssetCounterpartyDTO | null;
  /** Who decided, and why. Null until the asset leaves `UnderReview`. */
  verifiedByUserId: string | null;
  verifiedAt: string | null;
  /** Reviewer's stated reason. Present on a rejection, optional otherwise. */
  verificationNote: string | null;

  createdAt: string;
  updatedAt: string;
}

/**
 * A reference to supporting evidence for an asset.
 *
 * Deliberately a *reference*: the platform records that a document exists,
 * its kind, and a digest that proves the reviewed file is the stored one. The
 * file itself lives in object storage, and its contents never enter the
 * database or a log (Rules.md §3).
 */
export interface AssetDocumentDTO {
  /** Opaque storage reference, e.g. "s3://assets/inv-001.pdf". */
  docRef: string;
  /** What kind of evidence this is, e.g. "invoice", "bill_of_lading". */
  docType: string;
  /** Hex SHA-256 of the file, so a swapped document is detectable. */
  sha256: string | null;
  uploadedAt: string;
}

/**
 * The debtor on a tokenized receivable.
 *
 * `ref` is an opaque business identifier, never PII: the platform needs to
 * recognise that two invoices name the same debtor without storing who they
 * are.
 */
export interface AssetCounterpartyDTO {
  /** Opaque counterparty reference, e.g. "counterparty:ACME-LTD". */
  ref: string;
  /** Trading name, for display. */
  name: string;
  /**
   * Advisory credit score in [0, 100], or null when the counterparty has no
   * history. Surfaced to investors; never a gate on its own.
   */
  reputationScore: number | null;
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

  // ── Financing terms (discount / factoring model) ────────────────────────
  // Investors buy the claim below face value and are repaid at face value on
  // collection; their yield is the discount. The recurring-coupon alternative
  // is deliberately not modelled — see plane.md §8.1 before adding one.
  /** What the debtor owes at maturity (minor-unit integer string). */
  faceValueAmount: MinorUnitAmount;
  faceValueCurrency: CurrencyCode;
  /**
   * Share of face value financed, in basis points (8000 = 80%). The unfinanced
   * remainder is the seller's retained first-loss.
   */
  advanceRateBps: number;
  /** Investor yield on the principal, in basis points. */
  discountRateBps: number;
  /** Platform take, in basis points of face value, paid after investors. */
  platformFeeBps: number;
  /** When collection is due (ISO-8601). */
  maturityDate: string;
  /** When collection actually happened, so late yield accrues to a real date. */
  collectedAt: string | null;

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
  /**
   * Whether the contract has actually moved these units yet.
   *
   * Under platform custody a purchase settles inline and this is always
   * `settled`. Under issuer custody the platform holds no key for the issuer's
   * account, so the row is written first and the issuer signs the transfer
   * afterwards — until then the units are reserved but not delivered, and the
   * holding earns no payout and matches no on-chain balance.
   */
  status: import("../constants/index.js").TokenHoldingStatus;
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
  /** Optional at creation; at least one is required to submit for review. */
  documents?: AssetDocumentInput[];
  counterparty?: AssetCounterpartyInput;
}

export interface AssetDocumentInput {
  docRef: string;
  docType: string;
  /** Hex SHA-256 of the file, if the uploader computed one. */
  sha256?: string;
}

export interface AssetCounterpartyInput {
  ref: string;
  name: string;
}

/** Compliance decision on an asset under review (plane.md §3.1). */
export interface ReviewAssetInput {
  decision: "verify" | "reject";
  /** Required on a rejection: the issuer is entitled to know why. */
  note?: string;
}

export interface CreateTokenizationInput {
  assetId: string;
  totalUnits: string;
  /**
   * Financing terms. The unit price is *derived* from these
   * (faceValue x advanceRate / totalUnits) rather than supplied: a price
   * inconsistent with the terms is the easiest way to make the payout
   * waterfall unpayable, so the server computes it.
   */
  faceValueAmount: MinorUnitAmount;
  faceValueCurrency: CurrencyCode;
  advanceRateBps: number;
  discountRateBps: number;
  /** Optional; defaults to the platform's configured rate. */
  platformFeeBps?: number;
  maturityDate: string;
  requireAuthorization?: boolean;
  linkedOrderId?: string;
}

export interface PurchaseUnitsInput {
  units: string;
  holderAddress: string;
}

/**
 * A holder-to-holder sale of units at an agreed price (plane.md §3.3).
 *
 * The price is *agreed between the two parties*, not derived from the
 * financing terms the way a primary subscription's is. That is the whole
 * difference between the two markets: a primary unit price is fixed by the
 * deal, while a secondary price is whatever a buyer will pay for a claim whose
 * risk has since changed — an invoice nearing maturity is worth more than one
 * just issued, and a disputed one less.
 *
 * `toUserId` rather than an address: the buyer must be a platform user with
 * their own KYC and limits, and a raw address would let units reach someone
 * the platform has never checked.
 */
export interface SecondaryTransferInput {
  /** Who receives the units. Must be an existing platform user. */
  toUserId: string;
  /** The buyer's Stellar address, where the units land. */
  toHolderAddress: string;
  /** Units to sell (integer string). */
  units: string;
  /**
   * Total agreed consideration in minor units — the whole trade, not a
   * per-unit price. A per-unit price times a unit count is a rounding bug
   * waiting for a non-dividing quantity.
   */
  priceAmount: MinorUnitAmount;
}

/** The result of a secondary transfer: both sides of the trade. */
export interface SecondaryTransferResponse {
  tokenizationId: string;
  /** The seller's holding after the sale, or null when fully sold out. */
  sellerHolding: TokenHoldingDTO | null;
  /** The buyer's holding, created or increased. */
  buyerHolding: TokenHoldingDTO;
  units: string;
  priceAmount: MinorUnitAmount;
  priceCurrency: CurrencyCode;
  /** The ledger transaction recording both legs. */
  ledgerTransactionId: string;
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
  /** What an investor is actually taking on (plane.md §3.4). */
  risk: TokenizationRiskDTO;
}

/**
 * The risk an investor carries, computed server-side (plane.md §3.4).
 *
 * Every field here was previously derivable only by a client that knew the
 * financing model — which meant in practice that none of them were shown, and
 * the card advertised a price with no yield, no maturity, and no hint that the
 * underlying invoice was in dispute. Computing it here means one definition of
 * "days remaining" rather than one per screen.
 */
export interface TokenizationRiskDTO {
  /** Share of face value financed, in bps. The rest is the seller's stake. */
  advanceRateBps: number;
  /** Investor yield on principal, in bps. */
  discountRateBps: number;
  /** ISO-8601 maturity. */
  maturityDate: string;
  /**
   * Whole days until maturity. Negative once past due — the sign is the
   * signal, so it is not clamped at zero.
   */
  daysRemaining: number;
  /** True once past maturity with no collection recorded. */
  overdue: boolean;
  /**
   * The issuer's advisory reputation score in [0, 100], or null when unscored.
   * Advisory: it is shown, never used to gate.
   */
  issuerReputationScore: number | null;
  /** The debtor on the underlying asset, if recorded. */
  counterparty: AssetCounterpartyDTO | null;
  /**
   * Whether the linked escrow order has an open dispute. A disputed invoice
   * may be refunded to the buyer, in which case there is nothing to pay out —
   * which is exactly what an investor deciding whether to buy needs to know.
   */
  disputed: boolean;
  /**
   * Total yield an investor would earn across the whole issue if collection
   * arrived today, in minor units. Scales pro-rata with units held.
   */
  projectedYieldAmount: MinorUnitAmount;
}

/**
 * One authenticated call returning everything the caller has a position in,
 * with the links between them (plane.md §2.4).
 *
 * The four domains each had their own console, so a user financing an invoice
 * through a corridor and disputing the delivery saw three unrelated screens and
 * had to work out for themselves that they described one trade. The `links`
 * block is the part that could not be assembled client-side: it is the join
 * across settlements, orders, disputes, and tokenizations.
 */
export interface PositionsResponse {
  orders: OrderDetailsResponse[];
  settlements: SettlementDetailsResponse[];
  disputes: DisputeDTO[];
  holdings: InvestorPortfolioResponse["holdings"];
  /** How the records above relate, keyed by order id. */
  links: PositionLink[];
}

/** The cross-domain story of one escrow order. */
export interface PositionLink {
  orderId: string;
  /** Settlement that funded this order, if any (§2.1). */
  fundedBySettlementId: string | null;
  /** Disputes raised against it. */
  disputeIds: string[];
  /** Tokenizations whose payout this order's release triggers (§2.2). */
  tokenizationIds: string[];
}

export interface InvestorPortfolioResponse {
  holdings: Array<{
    holding: TokenHoldingDTO;
    tokenization: TokenizationDTO;
    asset: AssetDTO;
    /** Per-position economics and risk (plane.md §3.4). */
    position: PortfolioPositionDTO;
  }>;
  totalInvested: MinorUnitAmount;
  totalPayoutsReceived: MinorUnitAmount;
  /**
   * Yield accrued but not yet paid, across open positions. An estimate of what
   * the position is currently worth over cost — not a settled amount.
   */
  totalAccruedYield: MinorUnitAmount;
  /**
   * Capital lost on written-off positions: what was invested less what
   * recovery actually returned. "Total invested" alone reads like a balance
   * and hides this entirely.
   */
  totalRealizedLoss: MinorUnitAmount;
  /** How many open positions are past maturity with no collection. */
  overdueCount: number;
}

/** One position's economics, computed server-side (plane.md §3.4). */
export interface PortfolioPositionDTO {
  /**
   * This holder's share of the yield, accrued to today and pro-rata to units
   * held. Zero once the position has paid out — at that point the payout
   * record is the truth, not a projection.
   */
  accruedYield: MinorUnitAmount;
  /** Payouts actually received against this position. */
  payoutsReceived: MinorUnitAmount;
  /**
   * Capital lost, for a written-off position: invested less payouts received.
   * Zero while the position is open — an unrealized loss is not a loss.
   */
  realizedLoss: MinorUnitAmount;
  /** Whole days to maturity; negative once past due. */
  daysRemaining: number;
  /** Past maturity with no collection recorded. */
  overdue: boolean;
  /** The linked escrow order is disputed, so a payout is held. */
  disputed: boolean;
}

/**
 * How this deployment signs each RWA contract operation.
 *
 * Mirrors `PaymentCapabilitiesResponse`: a client asks rather than hard-coding
 * a signing model that changes with `RWA_CUSTODY`.
 */
export interface RwaCapabilitiesResponse {
  custody: import("../constants/index.js").RwaCustodyMode;
  network: string;
  networkPassphrase: string;
  signingModes: Record<string, ChainSigningMode>;
  walletSignedTransitions: import("../constants/index.js").RwaTransition[];
}

/** An unsigned RWA contract transaction handed to the issuer's wallet. */
export interface PreparedRwaOperationResponse {
  tokenizationId: string;
  transition: import("../constants/index.js").RwaTransition;
  /** Base64 transaction envelope, already simulated. */
  unsignedXdr: string;
  networkPassphrase: string;
  /** The address the wallet must sign as (the transaction source account). */
  signerAddress: string;
  /** Token contract this transaction targets. */
  contractId: string;
  /**
   * The holding this operation delivers, for a `transfer`. Null otherwise —
   * the other operations act on the tokenization as a whole.
   */
  holdingId: string | null;
  /** Transaction time bound; the client must submit before this. */
  expiresAt: string;
}

export interface TokenizationListResponse {
  tokenizations: TokenizationDTO[];
  /**
   * Risk per tokenization, keyed by id (plane.md §3.4).
   *
   * Carried on the list rather than left to a detail fetch per card: the
   * marketplace renders every open tokenization at once, and N+1 requests to
   * show a maturity date is how a risk disclosure ends up quietly dropped for
   * being slow.
   *
   * Keyed rather than positional so a client that filters or reorders the
   * list cannot pair a card with another deal's risk.
   */
  risk: Record<string, TokenizationRiskDTO>;
}

export interface AssetListResponse {
  assets: AssetDTO[];
}


// ── Phase 6: Reputation (advisory prior for dispute risk) ─────────────────────
// Reputation is a bounded 0..1 advisory score derived from completed orders and
// resolved disputes. It is ADVISORY ONLY — it never gates money movement; it
// feeds the dispute AI advisory as a prior (Rules.md §6). No PII is stored.

export interface ReputationDTO {
  userId: string;
  /** Bounded 0..1 score (0.5 = neutral / no history). */
  score: number;
  /** Successfully completed orders (released), as a party. */
  ordersCompleted: number;
  /** Disputes resolved in this user's favour. */
  disputesWon: number;
  /** Disputes resolved against this user. */
  disputesLost: number;
  updatedAt: string;
}

export interface ReputationResponse {
  reputation: ReputationDTO;
}

// ── Phase 6: Product feedback (public wall) ───────────────────────────────────
// Feedback is collected with contact details and published WITHOUT them. The
// submitter gives name, email, wallet address, a message and a 1..5 rating; the
// public wall shows only the name, the message and the rating.
//
// Email and wallet address are contact PII and never appear in any response
// (Rules.md §7): they exist so the team can reach the author and tie feedback to
// a real testnet participant. The split is enforced by the type system — the
// repository record carries them, `FeedbackDTO` does not, and the DTO is the
// only shape any route returns.

/** What the submitter fills in. `email` and `wallet` are write-only. */
export interface FeedbackInput {
  name: string;
  email: string;
  /** Stellar `G…` account the feedback is associated with. */
  walletAddress: string;
  message: string;
  /** Whole stars, 1..5. */
  rating: number;
}

/**
 * The public projection — everything a visitor is allowed to see.
 *
 * Deliberately has no `email` or `walletAddress` field, so a route cannot leak
 * one by forgetting to strip it: there is nowhere for the value to go.
 */
export interface FeedbackDTO {
  id: string;
  name: string;
  message: string;
  rating: number;
  createdAt: string;
}

/** Aggregate shown above the wall. */
export interface FeedbackSummaryDTO {
  total: number;
  /** Mean rating rounded to 2dp, or null when there is no feedback yet. */
  averageRating: number | null;
  /** Count per star value, indexed by the rating as a string ("1".."5"). */
  distribution: Record<string, number>;
}

export interface FeedbackListResponse {
  feedback: FeedbackDTO[];
  summary: FeedbackSummaryDTO;
}

export interface FeedbackMutationResponse {
  feedback: FeedbackDTO;
}
