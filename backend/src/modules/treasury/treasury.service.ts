/**
 * Treasury service — deposits and withdrawals against real Stellar payments
 * (plane.md §4.5).
 *
 * §4.5 gave users a ledger account. This is how one comes to hold anything.
 *
 * **A deposit is a verification, not an instruction.** The user does not tell
 * the platform how much to credit them; they tell it *which transaction* to
 * look at. The platform reads that transaction from Horizon and credits
 * exactly what arrived, to exactly the user whose SEP-10 wallet sent it. The
 * chain settles first, the ledger records it — the ordering Rules.md §2
 * requires of every chain-backed money step.
 *
 * **A withdrawal is the dangerous direction**, because it spends platform
 * funds. The user's balance is debited *before* submission and the debit is
 * reversed if submission fails. That ordering can leave a user briefly debited
 * for a payment that never went out; the alternative — pay first, debit after
 * — can pay a user who never had the balance, and only one of those two
 * failures is recoverable.
 */
import {
  EntryDirection,
  LEDGER_CURRENCY_DECIMALS,
  type CurrencyCode,
} from "@stellartrust/shared";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import type { AuditRepository } from "../audit/audit.repository.js";
import type { LedgerService } from "../ledger/ledger.service.js";
import { CASH_CLEARING } from "../ledger/system-accounts.js";
import { assertStellarAddress } from "../stellar/address.js";
import { decimalStringToBigInt } from "../stellar/decimal.js";
import type { TreasuryGateway } from "./treasury.gateway.js";
import type { TreasuryRepository } from "./treasury.repository.js";
import {
  TreasuryDirection,
  TreasuryStatus,
  type ClaimDepositInput,
  type TreasuryMovementDTO,
  type WithdrawInput,
} from "./treasury.types.js";

/**
 * The address a user proved control of at SEP-10.
 *
 * A narrow port rather than the identity service: treasury needs one address,
 * and it needs it to be the *proven* one. A deposit credited on a
 * client-supplied address would let anyone claim anyone else's payment.
 */
export interface TreasuryWalletResolver {
  /**
   * `role` is the label used in the failure message when a user has no
   * connected wallet, which is why it is part of the signature rather than
   * inferred — the same shape `WalletAddressResolver` already uses, so
   * `IdentityWalletAddressResolver` satisfies this port structurally.
   */
  resolve(userId: string, role: string): Promise<string>;
}

export interface TreasuryLimits {
  /** Smallest creditable deposit, in minor units. */
  minDepositMinor: bigint;
  /**
   * Largest withdrawal that may execute without a compliance decision, in
   * minor units. Zero disables the automatic path entirely.
   */
  withdrawalAutoMaxMinor: bigint;
}

export const UNRESTRICTED_TREASURY_LIMITS: TreasuryLimits = {
  minDepositMinor: 1n,
  withdrawalAutoMaxMinor: 0n,
};

export interface TreasuryActor {
  userId: string;
  roles: string[];
}

/** Horizon reports every classic amount at 7 decimal places. */
const HORIZON_DECIMALS = 7;

export class TreasuryService {
  constructor(
    private readonly repository: TreasuryRepository,
    private readonly gateway: TreasuryGateway,
    private readonly ledger: LedgerService,
    private readonly wallets: TreasuryWalletResolver,
    private readonly audit: AuditRepository,
    private readonly limits: TreasuryLimits = UNRESTRICTED_TREASURY_LIMITS,
  ) {}

  /** Where users send funds to top up. Public information. */
  async depositAddress(): Promise<{ address: string }> {
    return { address: await this.gateway.treasuryAddress() };
  }

  /**
   * Credit a user for a payment they already made to the platform.
   *
   * Every refusal below is a real attack or a real accident:
   *   - the hash names nothing, or a failed transaction → nothing arrived
   *   - the payment went somewhere other than the treasury → not ours to credit
   *   - the sender is not this user's proven wallet → someone else's money
   *   - the hash is already claimed → the double-credit this method exists to
   *     prevent, settled by a uniqueness constraint rather than a check
   */
  async claimDeposit(
    actor: TreasuryActor,
    input: ClaimDepositInput,
  ): Promise<TreasuryMovementDTO> {
    const txHash = input.stellarTxHash?.trim();
    if (!txHash || !/^[0-9a-f]{64}$/i.test(txHash)) {
      throw new ValidationError(
        "A Stellar transaction hash is 64 hexadecimal characters",
      );
    }

    // Checked before the chain read as well as by the uniqueness constraint on
    // write. The constraint is what actually guarantees it; this just turns
    // the ordinary repeat-click into a clear message instead of a conflict.
    const alreadyClaimed = await this.repository.findByTxHash(txHash);
    if (alreadyClaimed) {
      throw new ConflictError(
        "This Stellar transaction has already been credited",
      );
    }

    const [treasuryAddress, userWallet] = await Promise.all([
      this.gateway.treasuryAddress(),
      this.wallets.resolve(actor.userId, "account holder"),
    ]);

    const payments = await this.gateway.findPayments(txHash);
    if (payments.length === 0) {
      throw new NotFoundError(
        "No successful payment found for that transaction hash on " +
          "this network",
      );
    }

    // Only the legs that actually paid the platform, from this user's proven
    // wallet. A transaction can carry many payments; the others are not ours.
    const creditable = payments.filter(
      (payment) => payment.to === treasuryAddress && payment.from === userWallet,
    );
    if (creditable.length === 0) {
      const paidUs = payments.some((payment) => payment.to === treasuryAddress);
      throw new ForbiddenError(
        paidUs
          ? "That payment was not sent from the wallet you signed in with"
          : "That transaction did not pay this platform's deposit address",
      );
    }

    // A transaction paying us twice in the same asset is one deposit of the
    // sum. Splitting it into two movements would need two hashes, and there is
    // only one.
    const byAsset = new Map<string, bigint>();
    for (const payment of creditable) {
      const currency = payment.assetCode as CurrencyCode;
      const minor = this.toMinorUnits(payment.amount, currency);
      byAsset.set(currency, (byAsset.get(currency) ?? 0n) + minor);
    }
    if (byAsset.size > 1) {
      throw new ValidationError(
        "That transaction paid in more than one asset. Send one asset per " +
          "deposit so the credit is unambiguous.",
      );
    }

    const [entry] = [...byAsset.entries()];
    if (!entry) {
      throw new NotFoundError("No creditable payment found");
    }
    const [currencyCode, amount] = entry;
    const currency = currencyCode as CurrencyCode;

    if (amount < this.limits.minDepositMinor) {
      throw new ValidationError(
        `Deposit is below the ${this.limits.minDepositMinor} minor-unit minimum`,
      );
    }

    // ── The ledger posting ────────────────────────────────────────────────
    //
    // Debit the platform's cash clearing account (an asset — the money really
    // is ours now, it is sitting in the treasury account on-chain), credit the
    // user (a liability — we owe it to them). The reference id is the
    // transaction hash, so the ledger's own uniqueness constraint is a second,
    // independent guard against crediting one payment twice.
    const ledgerTransaction = await this.ledger.record({
      referenceId: `treasury-deposit:${txHash}`,
      description: `Deposit for user ${actor.userId}`,
      entries: [
        {
          accountId: CASH_CLEARING,
          direction: EntryDirection.Debit,
          amount: amount.toString(),
          currency,
        },
        {
          accountId: this.ledger.userAccount(actor.userId),
          direction: EntryDirection.Credit,
          amount: amount.toString(),
          currency,
        },
      ],
    });

    const movement = await this.repository.create({
      userId: actor.userId,
      direction: TreasuryDirection.Deposit,
      status: TreasuryStatus.Completed,
      amount: amount.toString(),
      currency,
      stellarTxHash: txHash,
      counterpartyAddress: userWallet,
      ledgerTransactionId: ledgerTransaction.id,
    });

    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: "treasury.deposit_credited",
      entity: "treasury_movement",
      entityId: movement.id,
      metadata: {
        currency,
        amount: amount.toString(),
        stellarTxHash: txHash,
        ledgerTransactionId: ledgerTransaction.id,
      },
    });

    return movement;
  }

  /**
   * Pay a user out to a Stellar address.
   *
   * Debit-then-submit, and reverse on failure. See the class comment for why
   * that ordering is the safe one.
   */
  async withdraw(
    actor: TreasuryActor,
    input: WithdrawInput,
  ): Promise<TreasuryMovementDTO> {
    let amount: bigint;
    try {
      amount = BigInt(input.amount);
    } catch {
      throw new ValidationError("Amount must be an integer of minor units");
    }
    if (amount <= 0n) {
      throw new ValidationError("Amount must be positive");
    }

    const currency = input.currency;
    if (!(currency in LEDGER_CURRENCY_DECIMALS)) {
      throw new ValidationError(`Unsupported currency ${currency}`);
    }

    // Default to the wallet they proved control of. An explicit destination is
    // allowed — a user may well want funds elsewhere — but it is validated as
    // a real strkey, because an address that is merely a string is an address
    // the funds vanish into.
    const destination = input.destinationAddress
      ? assertStellarAddress(input.destinationAddress, "destinationAddress")
      : await this.wallets.resolve(actor.userId, "account holder");

    // Above the automatic ceiling a withdrawal is a decision, not a transfer
    // (Rules.md §6: no autonomous money decision above threshold). It is
    // recorded pending so compliance can see and act on it, rather than
    // refused — refusing would lose the request entirely.
    const needsReview =
      this.limits.withdrawalAutoMaxMinor > 0n &&
      amount > this.limits.withdrawalAutoMaxMinor;

    // The balance check is the same one every user-funded operation runs, and
    // it runs before anything is written.
    await this.ledger.assertSufficientFunds(actor.userId, currency, amount);

    if (needsReview) {
      const queued = await this.repository.create({
        userId: actor.userId,
        direction: TreasuryDirection.Withdrawal,
        status: TreasuryStatus.Pending,
        amount: amount.toString(),
        currency,
        stellarTxHash: null,
        counterpartyAddress: destination,
        ledgerTransactionId: null,
      });
      await this.audit.append({
        actor: `user:${actor.userId}`,
        action: "treasury.withdrawal_queued_for_review",
        entity: "treasury_movement",
        entityId: queued.id,
        metadata: {
          currency,
          amount: amount.toString(),
          autoMax: this.limits.withdrawalAutoMaxMinor.toString(),
        },
      });
      return queued;
    }

    return this.executeWithdrawal(actor.userId, amount, currency, destination);
  }

  /**
   * Release a withdrawal that was held for review.
   *
   * Compliance-gated, and it re-runs the balance check: the hold may have
   * lasted a while, and the user may have spent the money in the meantime.
   */
  async approveWithdrawal(
    movementId: string,
    actor: TreasuryActor,
  ): Promise<TreasuryMovementDTO> {
    if (!actor.roles.includes("compliance")) {
      throw new ForbiddenError(
        "Releasing a held withdrawal requires compliance access",
      );
    }
    const movement = await this.repository.findById(movementId);
    if (!movement) throw new NotFoundError("Withdrawal not found");
    if (movement.direction !== TreasuryDirection.Withdrawal) {
      throw new ConflictError("That movement is not a withdrawal");
    }
    if (movement.status !== TreasuryStatus.Pending) {
      throw new ConflictError("That withdrawal is not awaiting a decision");
    }

    const amount = BigInt(movement.amount);
    await this.ledger.assertSufficientFunds(
      movement.userId,
      movement.currency,
      amount,
    );

    const executed = await this.executeWithdrawal(
      movement.userId,
      amount,
      movement.currency,
      movement.counterpartyAddress,
      movement.id,
    );

    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: "treasury.withdrawal_approved",
      entity: "treasury_movement",
      entityId: movement.id,
      metadata: { currency: movement.currency, amount: movement.amount },
    });
    return executed;
  }

  /** Refuse a held withdrawal. Nothing was debited, so nothing is reversed. */
  async rejectWithdrawal(
    movementId: string,
    actor: TreasuryActor,
    reason: string,
  ): Promise<TreasuryMovementDTO> {
    if (!actor.roles.includes("compliance")) {
      throw new ForbiddenError(
        "Refusing a held withdrawal requires compliance access",
      );
    }
    if (!reason?.trim()) {
      throw new ValidationError("A reason is required to refuse a withdrawal");
    }
    const movement = await this.repository.findById(movementId);
    if (!movement) throw new NotFoundError("Withdrawal not found");
    if (movement.status !== TreasuryStatus.Pending) {
      throw new ConflictError("That withdrawal is not awaiting a decision");
    }

    const rejected = await this.repository.update({
      ...movement,
      status: TreasuryStatus.Failed,
      failureReason: reason.trim(),
      completedAt: new Date().toISOString(),
    });
    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: "treasury.withdrawal_rejected",
      entity: "treasury_movement",
      entityId: movement.id,
      metadata: { reasonProvided: true },
    });
    return rejected;
  }

  async listForUser(userId: string): Promise<TreasuryMovementDTO[]> {
    return this.repository.listForUser(userId);
  }

  /**
   * The caller's spendable balances, one per currency (plane.md §4.5's
   * `GET /api/ledger/balances`, served here because treasury is what puts
   * money in them).
   */
  async balances(userId: string): Promise<
    Array<{ currency: CurrencyCode; balance: string }>
  > {
    const accounts = await this.ledger.listUserBalances(userId);
    return accounts.map((account) => ({
      currency: account.currency,
      balance: account.balance,
    }));
  }

  async listAll(filter?: {
    status?: TreasuryStatus;
    direction?: TreasuryDirection;
    limit?: number;
  }): Promise<TreasuryMovementDTO[]> {
    return this.repository.listAll(filter);
  }

  /**
   * Debit, submit, and record — reversing the debit if the chain refuses.
   *
   * The reversal is a second ledger transaction, not a deletion: the ledger is
   * append-only and is the system of record (Golden Rule #1), so a failed
   * withdrawal is two facts — we tried, and it came back — not the absence of
   * one. The same shape §3.2's cooling-off cancellation uses.
   */
  private async executeWithdrawal(
    userId: string,
    amount: bigint,
    currency: CurrencyCode,
    destination: string,
    existingMovementId?: string,
  ): Promise<TreasuryMovementDTO> {
    // Keyed on the movement, which is the withdrawal's own identity.
    //
    // It used to key on `${userId}:${currency}:${amount}:${Date.now()}`, which
    // is wrong in both directions: two identical withdrawals in the same
    // millisecond collide on the ledger reference and the second is refused,
    // while two a second apart are treated as distinct even when the second is
    // a retry of the first. Idempotency at *this* layer is the wrong place for
    // it anyway — a retried HTTP request is caught by the `Idempotency-Key`
    // middleware on the route, which is what Rules.md #4 asks for. Here the
    // reference just has to be unique per withdrawal, and the movement id is.
    //
    // The movement is therefore created first, unfunded, and the debit posts
    // against it.
    const movement =
      existingMovementId !== undefined
        ? await this.repository.findById(existingMovementId)
        : await this.repository.create({
            userId,
            direction: TreasuryDirection.Withdrawal,
            status: TreasuryStatus.Pending,
            amount: amount.toString(),
            currency,
            stellarTxHash: null,
            counterpartyAddress: destination,
            ledgerTransactionId: null,
          });
    if (!movement) throw new NotFoundError("Withdrawal not found");

    const referenceId = `treasury-withdrawal:${movement.id}`;

    const debit = await this.ledger.record({
      referenceId,
      description: `Withdrawal for user ${userId}`,
      entries: [
        {
          accountId: this.ledger.userAccount(userId),
          direction: EntryDirection.Debit,
          amount: amount.toString(),
          currency,
        },
        {
          accountId: CASH_CLEARING,
          direction: EntryDirection.Credit,
          amount: amount.toString(),
          currency,
        },
      ],
    });

    // The movement exists already (it had to, to key the reference id). Link
    // it to the posting that debited the user.
    const funded = await this.repository.update({
      ...movement,
      ledgerTransactionId: debit.id,
    });

    try {
      const txHash = await this.gateway.sendPayment({
        destination,
        amount: this.toDecimalString(amount, currency),
        assetCode: currency,
      });

      const completed = await this.repository.update({
        ...funded,
        status: TreasuryStatus.Completed,
        stellarTxHash: txHash,
        completedAt: new Date().toISOString(),
      });

      await this.audit.append({
        actor: `user:${userId}`,
        action: "treasury.withdrawal_sent",
        entity: "treasury_movement",
        entityId: completed.id,
        metadata: {
          currency,
          amount: amount.toString(),
          stellarTxHash: txHash,
          ledgerTransactionId: debit.id,
        },
      });
      return completed;
    } catch (err) {
      // The payment did not go out. Give the money back, then report the
      // failure — a user left debited for a payment that never happened is the
      // one outcome this path must not produce.
      await this.ledger
        .record({
          referenceId: `${referenceId}:reversal`,
          description: `Withdrawal reversed for user ${userId}`,
          entries: [
            {
              accountId: CASH_CLEARING,
              direction: EntryDirection.Debit,
              amount: amount.toString(),
              currency,
            },
            {
              accountId: this.ledger.userAccount(userId),
              direction: EntryDirection.Credit,
              amount: amount.toString(),
              currency,
            },
          ],
        })
        .catch((reversalError: unknown) => {
          // A reversal that itself fails is the one case a human must see: the
          // user is debited and unpaid, and no further automation can fix it.
          logger.error(
            {
              userId,
              currency,
              amount: amount.toString(),
              errorType: (reversalError as Error)?.name,
            },
            "CRITICAL: withdrawal reversal failed; user is debited without payment",
          );
        });

      const failed = await this.repository.update({
        ...funded,
        status: TreasuryStatus.Failed,
        failureReason: "The payment could not be submitted to the network",
        completedAt: new Date().toISOString(),
      });

      await this.audit.append({
        actor: "system:treasury",
        action: "treasury.withdrawal_failed",
        entity: "treasury_movement",
        entityId: failed.id,
        metadata: {
          currency,
          amount: amount.toString(),
          reversed: true,
          errorType: (err as Error)?.name ?? "unknown",
        },
      });
      throw err;
    }
  }

  /**
   * Horizon's decimal string → ledger minor units.
   *
   * Horizon always reports 7 decimals. The ledger's scale differs per currency
   * (XLM 7, USDC 2), so a USDC payment of 10.5000000 is 1050 minor units and a
   * payment of 10.0000001 cannot be represented at all — which is refused
   * rather than rounded, because rounding a deposit down is quietly keeping
   * the difference.
   */
  private toMinorUnits(decimal: string, currency: CurrencyCode): bigint {
    const ledgerDecimals = LEDGER_CURRENCY_DECIMALS[currency];
    if (ledgerDecimals === undefined) {
      throw new ValidationError(
        `Deposits in ${currency} are not supported by this deployment`,
      );
    }
    const stroops = decimalStringToBigInt(decimal, HORIZON_DECIMALS);
    const shift = HORIZON_DECIMALS - ledgerDecimals;
    const divisor = 10n ** BigInt(shift);
    if (stroops % divisor !== 0n) {
      throw new ValidationError(
        `That payment carries more precision than ${currency} can record. ` +
          `Send an amount with at most ${ledgerDecimals} decimal places.`,
      );
    }
    return stroops / divisor;
  }

  /** Ledger minor units → the decimal string the chain expects. */
  private toDecimalString(amount: bigint, currency: CurrencyCode): string {
    const ledgerDecimals = LEDGER_CURRENCY_DECIMALS[currency];
    const scale = 10n ** BigInt(ledgerDecimals);
    const whole = amount / scale;
    const fraction = amount % scale;
    if (ledgerDecimals === 0) return whole.toString();
    return `${whole}.${fraction.toString().padStart(ledgerDecimals, "0")}`;
  }
}
