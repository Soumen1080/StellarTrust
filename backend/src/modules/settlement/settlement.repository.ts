/**
 * Settlement persistence boundary (Phase 3).
 *
 * Local atomic store mirroring the payments repository guarantees: a settlement
 * transition never exists without its balanced ledger transaction and its
 * linked anchor transfer and/or Stellar (path payment) record. Staging/
 * production replaces this with a Postgres/Redis-backed adapter.
 */
import { randomUUID } from "node:crypto";
import {
  ChainTxStatus,
  type AnchorTransferDTO,
  type LedgerTransactionDTO,
  type LedgerTransactionInput,
  type SettlementDTO,
  type SettlementQuoteDTO,
  type SettlementReconciliationMismatchDTO,
  type SettlementTransition,
  type SettlementTransitionDTO,
  type StellarTxRecord,
} from "@stellartrust/shared";
import { ConflictError } from "../../lib/errors.js";
import { assertBalanced } from "../ledger/ledger.balance.js";
import type { LiquidityReceipt } from "./liquidity.gateway.js";

export interface SettlementTransitionCommit {
  settlement: SettlementDTO;
  transition: SettlementTransition;
  actorId: string;
  ledger: LedgerTransactionInput;
  anchorTransfer: AnchorTransferDTO | null;
  chain: LiquidityReceipt | null;
}

export interface SettlementRepository {
  saveQuote(quote: SettlementQuoteDTO): Promise<void>;
  findQuote(quoteId: string): Promise<SettlementQuoteDTO | undefined>;
  /**
   * Upsert a settlement outside a financial transition — used to record the
   * REQUEST before the first leg runs and the terminal failure state after a
   * leg throws. Never used to change money amounts: those only move through
   * {@link SettlementRepository.commitTransition}, which carries the ledger.
   */
  saveSettlement(settlement: SettlementDTO): Promise<void>;
  findSettlement(settlementId: string): Promise<SettlementDTO | undefined>;
  findSettlementByQuote(quoteId: string): Promise<SettlementDTO | undefined>;
  /**
   * The settlement funding an order, if one exists (plane.md §2.1).
   *
   * Optional on the interface so existing implementations stay valid; the
   * partial unique index in migration 0017 is what actually enforces one
   * settlement per order under concurrency.
   */
  findSettlementByOrder?(orderId: string): Promise<SettlementDTO | undefined>;
  listSettlements(userId: string): Promise<SettlementDTO[]>;
  listTransitions(settlementId?: string): Promise<SettlementTransitionDTO[]>;
  commitTransition(
    input: SettlementTransitionCommit,
  ): Promise<SettlementTransitionDTO>;
  hasUnresolvedMismatch(settlementId: string): Promise<boolean>;
  replaceMismatches(
    mismatches: SettlementReconciliationMismatchDTO[],
  ): Promise<void>;
  listUnresolvedMismatches(): Promise<SettlementReconciliationMismatchDTO[]>;
}

export class InMemorySettlementRepository implements SettlementRepository {
  private readonly quotes = new Map<string, SettlementQuoteDTO>();
  private readonly settlements = new Map<string, SettlementDTO>();
  private readonly transitions = new Map<string, SettlementTransitionDTO>();
  private readonly references = new Set<string>();
  private mismatches: SettlementReconciliationMismatchDTO[] = [];

  async saveQuote(quote: SettlementQuoteDTO): Promise<void> {
    this.quotes.set(quote.id, quote);
  }

  async findQuote(quoteId: string): Promise<SettlementQuoteDTO | undefined> {
    return this.quotes.get(quoteId);
  }

  async saveSettlement(settlement: SettlementDTO): Promise<void> {
    this.settlements.set(settlement.id, settlement);
  }

  async findSettlement(
    settlementId: string,
  ): Promise<SettlementDTO | undefined> {
    return this.settlements.get(settlementId);
  }

  async findSettlementByQuote(
    quoteId: string,
  ): Promise<SettlementDTO | undefined> {
    return [...this.settlements.values()].find(
      (settlement) => settlement.quoteId === quoteId,
    );
  }

  async findSettlementByOrder(
    orderId: string,
  ): Promise<SettlementDTO | undefined> {
    return [...this.settlements.values()].find(
      (settlement) => settlement.orderId === orderId,
    );
  }

  async listSettlements(userId: string): Promise<SettlementDTO[]> {
    return [...this.settlements.values()]
      .filter((settlement) => settlement.userId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async listTransitions(
    settlementId?: string,
  ): Promise<SettlementTransitionDTO[]> {
    return [...this.transitions.values()]
      .filter((item) => !settlementId || item.settlementId === settlementId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async commitTransition(
    input: SettlementTransitionCommit,
  ): Promise<SettlementTransitionDTO> {
    // Hard gate: never persist an unbalanced ledger set (Golden Rule #1).
    assertBalanced(input.ledger.entries);
    if (this.references.has(input.ledger.referenceId)) {
      throw new ConflictError("Settlement transition has already been recorded");
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

    const stellarTransaction: StellarTxRecord | null = input.chain
      ? {
          id: randomUUID(),
          hash: input.chain.hash,
          type: input.chain.type,
          status: input.chain.status ?? ChainTxStatus.Pending,
          ledgerTransactionId: ledgerId,
          createdAt: now,
        }
      : null;

    const transition: SettlementTransitionDTO = {
      id: randomUUID(),
      settlementId: input.settlement.id,
      transition: input.transition,
      ledgerTransaction,
      anchorTransfer: input.anchorTransfer,
      stellarTransaction,
      createdAt: now,
    };

    // Single commit point after every invariant has passed.
    this.settlements.set(input.settlement.id, input.settlement);
    this.transitions.set(transition.id, transition);
    this.references.add(input.ledger.referenceId);
    return transition;
  }

  async hasUnresolvedMismatch(settlementId: string): Promise<boolean> {
    return this.mismatches.some(
      (mismatch) =>
        mismatch.settlementId === settlementId && !mismatch.resolvedAt,
    );
  }

  async replaceMismatches(
    mismatches: SettlementReconciliationMismatchDTO[],
  ): Promise<void> {
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

  async listUnresolvedMismatches(): Promise<
    SettlementReconciliationMismatchDTO[]
  > {
    return this.mismatches.filter((item) => !item.resolvedAt);
  }
}
