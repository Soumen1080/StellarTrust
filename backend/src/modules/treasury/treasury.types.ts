/**
 * Treasury — how a user's ledger balance comes to exist (plane.md §4.5).
 *
 * §4.5 gave every user an account and a balance. It did not say how money gets
 * into one. Without that the insufficient-funds check it unblocked refuses
 * *every* purchase, because every balance is zero — which is correct behaviour
 * and useless behaviour at the same time.
 *
 * A deposit here is not a number a user types. It is the platform observing a
 * payment that already happened on Stellar, to an address the platform
 * controls, from an address the user proved control of during SEP-10, and
 * crediting their ledger account for exactly what arrived. The chain settles
 * first and the ledger records it — the ordering Rules.md §2 requires for every
 * chain-backed money step.
 *
 * A withdrawal is the reverse and is genuinely the harder direction: it spends
 * platform funds, so it debits the user's balance *before* the payment is
 * submitted and reverses that debit if the submission fails. Fail-closed means
 * a user is never paid twice; it does mean a network partition can leave a
 * withdrawal `pending` until reconciliation resolves it, which is the correct
 * trade.
 */
import type { CurrencyCode } from "@stellartrust/shared";

/** Where a movement of value sits in its lifecycle. */
export const TreasuryStatus = {
  /** Submitted to the chain, not yet confirmed. */
  Pending: "pending",
  /** Confirmed on-chain and posted to the ledger. */
  Completed: "completed",
  /** Refused or failed; any provisional ledger effect has been reversed. */
  Failed: "failed",
} as const;
export type TreasuryStatus =
  (typeof TreasuryStatus)[keyof typeof TreasuryStatus];

export const TreasuryDirection = {
  Deposit: "deposit",
  Withdrawal: "withdrawal",
} as const;
export type TreasuryDirection =
  (typeof TreasuryDirection)[keyof typeof TreasuryDirection];

export interface TreasuryMovementDTO {
  id: string;
  userId: string;
  direction: TreasuryDirection;
  status: TreasuryStatus;
  /** Minor units, as a string. Never a float. */
  amount: string;
  currency: CurrencyCode;
  /**
   * The Stellar transaction hash this movement is evidenced by.
   *
   * For a deposit it is supplied by the user and is what the platform verifies
   * against Horizon — it is the *claim*, and verification is what makes it a
   * credit. For a withdrawal it is filled in once submission succeeds.
   */
  stellarTxHash: string | null;
  /** The counterparty address: where a deposit came from, where a withdrawal went. */
  counterpartyAddress: string;
  /** Ledger transaction recording the movement, once posted. */
  ledgerTransactionId: string | null;
  /** Why a movement failed, when it did. Safe to show the user. */
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ClaimDepositInput {
  /** The Stellar transaction hash the user says paid the platform. */
  stellarTxHash: string;
}

export interface WithdrawInput {
  amount: string;
  currency: CurrencyCode;
  /**
   * Where to send it. Optional: defaults to the wallet the user proved control
   * of at SEP-10, which is the only address the platform has any reason to
   * trust. Supplying another is allowed but is the user's own risk.
   */
  destinationAddress?: string;
}

/**
 * What a verified on-chain payment looked like.
 *
 * The gateway returns this; the service decides whether it is creditable. The
 * split matters: "what does the chain say happened" and "does that entitle
 * this user to a credit" are different questions, and a gateway that answered
 * both would be a gateway that could authorize a payment.
 */
export interface ObservedPayment {
  txHash: string;
  from: string;
  to: string;
  /** Asset code, `XLM` for native. */
  assetCode: string;
  /** Decimal string exactly as Horizon reports it. */
  amount: string;
  /** True once the transaction is included in a closed ledger. */
  successful: boolean;
  createdAt: string;
  ledgerSequence: number;
}
