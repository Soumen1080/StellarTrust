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
