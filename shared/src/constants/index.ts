/**
 * Cross-portion constants (contracts of record).
 * Status enums and currency codes shared by frontend, backend, and (mirrored in) ai.
 * No runtime logic beyond frozen constant declarations.
 */

/** KYC decision outcomes (PRD 6.1). */
export const KycDecision = {
  Approve: "approve",
  Review: "review",
  Reject: "reject",
} as const;
export type KycDecision = (typeof KycDecision)[keyof typeof KycDecision];

/** KYC verification lifecycle status. */
export const KycStatus = {
  Pending: "pending",
  UnderReview: "under_review",
  Verified: "verified",
  Rejected: "rejected",
} as const;
export type KycStatus = (typeof KycStatus)[keyof typeof KycStatus];

/** Order lifecycle (Phase 2). */
export const OrderStatus = {
  Created: "created",
  Accepted: "accepted",
  Deposited: "deposited",
  Locked: "locked",
  Confirmed: "confirmed",
  Released: "released",
  Refunded: "refunded",
  Disputed: "disputed",
  Cancelled: "cancelled",
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

/** Escrow contract states (Architecture 6). */
export const EscrowState = {
  Locked: "locked",
  Released: "released",
  Refunded: "refunded",
  Disputed: "disputed",
} as const;
export type EscrowState = (typeof EscrowState)[keyof typeof EscrowState];

/** Financially recorded Phase 2 order transitions. */
export const PaymentTransition = {
  Create: "create",
  Accept: "accept",
  Deposit: "deposit",
  Lock: "lock",
  Confirm: "confirm",
  Release: "release",
  Refund: "refund",
} as const;
export type PaymentTransition =
  (typeof PaymentTransition)[keyof typeof PaymentTransition];

/** Ledger-to-chain reconciliation outcome. */
export const ReconciliationStatus = {
  Matched: "matched",
  Mismatch: "mismatch",
} as const;
export type ReconciliationStatus =
  (typeof ReconciliationStatus)[keyof typeof ReconciliationStatus];

/** Dispute lifecycle. */
export const DisputeStatus = {
  Open: "open",
  EvidenceWindow: "evidence_window",
  UnderReview: "under_review",
  Resolved: "resolved",
} as const;
export type DisputeStatus = (typeof DisputeStatus)[keyof typeof DisputeStatus];

/** AI advisory recommendations (Rules.md #6 — advisory only). */
export const AiRecommendation = {
  Release: "release",
  Refund: "refund",
  ManualReview: "manual_review",
} as const;
export type AiRecommendation =
  (typeof AiRecommendation)[keyof typeof AiRecommendation];

/**
 * Double-entry ledger direction.
 * Every money movement writes a balanced set of entries where the signed sum is 0.
 */
export const EntryDirection = {
  Debit: "debit",
  Credit: "credit",
} as const;
export type EntryDirection =
  (typeof EntryDirection)[keyof typeof EntryDirection];

/** Ledger account classes (normal balance side documented per class). */
export const LedgerAccountType = {
  Asset: "asset", // normal debit
  Liability: "liability", // normal credit
  Equity: "equity", // normal credit
  Revenue: "revenue", // normal credit
  Expense: "expense", // normal debit
} as const;
export type LedgerAccountType =
  (typeof LedgerAccountType)[keyof typeof LedgerAccountType];

/** Stellar transaction record status (reconciliation). */
export const ChainTxStatus = {
  Pending: "pending",
  Submitted: "submitted",
  Success: "success",
  Failed: "failed",
} as const;
export type ChainTxStatus =
  (typeof ChainTxStatus)[keyof typeof ChainTxStatus];

/**
 * Supported currency / asset codes for the MVP corridors.
 * Fiat ISO-4217 codes plus Stellar-native assets. Extend per launch corridor.
 */
export const CurrencyCode = {
  USD: "USD",
  EUR: "EUR",
  INR: "INR",
  NGN: "NGN",
  XLM: "XLM",
  USDC: "USDC",
} as const;
export type CurrencyCode = (typeof CurrencyCode)[keyof typeof CurrencyCode];

export const SUPPORTED_CURRENCIES: readonly CurrencyCode[] = Object.values(
  CurrencyCode,
) as CurrencyCode[];

/** Stellar network passphrases (public constants — not secrets). */
export const StellarNetwork = {
  Testnet: "Test SDF Network ; September 2015",
  Public: "Public Global Stellar Network ; September 2015",
} as const;
export type StellarNetwork =
  (typeof StellarNetwork)[keyof typeof StellarNetwork];


// ── Phase 1: Identity & Wallet ────────────────────────────────────────────────

/** KYC applicant/profile kind. */
export const ApplicantType = {
  Individual: "individual",
  Business: "business",
} as const;
export type ApplicantType =
  (typeof ApplicantType)[keyof typeof ApplicantType];

/** Normalized sandbox/provider check outcomes. */
export const ProviderCheckStatus = {
  Pass: "pass",
  Review: "review",
  Fail: "fail",
} as const;
export type ProviderCheckStatus =
  (typeof ProviderCheckStatus)[keyof typeof ProviderCheckStatus];

/** Human-review queue lifecycle. */
export const ReviewStatus = {
  Queued: "queued",
  Resolved: "resolved",
} as const;
export type ReviewStatus =
  (typeof ReviewStatus)[keyof typeof ReviewStatus];

/** Allowed final decisions a human compliance reviewer may make. */
export const HumanKycDecision = {
  Approve: "approve",
  Reject: "reject",
} as const;
export type HumanKycDecision =
  (typeof HumanKycDecision)[keyof typeof HumanKycDecision];


// ── Phase 3: Cross-Border Settlement ──────────────────────────────────────────

/** Cross-border settlement lifecycle status. */
export const SettlementStatus = {
  Quoted: "quoted",
  DepositPending: "deposit_pending",
  Converting: "converting",
  PayoutPending: "payout_pending",
  Completed: "completed",
  Failed: "failed",
} as const;
export type SettlementStatus =
  (typeof SettlementStatus)[keyof typeof SettlementStatus];

/**
 * Financially recorded settlement transitions. Each writes a balanced ledger
 * transaction linked to an anchor transfer and/or a chain (path payment) record.
 */
export const SettlementTransition = {
  /** Anchor receives source funds (SEP-6/24/31 deposit). */
  Deposit: "deposit",
  /** On-chain source→destination conversion (path payment or AMM swap). */
  Convert: "convert",
  /** Anchor pays the destination beneficiary (SEP-6/24/31 withdrawal). */
  Payout: "payout",
} as const;
export type SettlementTransition =
  (typeof SettlementTransition)[keyof typeof SettlementTransition];

/**
 * On-chain liquidity mechanism used for a conversion hop.
 * Classic Stellar only (Rules.md #3: no Soroban for liquidity/settlement).
 */
export const RouteType = {
  PathPayment: "path_payment",
  Amm: "amm",
} as const;
export type RouteType = (typeof RouteType)[keyof typeof RouteType];

/** Simplified anchor transfer status (SEP-6/24/31). */
export const AnchorTransferStatus = {
  Pending: "pending",
  Completed: "completed",
  Failed: "failed",
} as const;
export type AnchorTransferStatus =
  (typeof AnchorTransferStatus)[keyof typeof AnchorTransferStatus];

/** Anchor protocol used for a corridor leg. */
export const AnchorProtocol = {
  Sep6: "sep6",
  Sep24: "sep24",
  Sep31: "sep31",
} as const;
export type AnchorProtocol =
  (typeof AnchorProtocol)[keyof typeof AnchorProtocol];

/** SEP-12 customer KYC exchange status (anchor-side). */
export const AnchorKycStatus = {
  Accepted: "ACCEPTED",
  NeedsInfo: "NEEDS_INFO",
  Rejected: "REJECTED",
} as const;
export type AnchorKycStatus =
  (typeof AnchorKycStatus)[keyof typeof AnchorKycStatus];

/**
 * Number of decimal places (scale) for each supported currency's minor unit.
 * Used to convert between currencies with exact BigInt arithmetic (no floats).
 */
export const CURRENCY_SCALE: Record<CurrencyCode, number> = {
  USD: 2,
  EUR: 2,
  INR: 2,
  NGN: 2,
  XLM: 7,
  USDC: 7,
};


// ── Phase 4: Disputes + AI (advisory) ─────────────────────────────────────────

/** Evidence categories accepted during a dispute (PRD / Phase 4 deliverables). */
export const EvidenceKind = {
  Invoice: "invoice",
  Tracking: "tracking",
  Otp: "otp",
  Courier: "courier",
  Image: "image",
} as const;
export type EvidenceKind = (typeof EvidenceKind)[keyof typeof EvidenceKind];

/**
 * Terminal dispute resolution. Reuses the advisory vocabulary for the two
 * fund outcomes; `ManualReview` is never a terminal resolution (it routes to a
 * human). A resolved dispute is always Release or Refund.
 */
export const DisputeResolution = {
  Release: "release",
  Refund: "refund",
} as const;
export type DisputeResolution =
  (typeof DisputeResolution)[keyof typeof DisputeResolution];

/** Who produced the terminal dispute decision. */
export const DisputeDecisionMaker = {
  /** Auto-resolved below amount / above confidence thresholds (Rules.md #3). */
  AutoPolicy: "auto_policy",
  /** A human compliance reviewer signed off (required above thresholds). */
  Human: "human",
} as const;
export type DisputeDecisionMaker =
  (typeof DisputeDecisionMaker)[keyof typeof DisputeDecisionMaker];



// ── Phase 5: RWA Tokenization (opt-in module) ─────────────────────────────────

/** Type of real-world asset being tokenized. */
export const AssetType = {
  Invoice: "invoice",
  Commodity: "commodity",
  RealEstate: "real_estate",
  Other: "other",
} as const;
export type AssetType = (typeof AssetType)[keyof typeof AssetType];

/** Tokenization lifecycle status. */
export const TokenizationStatus = {
  /** Created but not yet deployed on-chain. */
  Draft: "draft",
  /** Deployed and accepting investor purchases. */
  Active: "active",
  /** Fully subscribed (all units sold). */
  Funded: "funded",
  /** Payout distribution in progress. */
  Distributing: "distributing",
  /** Payout completed. */
  Distributed: "distributed",
  /** Transfers frozen (compliance control). */
  Frozen: "frozen",
  /** Cancelled before activation. */
  Cancelled: "cancelled",
} as const;
export type TokenizationStatus =
  (typeof TokenizationStatus)[keyof typeof TokenizationStatus];

/** Pro-rata payout distribution status. */
export const PayoutStatus = {
  Pending: "pending",
  Processing: "processing",
  Completed: "completed",
  Failed: "failed",
} as const;
export type PayoutStatus = (typeof PayoutStatus)[keyof typeof PayoutStatus];
