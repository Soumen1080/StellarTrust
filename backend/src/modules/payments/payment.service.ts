import { randomUUID } from "node:crypto";
import {
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
} from "@stellartrust/shared";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../lib/errors.js";
import type { AuditRepository } from "../audit/audit.repository.js";
import type { EscrowGateway } from "../escrow/escrow.gateway.js";
import type { PaymentRepository } from "./payment.repository.js";
import type { RwaService } from "../rwa/rwa.service.js";
import { logger } from "../../lib/logger.js";

const COMMITMENT_ASSET = "10000000-0000-4000-8000-000000000001";
const COMMITMENT_LIABILITY = "20000000-0000-4000-8000-000000000002";
const CASH_CLEARING = "30000000-0000-4000-8000-000000000003";
const ESCROW_HOLDING = "40000000-0000-4000-8000-000000000004";
const CONTRACT_CUSTODY = "50000000-0000-4000-8000-000000000005";
const DELIVERY_ASSET = "60000000-0000-4000-8000-000000000006";
const DELIVERY_LIABILITY = "70000000-0000-4000-8000-000000000007";

const EXPECTED_STATUS: Record<PaymentTransition, OrderStatus | readonly OrderStatus[]> = {
  [PaymentTransition.Create]: OrderStatus.Created,
  [PaymentTransition.Accept]: OrderStatus.Created,
  [PaymentTransition.Deposit]: OrderStatus.Accepted,
  [PaymentTransition.Lock]: OrderStatus.Deposited,
  [PaymentTransition.Confirm]: OrderStatus.Locked,
  [PaymentTransition.Release]: OrderStatus.Confirmed,
  [PaymentTransition.Refund]: [OrderStatus.Locked, OrderStatus.Confirmed],
};

const NEXT_STATUS: Record<PaymentTransition, OrderStatus> = {
  [PaymentTransition.Create]: OrderStatus.Created,
  [PaymentTransition.Accept]: OrderStatus.Accepted,
  [PaymentTransition.Deposit]: OrderStatus.Deposited,
  [PaymentTransition.Lock]: OrderStatus.Locked,
  [PaymentTransition.Confirm]: OrderStatus.Confirmed,
  [PaymentTransition.Release]: OrderStatus.Released,
  [PaymentTransition.Refund]: OrderStatus.Refunded,
};

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

  async transition(
    orderId: string,
    requested: Exclude<PaymentTransition, "create">,
    actor: PaymentActor,
  ): Promise<OrderMutationResponse> {
    const current = await this.requireOrder(orderId);
    if (await this.repository.hasUnresolvedMismatch(orderId)) {
      throw new ConflictError(
        "Order is blocked until its ledger-to-chain mismatch is resolved",
      );
    }
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

    const current = await this.requireOrder(orderId);
    if (await this.repository.hasUnresolvedMismatch(orderId)) {
      throw new ConflictError(
        "Order is blocked until its ledger-to-chain mismatch is resolved",
      );
    }
    const settleable: readonly OrderStatus[] = [
      OrderStatus.Locked,
      OrderStatus.Confirmed,
    ];
    if (!settleable.includes(current.status)) {
      throw new ConflictError(
        `Cannot settle a dispute for an order in ${current.status} status`,
      );
    }
    const escrow = (await this.repository.findEscrow(orderId)) ?? null;
    if (!escrow || escrow.state !== EscrowState.Locked) {
      throw new ConflictError("Dispute settlement requires a locked escrow");
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

    // Dispute settlement moves funds out of escrow holding into contract
    // custody in one balanced transaction. The outcome (release→seller vs
    // refund→buyer) is recorded by the transition type + audit, so both use the
    // same balanced core legs (avoids reversing delivery-confirmation entries
    // that never posted when releasing a still-locked escrow).
    const ledger: LedgerTransactionInput = {
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

    return this.commit(order, escrow, transition, actor.userId, {
      arbiter: true,
      ledger,
    });
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

  private async commit(
    order: OrderDTO,
    currentEscrow: EscrowDTO | null,
    transition: PaymentTransition,
    actorId: string,
    options: { arbiter?: boolean; ledger?: LedgerTransactionInput } = {},
  ): Promise<OrderMutationResponse> {
    const chain = await this.gateway.submitTransition({
      orderId: order.id,
      transition,
      amount: order.amount.amount,
      currency: order.amount.currency,
      buyerId: order.buyerId,
      sellerId: order.sellerId,
      contractId: currentEscrow?.contractId ?? null,
      arbiter: options.arbiter ?? false,
    });

    let escrow = currentEscrow;
    if (transition === PaymentTransition.Lock) {
      const now = new Date().toISOString();
      escrow = {
        id: randomUUID(),
        orderId: order.id,
        contractId: chain.contractId,
        state: EscrowState.Locked,
        createdAt: now,
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
    transition: PaymentTransition,
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
      actor.userId !== order.buyerId
    ) {
      throw new ForbiddenError("Only the buyer may advance this payment");
    }
    if (
      transition === PaymentTransition.Refund &&
      !actor.roles.includes("compliance")
    ) {
      throw new ForbiddenError("Refund requires an authorized arbiter");
    }
  }

  private assertState(order: OrderDTO, transition: PaymentTransition): void {
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
