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
}

export interface EscrowDTO {
  id: string;
  orderId: string;
  contractId: string | null;
  state: EscrowState;
  createdAt: string;
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
