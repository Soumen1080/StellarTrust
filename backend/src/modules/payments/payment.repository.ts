import { randomUUID } from "node:crypto";
import {
  ChainTxStatus,
  type EscrowDTO,
  type LedgerTransactionDTO,
  type LedgerTransactionInput,
  type OrderDTO,
  type PaymentTransitionDTO,
  type ReconciliationMismatchDTO,
  type StellarTxRecord,
} from "@stellartrust/shared";
import { ConflictError } from "../../lib/errors.js";
import { assertBalanced } from "../ledger/ledger.balance.js";
import type { ChainReceipt } from "../escrow/escrow.gateway.js";

export interface FinancialTransitionCommit {
  order: OrderDTO;
  escrow: EscrowDTO | null;
  actorId: string;
  ledger: LedgerTransactionInput;
  chain: ChainReceipt;
}

export interface PaymentRepository {
  findOrder(orderId: string): Promise<OrderDTO | undefined>;
  listOrders(userId: string): Promise<OrderDTO[]>;
  findEscrow(orderId: string): Promise<EscrowDTO | undefined>;
  listTransitions(orderId?: string): Promise<PaymentTransitionDTO[]>;
  commitTransition(input: FinancialTransitionCommit): Promise<PaymentTransitionDTO>;
  hasUnresolvedMismatch(orderId: string): Promise<boolean>;
  replaceMismatches(mismatches: ReconciliationMismatchDTO[]): Promise<void>;
  listUnresolvedMismatches(): Promise<ReconciliationMismatchDTO[]>;
}

/**
 * Local atomic financial store. Objects are assembled and validated first, then
 * committed together so an order state can never exist without its balanced
 * ledger transaction and linked Stellar transaction record.
 */
export class InMemoryPaymentRepository implements PaymentRepository {
  private readonly orders = new Map<string, OrderDTO>();
  private readonly escrows = new Map<string, EscrowDTO>();
  private readonly transitions = new Map<string, PaymentTransitionDTO>();
  private readonly references = new Set<string>();
  private mismatches: ReconciliationMismatchDTO[] = [];

  async findOrder(orderId: string): Promise<OrderDTO | undefined> {
    return this.orders.get(orderId);
  }

  async listOrders(userId: string): Promise<OrderDTO[]> {
    return [...this.orders.values()]
      .filter((order) => order.buyerId === userId || order.sellerId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async findEscrow(orderId: string): Promise<EscrowDTO | undefined> {
    return this.escrows.get(orderId);
  }

  async listTransitions(orderId?: string): Promise<PaymentTransitionDTO[]> {
    return [...this.transitions.values()]
      .filter((transition) => !orderId || transition.orderId === orderId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async commitTransition(input: FinancialTransitionCommit): Promise<PaymentTransitionDTO> {
    assertBalanced(input.ledger.entries);
    if (this.references.has(input.ledger.referenceId)) {
      throw new ConflictError("Financial transition has already been recorded");
    }

    const now = new Date().toISOString();
    const ledgerId = randomUUID();
    const ledgerTransaction: LedgerTransactionDTO = {
      id: ledgerId,
      referenceId: input.ledger.referenceId,
      description: input.ledger.description,
      createdAt: now,
      entries: input.ledger.entries.map((entry) => ({
        ...entry,
        id: randomUUID(),
        transactionId: ledgerId,
        createdAt: now,
      })),
    };
    const stellarTransaction: StellarTxRecord = {
      id: randomUUID(),
      hash: input.chain.hash,
      type: input.chain.type,
      status: input.chain.status ?? ChainTxStatus.Pending,
      ledgerTransactionId: ledgerId,
      createdAt: now,
    };
    const transition: PaymentTransitionDTO = {
      id: randomUUID(),
      orderId: input.order.id,
      transition: input.chain.transition,
      actorId: input.actorId,
      ledgerTransaction,
      stellarTransaction,
      createdAt: now,
    };

    // Single commit point after every invariant has passed.
    this.orders.set(input.order.id, input.order);
    if (input.escrow) this.escrows.set(input.order.id, input.escrow);
    this.transitions.set(transition.id, transition);
    this.references.add(input.ledger.referenceId);
    return transition;
  }

  async hasUnresolvedMismatch(orderId: string): Promise<boolean> {
    return this.mismatches.some(
      (mismatch) => mismatch.orderId === orderId && !mismatch.resolvedAt,
    );
  }

  async replaceMismatches(mismatches: ReconciliationMismatchDTO[]): Promise<void> {
    const now = new Date().toISOString();
    const activeKeys = new Set(mismatches.map((item) => item.transitionId));
    const resolved = this.mismatches.map((item) =>
      !item.resolvedAt && !activeKeys.has(item.transitionId)
        ? { ...item, resolvedAt: now }
        : item,
    );
    const existing = new Set(resolved.map((item) => item.transitionId));
    this.mismatches = [
      ...resolved,
      ...mismatches.filter((item) => !existing.has(item.transitionId)),
    ];
  }

  async listUnresolvedMismatches(): Promise<ReconciliationMismatchDTO[]> {
    return this.mismatches.filter((item) => !item.resolvedAt);
  }
}
