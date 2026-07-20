import { randomUUID } from "node:crypto";
import {
  EntryDirection,
  EscrowState,
  OrderStatus,
  PaymentTransition,
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

const CLEARING_ACCOUNT = "10000000-0000-4000-8000-000000000001";
const ESCROW_ACCOUNT = "20000000-0000-4000-8000-000000000002";

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

export class PaymentService {
  constructor(
    private readonly repository: PaymentRepository,
    private readonly gateway: EscrowGateway,
    private readonly audit: AuditRepository,
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
    return this.commit(order, currentEscrow, requested, actor.userId);
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
  ): Promise<OrderMutationResponse> {
    const chain = await this.gateway.submitTransition({
      orderId: order.id,
      transition,
      amount: order.amount.amount,
      currency: order.amount.currency,
      buyerId: order.buyerId,
      sellerId: order.sellerId,
      contractId: currentEscrow?.contractId ?? null,
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
      ledger: this.ledgerPosting(order, transition),
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
    return { order, escrow, transition: persistedTransition };
  }

  private ledgerPosting(
    order: OrderDTO,
    transition: PaymentTransition,
  ): LedgerTransactionInput {
    return {
      referenceId: `order:${order.id}:${transition}`,
      description: `Order ${transition} (${order.id})`,
      entries: [
        {
          accountId: CLEARING_ACCOUNT,
          direction: EntryDirection.Debit,
          amount: order.amount.amount,
          currency: order.amount.currency,
        },
        {
          accountId: ESCROW_ACCOUNT,
          direction: EntryDirection.Credit,
          amount: order.amount.amount,
          currency: order.amount.currency,
        },
      ],
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
    if (
      [
        PaymentTransition.Deposit,
        PaymentTransition.Lock,
        PaymentTransition.Confirm,
        PaymentTransition.Release,
      ].includes(transition) &&
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
