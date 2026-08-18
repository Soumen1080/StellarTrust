import { randomUUID } from "node:crypto";
import {
  ChainSigningMode,
  EntryDirection,
  EscrowState,
  OrderStatus,
  PaymentTransition,
  DisputeResolution,
  createOrderInputSchema,
  type CreateOrderInput,
  type EscrowDTO,
  type LedgerTransactionInput,
  type OrderDetailsResponse,
  type OrderDTO,
  type OrderMutationResponse,
  type PaymentCapabilitiesResponse,
  type PreparedTransitionResponse,
} from "@stellartrust/shared";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../lib/errors.js";
import { config } from "../../config/index.js";
import type { AuditRepository } from "../audit/audit.repository.js";
import type {
  ChainReceipt,
  ChainTransitionInput,
  EscrowGateway,
} from "../escrow/escrow.gateway.js";
import { networkPassphrase } from "../stellar/stellar.client.js";
import type { PaymentRepository } from "./payment.repository.js";
import type { RwaService } from "../rwa/rwa.service.js";
import { logger } from "../../lib/logger.js";
import {
  CASH_CLEARING,
  COMMITMENT_ASSET,
  COMMITMENT_LIABILITY,
  CONTRACT_CUSTODY,
  DELIVERY_ASSET,
  DELIVERY_LIABILITY,
  ESCROW_HOLDING,
} from "../ledger/system-accounts.js";

/**
 * Transitions that post to the double-entry ledger. `dispute` is deliberately
 * absent: flagging an escrow moves no money, so it changes custody state and
 * writes an audit record without a balanced posting to ride along with.
 */
export type FinancialTransition = Exclude<
  PaymentTransition,
  typeof PaymentTransition.Dispute
>;

function isFinancial(
  transition: PaymentTransition,
): transition is FinancialTransition {
  return transition !== PaymentTransition.Dispute;
}

const EXPECTED_STATUS: Record<
  FinancialTransition,
  OrderStatus | readonly OrderStatus[]
> = {
  [PaymentTransition.Create]: OrderStatus.Created,
  [PaymentTransition.Accept]: OrderStatus.Created,
  [PaymentTransition.Deposit]: OrderStatus.Accepted,
  [PaymentTransition.Lock]: OrderStatus.Deposited,
  [PaymentTransition.Confirm]: OrderStatus.Locked,
  [PaymentTransition.Release]: OrderStatus.Confirmed,
  [PaymentTransition.Refund]: [
    OrderStatus.Locked,
    OrderStatus.Confirmed,
    OrderStatus.Disputed,
  ],
};

const NEXT_STATUS: Record<FinancialTransition, OrderStatus> = {
  [PaymentTransition.Create]: OrderStatus.Created,
  [PaymentTransition.Accept]: OrderStatus.Accepted,
  [PaymentTransition.Deposit]: OrderStatus.Deposited,
  [PaymentTransition.Lock]: OrderStatus.Locked,
  [PaymentTransition.Confirm]: OrderStatus.Confirmed,
  [PaymentTransition.Release]: OrderStatus.Released,
  [PaymentTransition.Refund]: OrderStatus.Refunded,
};

/** Escrow states an order can still be settled or advanced from. */
const OPEN_ESCROW_STATES: readonly EscrowState[] = [
  EscrowState.Locked,
  EscrowState.Disputed,
];

export interface PaymentActor {
  userId: string;
  roles: string[];
}

export interface ReputationRecorder {
  recordOrderCompleted(userId: string): Promise<void>;
}

export class PaymentService {
  constructor(
    private readonly repository: PaymentRepository,
    private readonly gateway: EscrowGateway,
    private readonly audit: AuditRepository,
    private readonly rwa?: RwaService,
    private readonly reputation?: ReputationRecorder,
  ) {}

  async createOrder(
    buyerId: string,
    input: CreateOrderInput,
  ): Promise<OrderMutationResponse> {
    const parsed = createOrderInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        "Invalid order",
        parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    }
    if (parsed.data.sellerId === buyerId) {
      throw new ValidationError("Buyer and seller must be different users");
    }

    const now = new Date().toISOString();
    const order: OrderDTO = {
      id: randomUUID(),
      buyerId,
      sellerId: parsed.data.sellerId,
      amount: parsed.data.amount,
      status: OrderStatus.Created,
      createdAt: now,
      updatedAt: now,
    };
    return this.commit(order, null, PaymentTransition.Create, buyerId);
  }

  /**
   * How each transition reaches the chain in this deployment, so clients can
   * pick the single-call or the wallet round-trip path without hard-coding a
   * signing model that changes with `ESCROW_GATEWAY`.
   */
  async capabilities(): Promise<PaymentCapabilitiesResponse> {
    const transitions = Object.values(PaymentTransition);
    const signingModes: Record<string, ChainSigningMode> = {};
    const walletSignedTransitions: PaymentTransition[] = [];
    for (const transition of transitions) {
      const mode = await this.gateway.signingMode(transition);
      signingModes[transition] = mode;
      if (mode === ChainSigningMode.Wallet) {
        walletSignedTransitions.push(transition);
      }
    }
    return {
      gateway: config.ESCROW_GATEWAY,
      network: config.STELLAR_NETWORK,
      networkPassphrase: networkPassphrase(),
      signingModes,
      walletSignedTransitions,
    };
  }

  async transition(
    orderId: string,
    requested: Exclude<PaymentTransition, "create">,
    actor: PaymentActor,
  ): Promise<OrderMutationResponse> {
    if (!isFinancial(requested)) {
      throw new ConflictError(
        "A dispute is raised through the prepare/submit endpoints, not as a " +
          "financial transition",
      );
    }
    if ((await this.gateway.signingMode(requested)) === ChainSigningMode.Wallet) {
      throw new ConflictError(
        `The '${requested}' step must be signed by your wallet. Call ` +
          `POST /orders/${orderId}/${requested}/prepare, sign the returned ` +
          "transaction, then submit it.",
      );
    }

    const current = await this.requireOrder(orderId);
    await this.assertNotBlocked(orderId);
    this.authorize(current, requested, actor);
    this.assertState(current, requested);

    const order: OrderDTO = {
      ...current,
      status: NEXT_STATUS[requested],
      updatedAt: new Date().toISOString(),
    };
    const currentEscrow = (await this.repository.findEscrow(orderId)) ?? null;
    const result = await this.commit(order, currentEscrow, requested, actor.userId);
    // Phase 6: a normal happy-path release completes the trade for both parties
    // — record it as a positive reputation signal (advisory only, best-effort).
    if (requested === PaymentTransition.Release) {
      await this.recordCompletion(order);
    }
    return result;
  }

  // ── Wallet-signed transitions (buyer/seller authorized on-chain) ───────────

  /**
   * Build the unsigned transaction the acting party must sign in their wallet.
   *
   * Every authorization and state check runs here, before any chain work, so an
   * unauthorized caller never causes a contract deploy. For a lock, the
   * deployed contract id is persisted before returning: if the buyer abandons
   * the signature, the next attempt reuses that instance rather than leaking a
   * new one.
   */
  async prepareTransition(
    orderId: string,
    requested: PaymentTransition,
    actor: PaymentActor,
  ): Promise<PreparedTransitionResponse> {
    if ((await this.gateway.signingMode(requested)) !== ChainSigningMode.Wallet) {
      throw new ConflictError(
        `The '${requested}' step does not require a wallet signature here`,
      );
    }

    const order = await this.requireOrder(orderId);
    await this.assertNotBlocked(orderId);
    this.authorize(order, requested, actor);
    const escrow = (await this.repository.findEscrow(orderId)) ?? null;
    this.assertChainPreconditions(order, escrow, requested);

    const prepared = await this.gateway.prepareTransition(
      this.chainInput(order, escrow, requested, actor.userId),
    );

    if (requested === PaymentTransition.Lock) {
      // Custody now exists on-chain but holds nothing until the buyer signs.
      // The order status stays put: nothing is locked yet.
      await this.repository.saveCustodyState({
        order,
        escrow: escrow
          ? { ...escrow, contractId: prepared.contractId, updatedAt: nowIso() }
          : {
              id: randomUUID(),
              orderId: order.id,
              contractId: prepared.contractId,
              state: EscrowState.Pending,
              createdAt: nowIso(),
              updatedAt: nowIso(),
            },
      });
    }

    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: `payment.${requested}.prepared`,
      entity: "order",
      entityId: order.id,
      metadata: {
        contractId: prepared.contractId,
        signerAddress: prepared.signerAddress,
      },
    });

    return prepared;
  }

  /**
   * Submit a wallet-signed envelope, then record the result.
   *
   * The chain call comes first and must settle successfully; only then does the
   * ledger move. Doing it the other way round would let a rejected transaction
   * leave the ledger claiming custody that never happened.
   */
  async submitSignedTransition(
    orderId: string,
    requested: PaymentTransition,
    actor: PaymentActor,
    signedXdr: string,
  ): Promise<OrderMutationResponse | OrderDetailsResponse> {
    if ((await this.gateway.signingMode(requested)) !== ChainSigningMode.Wallet) {
      throw new ConflictError(
        `The '${requested}' step does not require a wallet signature here`,
      );
    }

    const current = await this.requireOrder(orderId);
    await this.assertNotBlocked(orderId);
    this.authorize(current, requested, actor);
    const escrow = (await this.repository.findEscrow(orderId)) ?? null;
    this.assertChainPreconditions(current, escrow, requested);

    const chain = await this.gateway.submitSignedTransition(
      this.chainInput(current, escrow, requested, actor.userId),
      signedXdr,
    );

    if (requested === PaymentTransition.Dispute) {
      return this.recordDispute(current, escrow, actor);
    }

    const transition = requested as FinancialTransition;
    const order: OrderDTO = {
      ...current,
      status: NEXT_STATUS[transition],
      updatedAt: nowIso(),
    };

    // Settling a *disputed* escrow posts differently from a happy-path
    // settlement: the delivery-confirmation legs never posted, so the standard
    // release posting would reverse entries that do not exist.
    const settlingDispute =
      current.status === OrderStatus.Disputed ||
      escrow?.state === EscrowState.Disputed;
    const ledger =
      settlingDispute && isSettlement(transition)
        ? disputeSettlementLedger(order, transition)
        : undefined;

    const result = await this.commit(
      order,
      escrow,
      transition,
      actor.userId,
      { chain, ledger },
    );
    if (transition === PaymentTransition.Release && !settlingDispute) {
      await this.recordCompletion(order);
    }
    return result;
  }

  /**
   * Raise a dispute as a party to the order, on whichever signing path this
   * deployment uses.
   *
   * Without this, `dispute` was unreachable for a buyer or seller whenever the
   * gateway signs server-side: `transition()` refuses it as non-financial and
   * points at prepare/submit, while `prepareTransition()` refuses it because
   * nothing needs a wallet signature. Both doors shut, and the contract's
   * `dispute` entry point — the only route to a settleable unconfirmed escrow
   * — could only ever be reached by the arbiter.
   *
   * Wallet deployments still go through prepare → sign → submit, because the
   * contract wants the party's own signature and the server cannot forge it.
   */
  async raiseDispute(
    orderId: string,
    actor: PaymentActor,
  ): Promise<OrderDetailsResponse> {
    if (
      (await this.gateway.signingMode(PaymentTransition.Dispute)) ===
      ChainSigningMode.Wallet
    ) {
      throw new ConflictError(
        "Raising a dispute must be signed by your wallet. Call " +
          `POST /orders/${orderId}/dispute/prepare, sign the returned ` +
          "transaction, then submit it.",
      );
    }

    const current = await this.requireOrder(orderId);
    await this.assertNotBlocked(orderId);
    this.authorize(current, PaymentTransition.Dispute, actor);
    const escrow = (await this.repository.findEscrow(orderId)) ?? null;
    this.assertChainPreconditions(current, escrow, PaymentTransition.Dispute);

    // The chain call comes first: custody state is what authorizes the order
    // status change, not the other way round.
    await this.gateway.submitTransition(
      this.chainInput(current, escrow, PaymentTransition.Dispute, actor.userId),
    );
    return this.recordDispute(current, escrow, actor);
  }

  /**
   * Record an on-chain dispute. No money moved, so there is no balanced posting
   * to make — custody state and the audit trail carry it.
   */
  private async recordDispute(
    current: OrderDTO,
    escrow: EscrowDTO | null,
    actor: PaymentActor,
  ): Promise<OrderDetailsResponse> {
    await this.repository.saveCustodyState({
      order: { ...current, status: OrderStatus.Disputed, updatedAt: nowIso() },
      escrow: escrow
        ? { ...escrow, state: EscrowState.Disputed, updatedAt: nowIso() }
        : null,
    });
    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: "payment.dispute",
      entity: "order",
      entityId: current.id,
      metadata: { contractId: escrow?.contractId ?? null },
    });
    return this.details(current.id, actor.userId);
  }

  /** Best-effort positive reputation signal for a completed trade. */
  private async recordCompletion(order: OrderDTO): Promise<void> {
    if (!this.reputation) return;
    try {
      await Promise.all([
        this.reputation.recordOrderCompleted(order.buyerId),
        this.reputation.recordOrderCompleted(order.sellerId),
      ]);
    } catch {
      // Reputation is advisory; never fail a settled payment because of it.
    }
  }

  /**
   * Execute a resolved dispute's outcome through the arbiter settlement path
   * (Phase 6 — the "release-path state-machine work" deferred from Phase 4).
   *
   * A resolved dispute is the authorization for the fund movement, so this is
   * gated to compliance/system actors and may release a *locked* escrow without
   * a prior buyer confirmation. It never advances an order that is not in a
   * settleable (locked/confirmed) state and fails closed on reconciliation drift.
   * Release funds the seller (and triggers any linked RWA payout); refund
   * returns funds to the buyer.
   */
  async settleDisputedOrder(
    orderId: string,
    outcome: DisputeResolution,
    actor: PaymentActor,
  ): Promise<OrderMutationResponse> {
    if (
      !actor.roles.includes("compliance") &&
      !actor.roles.includes("system")
    ) {
      throw new ForbiddenError(
        "Dispute settlement requires an authorized arbiter",
      );
    }

    const transitionFor =
      outcome === DisputeResolution.Refund
        ? PaymentTransition.Refund
        : PaymentTransition.Release;
    if (
      (await this.gateway.signingMode(transitionFor)) === ChainSigningMode.Wallet
    ) {
      // Settlement authority lives outside this server (an external or
      // multi-sig arbiter). That is the entire point of configuring one: no
      // single compromised process can move custodied funds, not even to
      // execute a correctly resolved dispute. The resolution stands as the
      // authorization; a human carries it to the key holders.
      throw new ConflictError(
        `Settling this dispute requires the arbiter account's signature. Call ` +
          `POST /orders/${orderId}/${transitionFor}/prepare, collect the ` +
          "required signatures, then submit it.",
      );
    }

    const current = await this.requireOrder(orderId);
    await this.assertNotBlocked(orderId);
    const settleable: readonly OrderStatus[] = [
      OrderStatus.Locked,
      OrderStatus.Confirmed,
      OrderStatus.Disputed,
    ];
    if (!settleable.includes(current.status)) {
      throw new ConflictError(
        `Cannot settle a dispute for an order in ${current.status} status`,
      );
    }
    let escrow = (await this.repository.findEscrow(orderId)) ?? null;
    if (!escrow || !OPEN_ESCROW_STATES.includes(escrow.state)) {
      throw new ConflictError(
        "Dispute settlement requires a locked or disputed escrow",
      );
    }

    // The contract will only release an escrow the buyer never confirmed once
    // it is Disputed — arbiter authority alone is not a state the contract
    // recognises. Escalate first so the settlement the ledger records is one
    // the chain will actually accept.
    if (
      outcome === DisputeResolution.Release &&
      escrow.state !== EscrowState.Disputed
    ) {
      escrow = await this.escalateForArbitration(current, escrow, actor);
    }

    const transition =
      outcome === DisputeResolution.Refund
        ? PaymentTransition.Refund
        : PaymentTransition.Release;
    const order: OrderDTO = {
      ...current,
      status:
        transition === PaymentTransition.Refund
          ? OrderStatus.Refunded
          : OrderStatus.Released,
      updatedAt: new Date().toISOString(),
    };

    return this.commit(order, escrow, transition, actor.userId, {
      arbiter: true,
      ledger: disputeSettlementLedger(order, transition),
    });
  }

  /**
   * Move a locked escrow into `Disputed` on the arbiter's own authority, so a
   * deal the buyer never confirmed becomes settleable. The contract accepts the
   * arbiter as a disputing party for exactly this case; without it, compliance
   * would be blocked on a signature from the party it is ruling against.
   */
  private async escalateForArbitration(
    order: OrderDTO,
    escrow: EscrowDTO,
    actor: PaymentActor,
  ): Promise<EscrowDTO> {
    await this.gateway.submitTransition(
      this.chainInput(order, escrow, PaymentTransition.Dispute, actor.userId, {
        arbiter: true,
      }),
    );
    const disputed: EscrowDTO = {
      ...escrow,
      state: EscrowState.Disputed,
      updatedAt: nowIso(),
    };
    await this.repository.saveCustodyState({ order, escrow: disputed });
    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: "payment.dispute.arbiter",
      entity: "order",
      entityId: order.id,
      metadata: { contractId: escrow.contractId },
    });
    return disputed;
  }

  async list(userId: string): Promise<OrderDetailsResponse[]> {
    const orders = await this.repository.listOrders(userId);
    return Promise.all(orders.map((order) => this.details(order.id, userId)));
  }

  async details(orderId: string, userId: string): Promise<OrderDetailsResponse> {
    const order = await this.requireOrder(orderId);
    if (order.buyerId !== userId && order.sellerId !== userId) {
      throw new ForbiddenError("Only an order party may view this order");
    }
    return {
      order,
      escrow: (await this.repository.findEscrow(orderId)) ?? null,
      transitions: await this.repository.listTransitions(orderId),
      blockedByReconciliation:
        await this.repository.hasUnresolvedMismatch(orderId),
    };
  }

  /** Everything the escrow boundary needs to act on an order. */
  private chainInput(
    order: OrderDTO,
    escrow: EscrowDTO | null,
    transition: PaymentTransition,
    actorUserId: string,
    options: { arbiter?: boolean } = {},
  ): ChainTransitionInput {
    return {
      orderId: order.id,
      transition,
      amount: order.amount.amount,
      currency: order.amount.currency,
      buyerId: order.buyerId,
      sellerId: order.sellerId,
      contractId: escrow?.contractId ?? null,
      arbiter: options.arbiter ?? false,
      actorUserId,
    };
  }

  /**
   * Custody preconditions for a transition that touches the contract. These
   * mirror the contract's own guards so a caller gets a clear 409 instead of an
   * opaque simulation failure — and, for a lock, so we never deploy custody for
   * an order that already has funded custody.
   */
  private assertChainPreconditions(
    order: OrderDTO,
    escrow: EscrowDTO | null,
    transition: PaymentTransition,
  ): void {
    if (transition === PaymentTransition.Lock) {
      this.assertState(order, PaymentTransition.Lock);
      if (escrow && escrow.state !== EscrowState.Pending) {
        throw new ConflictError(
          `Escrow for order ${order.id} is already ${escrow.state}`,
        );
      }
      return;
    }

    if (!escrow || !escrow.contractId) {
      throw new ConflictError(
        `Order ${order.id} has no escrow contract yet; lock it first`,
      );
    }
    if (transition === PaymentTransition.Confirm) {
      this.assertState(order, PaymentTransition.Confirm);
      if (escrow.state !== EscrowState.Locked) {
        throw new ConflictError(
          `Only a locked escrow can be confirmed (currently ${escrow.state})`,
        );
      }
      return;
    }
    if (transition === PaymentTransition.Dispute) {
      if (escrow.state !== EscrowState.Locked) {
        throw new ConflictError(
          `Only a locked escrow can be disputed (currently ${escrow.state})`,
        );
      }
      return;
    }
    if (
      transition === PaymentTransition.Release ||
      transition === PaymentTransition.Refund
    ) {
      // Reached only when settlement is signed by an external arbiter, which
      // covers both the happy path and dispute resolution — so the status rule
      // is the union of what `transition()` and `settleDisputedOrder()` accept
      // rather than either alone.
      const settleable: readonly OrderStatus[] =
        transition === PaymentTransition.Release
          ? [OrderStatus.Confirmed, OrderStatus.Disputed]
          : [OrderStatus.Locked, OrderStatus.Confirmed, OrderStatus.Disputed];
      if (!settleable.includes(order.status)) {
        throw new ConflictError(
          `Cannot ${transition} an order in ${order.status} status`,
        );
      }
      // Mirrors the contract: `release` accepts `Disputed` or a buyer
      // confirmation, `refund` accepts either.
      if (!OPEN_ESCROW_STATES.includes(escrow.state)) {
        throw new ConflictError(
          `Cannot ${transition} an escrow that is ${escrow.state}`,
        );
      }
    }
  }

  private async assertNotBlocked(orderId: string): Promise<void> {
    if (await this.repository.hasUnresolvedMismatch(orderId)) {
      throw new ConflictError(
        "Order is blocked until its ledger-to-chain mismatch is resolved",
      );
    }
  }

  private async commit(
    order: OrderDTO,
    currentEscrow: EscrowDTO | null,
    transition: FinancialTransition,
    actorId: string,
    options: {
      arbiter?: boolean;
      ledger?: LedgerTransactionInput;
      /** Receipt from an already-submitted wallet-signed transaction. */
      chain?: ChainReceipt;
    } = {},
  ): Promise<OrderMutationResponse> {
    const chain =
      options.chain ??
      (await this.gateway.submitTransition(
        this.chainInput(order, currentEscrow, transition, actorId, {
          arbiter: options.arbiter,
        }),
      ));

    let escrow = currentEscrow;
    if (transition === PaymentTransition.Lock) {
      const now = nowIso();
      escrow = {
        // Reuse the record created when custody was deployed, so the contract
        // id and its history survive the lock rather than being replaced.
        id: currentEscrow?.id ?? randomUUID(),
        orderId: order.id,
        contractId: chain.contractId ?? currentEscrow?.contractId ?? null,
        state: EscrowState.Locked,
        createdAt: currentEscrow?.createdAt ?? now,
        updatedAt: now,
      };
    } else if (escrow && transition === PaymentTransition.Release) {
      escrow = {
        ...escrow,
        state: EscrowState.Released,
        updatedAt: new Date().toISOString(),
      };
    } else if (escrow && transition === PaymentTransition.Refund) {
      escrow = {
        ...escrow,
        state: EscrowState.Refunded,
        updatedAt: new Date().toISOString(),
      };
    }

    const persistedTransition = await this.repository.commitTransition({
      order,
      escrow,
      actorId,
      chain,
      ledger: options.ledger ?? this.ledgerPosting(order, transition),
    });
    await this.audit.append({
      actor: `user:${actorId}`,
      action: `payment.${transition}`,
      entity: "order",
      entityId: order.id,
      metadata: {
        orderStatus: order.status,
        transitionId: persistedTransition.id,
        ledgerTransactionId: persistedTransition.ledgerTransaction.id,
        stellarTransactionId: persistedTransition.stellarTransaction.id,
      },
    });

    // Phase 5: Trigger RWA payout distribution on escrow release
    if (transition === PaymentTransition.Release && this.rwa) {
      await this.triggerRwaPayout(order, transition, actorId);
    }

    return { order, escrow, transition: persistedTransition };
  }

  /**
   * Trigger RWA payout distribution for orders linked to tokenizations.
   * This is called automatically when an escrow is released (buyer payment confirmed).
   */
  private async triggerRwaPayout(
    order: OrderDTO,
    transition: PaymentTransition,
    actorId: string,
  ): Promise<void> {
    if (!this.rwa) return;

    try {
      // Check if this order has a linked tokenization
      const tokenizations = await this.rwa.listTokenizations({
        linkedOrderId: order.id,
      });

      if (tokenizations.length === 0) {
        // No tokenization linked to this order, skip payout
        return;
      }

      if (tokenizations.length > 1) {
        logger.warn(
          `Order ${order.id} has multiple tokenizations (${tokenizations.length}). Only distributing for the first.`,
        );
      }

      const tokenization = tokenizations[0];
      if (!tokenization) {
        logger.warn(`No tokenization found for order ${order.id}`);
        return;
      }

      const payoutAmount = BigInt(order.amount.amount);
      const payoutCurrency = order.amount.currency;

      logger.info(
        `Triggering RWA payout distribution for tokenization ${tokenization.id} ` +
        `(order ${order.id}, amount ${payoutAmount} ${payoutCurrency})`,
      );

      // Distribute payout to all token holders
      await this.rwa.distributePayout(
        tokenization.id,
        order.id,
        transition,
        payoutAmount,
        payoutCurrency,
        {
          userId: actorId,
          roles: ["system"], // System-triggered payout
        },
      );

      logger.info(
        `RWA payout distribution completed for tokenization ${tokenization.id}`,
      );
    } catch (error) {
      // Log but don't fail the entire payment release if RWA payout fails
      // The payout can be retried manually via the RWA API
      logger.error(
        `Failed to trigger RWA payout for order ${order.id}: ${error}`,
      );
      await this.audit.append({
        actor: `user:${actorId}`,
        action: "rwa.payout_failed",
        entity: "order",
        entityId: order.id,
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private ledgerPosting(
    order: OrderDTO,
    transition: FinancialTransition,
  ): LedgerTransactionInput {
    const amount = order.amount.amount;
    const currency = order.amount.currency;
    const entry = (
      accountId: string,
      direction: typeof EntryDirection.Debit | typeof EntryDirection.Credit,
    ) => ({ accountId, direction, amount, currency });

    const entries = (() => {
      switch (transition) {
        case PaymentTransition.Create:
          return [
            entry(COMMITMENT_ASSET, EntryDirection.Debit),
            entry(COMMITMENT_LIABILITY, EntryDirection.Credit),
          ];
        case PaymentTransition.Accept:
          return [
            entry(COMMITMENT_LIABILITY, EntryDirection.Debit),
            entry(COMMITMENT_ASSET, EntryDirection.Credit),
          ];
        case PaymentTransition.Deposit:
          return [
            entry(CASH_CLEARING, EntryDirection.Debit),
            entry(ESCROW_HOLDING, EntryDirection.Credit),
          ];
        case PaymentTransition.Lock:
          return [
            entry(CONTRACT_CUSTODY, EntryDirection.Debit),
            entry(CASH_CLEARING, EntryDirection.Credit),
          ];
        case PaymentTransition.Confirm:
          return [
            entry(DELIVERY_ASSET, EntryDirection.Debit),
            entry(DELIVERY_LIABILITY, EntryDirection.Credit),
          ];
        case PaymentTransition.Release:
          return [
            entry(ESCROW_HOLDING, EntryDirection.Debit),
            entry(CONTRACT_CUSTODY, EntryDirection.Credit),
            entry(DELIVERY_LIABILITY, EntryDirection.Debit),
            entry(DELIVERY_ASSET, EntryDirection.Credit),
          ];
        case PaymentTransition.Refund:
          return [
            entry(ESCROW_HOLDING, EntryDirection.Debit),
            entry(CONTRACT_CUSTODY, EntryDirection.Credit),
          ];
      }
    })();

    return {
      referenceId: `order:${order.id}:${transition}`,
      description: `Order ${transition} (${order.id})`,
      entries,
    };
  }

  private authorize(
    order: OrderDTO,
    transition: PaymentTransition,
    actor: PaymentActor,
  ): void {
    if (transition === PaymentTransition.Accept && actor.userId !== order.sellerId) {
      throw new ForbiddenError("Only the seller may accept this order");
    }
    const buyerTransitions: readonly PaymentTransition[] = [
      PaymentTransition.Deposit,
      PaymentTransition.Lock,
      PaymentTransition.Confirm,
      PaymentTransition.Release,
    ];
    if (
      buyerTransitions.includes(transition) &&
      actor.userId !== order.buyerId &&
      // A release is the buyer's call, but the *signature* may belong to an
      // external arbiter account. Someone has to assemble that transaction and
      // carry it to the key holders, and compliance is who operates that key.
      !(
        transition === PaymentTransition.Release &&
        actor.roles.includes("compliance")
      )
    ) {
      throw new ForbiddenError("Only the buyer may advance this payment");
    }
    if (
      transition === PaymentTransition.Refund &&
      !actor.roles.includes("compliance")
    ) {
      throw new ForbiddenError("Refund requires an authorized arbiter");
    }
    // Either counterparty may dispute their own deal — and only their own.
    // The contract enforces the same rule, so letting a stranger past here
    // would only produce a failed simulation after they had already signed.
    if (
      transition === PaymentTransition.Dispute &&
      actor.userId !== order.buyerId &&
      actor.userId !== order.sellerId
    ) {
      throw new ForbiddenError("Only a party to this order may dispute it");
    }
  }

  private assertState(order: OrderDTO, transition: FinancialTransition): void {
    const expected = EXPECTED_STATUS[transition];
    const allowed = Array.isArray(expected) ? expected : [expected];
    if (!allowed.includes(order.status)) {
      throw new ConflictError(
        `Cannot ${transition} an order in ${order.status} status`,
      );
    }
  }

  private async requireOrder(orderId: string): Promise<OrderDTO> {
    const order = await this.repository.findOrder(orderId);
    if (!order) throw new NotFoundError("Order not found");
    return order;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** The two transitions that move funds out of custody. */
function isSettlement(
  transition: PaymentTransition,
): transition is typeof PaymentTransition.Release | typeof PaymentTransition.Refund {
  return (
    transition === PaymentTransition.Release ||
    transition === PaymentTransition.Refund
  );
}

/**
 * The balanced posting for settling a *disputed* escrow.
 *
 * Funds move out of escrow holding into contract custody in one transaction.
 * The outcome (release→seller vs refund→buyer) is recorded by the transition
 * type and the audit trail, so both use the same core legs — which avoids
 * reversing delivery-confirmation entries that never posted when the escrow
 * being settled was never confirmed.
 *
 * Shared by the single-call arbiter path and the external-arbiter
 * prepare/submit path, so the books do not depend on which key signed.
 */
function disputeSettlementLedger(
  order: OrderDTO,
  transition: PaymentTransition,
): LedgerTransactionInput {
  return {
    referenceId: `dispute-settle:${order.id}:${transition}`,
    description: `Dispute-authorized ${transition} (${order.id})`,
    entries: [
      {
        accountId: ESCROW_HOLDING,
        direction: EntryDirection.Debit,
        amount: order.amount.amount,
        currency: order.amount.currency,
      },
      {
        accountId: CONTRACT_CUSTODY,
        direction: EntryDirection.Credit,
        amount: order.amount.amount,
        currency: order.amount.currency,
      },
    ],
  };
}
