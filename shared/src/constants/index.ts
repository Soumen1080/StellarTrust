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
  /**
   * Custody contract deployed but not yet funded. Locking is a two-step round
   * trip on-chain — the server deploys the instance, then the buyer's wallet
   * signs the `initialize` that moves the funds — and this is the gap between
   * them. Has no counterpart in the contract's own `State` enum, which only
   * exists once `initialize` has run.
   */
  Pending: "pending",
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
  /**
   * A party moves a locked escrow into the on-chain `Disputed` state. This is
   * the only route by which the arbiter can later settle an escrow the buyer
   * never confirmed — the contract's `release` accepts `Disputed` or
   * `delivery_confirmed`, nothing else.
   */
  Dispute: "dispute",
} as const;
export type PaymentTransition =
  (typeof PaymentTransition)[keyof typeof PaymentTransition];

/**
 * Who must sign the Stellar transaction behind a transition.
 *
 * The escrow contract gates `initialize`, `confirm_delivery`, and `dispute`
 * with the calling party's own `require_auth()`, so the server physically
 * cannot produce those signatures. Those transitions run a prepare → wallet
 * sign → submit round trip instead of a single server-side call.
 */
export const ChainSigningMode = {
  /** Server signs with the arbiter key; a single request completes it. */
  Server: "server",
  /** The acting party's wallet must sign an unsigned XDR the server builds. */
  Wallet: "wallet",
  /** No chain transaction is involved (ledger-only bookkeeping). */
  None: "none",
} as const;
export type ChainSigningMode =
  (typeof ChainSigningMode)[keyof typeof ChainSigningMode];

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

/**
 * Decimal places the escrow *ledger* uses for each currency's minor unit —
 * the scale `order.amount.amount` is actually expressed in. Fiat and
 * fiat-pegged stablecoins are cent-denominated; XLM is natively 7-dp, so its
 * minor unit already is the stroop.
 *
 * This deliberately differs from {@link CURRENCY_SCALE} for USDC (2 here vs 7
 * there) — a known, pre-existing divergence between ledger bookkeeping and
 * the settlement/dispute modules' conversion math, tracked separately. Code
 * that parses or displays an order amount must use this constant, not
 * `CURRENCY_SCALE`.
 */
export const LEDGER_CURRENCY_DECIMALS: Record<CurrencyCode, number> = {
  USD: 2,
  EUR: 2,
  INR: 2,
  NGN: 2,
  USDC: 2,
  XLM: 7,
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

/**
 * Whether the money a resolution ordered has actually moved.
 *
 * A decision and its execution are two different facts. Recording only the
 * decision is how a dispute reads "Resolved: refund" to both parties while the
 * funds are still sitting in escrow because the arbiter transfer failed.
 */
export const DisputeSettlementStatus = {
  /** Decided, but the arbiter transfer has not run (or is retrying). */
  Pending: "pending",
  /** Funds moved through the arbiter payments path. */
  Executed: "executed",
  /** The transfer failed; the decision stands and a retry is owed. */
  Failed: "failed",
  /**
   * There was nothing to move — the order had no locked custody, so the
   * resolution is a record rather than an instruction.
   */
  NotApplicable: "not_applicable",
} as const;
export type DisputeSettlementStatus =
  (typeof DisputeSettlementStatus)[keyof typeof DisputeSettlementStatus];

/**
 * Who acted, in the reader's terms, on one line of a dispute's log. Roles —
 * not user ids — because a dispute log is read by the counterparty, who should
 * see "Seller submitted evidence", not an opaque UUID.
 */
export const DisputeLogActor = {
  Buyer: "buyer",
  Seller: "seller",
  Compliance: "compliance",
  /** The advisory model. Never moves money; always labelled as advisory. */
  Ai: "ai",
  /** Platform automation: policy auto-resolve, arbiter settlement, custody. */
  System: "system",
} as const;
export type DisputeLogActor =
  (typeof DisputeLogActor)[keyof typeof DisputeLogActor];

/** Order states in which a dispute may be opened: funds committed, not final. */
export const DISPUTABLE_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.Deposited,
  OrderStatus.Locked,
  OrderStatus.Confirmed,
  OrderStatus.Disputed,
];


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

/**
 * Who holds the tokenized supply on-chain.
 *
 * The RWA token contract gates every admin operation with
 * `issuer.require_auth()` and every transfer with `from.require_auth()`, so
 * whoever is named issuer must sign. That makes custody a deployment choice
 * with real consequences, not an implementation detail.
 */
export const RwaCustodyMode = {
  /**
   * The platform's signer is the on-chain issuer and holds the supply. Every
   * operation is a single server-signed call; the issuer never touches a key.
   */
  Platform: "platform",
  /**
   * The issuer's own SEP-10 wallet is the on-chain issuer and holds the
   * supply. The platform can no longer move units or change contract state on
   * their behalf — issuer-gated operations become prepare → sign → submit.
   */
  Issuer: "issuer",
} as const;
export type RwaCustodyMode =
  (typeof RwaCustodyMode)[keyof typeof RwaCustodyMode];

/**
 * RWA contract operations, named so a client can ask who signs each one.
 *
 * Mirrors `PaymentTransition` for the escrow module: the set is fixed, but the
 * signing mode of each is a runtime property of `RWA_CUSTODY`.
 */
export const RwaTransition = {
  /** `initialize` — create the tokenization and mint the supply to the issuer. */
  Deploy: "deploy",
  /** `transfer` — deliver purchased units from the issuer to an investor. */
  Transfer: "transfer",
  /** `authorize` — admit a holder to a compliance-gated token. */
  Authorize: "authorize",
  /** `revoke_authorization` — remove a holder's admission. */
  Revoke: "revoke",
  /** `freeze` — halt all transfers. */
  Freeze: "freeze",
  /** `unfreeze` — resume transfers. */
  Unfreeze: "unfreeze",
  /** `mark_distributed` — set the contract's one-shot payout guard. */
  Distribute: "distribute",
} as const;
export type RwaTransition =
  (typeof RwaTransition)[keyof typeof RwaTransition];

/**
 * Delivery state of a recorded holding.
 *
 * Under issuer custody the platform cannot move units itself, so a purchase is
 * recorded before the units exist at the buyer's address. Distinguishing the
 * two states is what keeps payouts and reconciliation honest: an undelivered
 * holding has no on-chain balance to match, and is owed no payout.
 */
export const TokenHoldingStatus = {
  /** Units reserved and paid for; the issuer has not yet signed the transfer. */
  Pending: "pending",
  /** The contract has moved the units to the holder's address. */
  Settled: "settled",
} as const;
export type TokenHoldingStatus =
  (typeof TokenHoldingStatus)[keyof typeof TokenHoldingStatus];
