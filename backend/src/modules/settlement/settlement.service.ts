/**
 * Settlement service (Phase 3 — Cross-Border Settlement).
 *
 * Orchestrates a cross-border transfer: quote a corridor (routing over path
 * payments + AMM), then execute deposit → convert → payout. Every step writes a
 * balanced double-entry ledger transaction linked to an anchor transfer and/or
 * a Stellar (path payment) record, plus an append-only audit event. The ledger
 * — not the anchor or the chain — is the system of record (Rules.md #1). Money
 * math is integer minor units with BigInt (Decision D12: no floats).
 */
import { randomUUID } from "node:crypto";
import {
  EntryDirection,
  SettlementStatus,
  SettlementTransition,
  settlementExecuteInputSchema,
  settlementQuoteInputSchema,
  type CorridorDTO,
  type CurrencyCode,
  type LedgerEntryInput,
  type LedgerTransactionInput,
  type SettlementDetailsResponse,
  type SettlementDTO,
  type SettlementExecuteInput,
  type SettlementMutationResponse,
  type SettlementQuoteDTO,
  type SettlementQuoteInput,
  type SettlementRouteDTO,
} from "@stellartrust/shared";
import { config } from "../../config/index.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../lib/errors.js";
import type { AuditRepository } from "../audit/audit.repository.js";
import type { AnchorGateway } from "./anchor.gateway.js";
import { findCorridor, findCorridorById } from "./corridors.js";
import type { LiquidityGateway } from "./liquidity.gateway.js";
import { RoutingService } from "./routing.service.js";
import type { SettlementRepository } from "./settlement.repository.js";

// Fixed ledger account ids for the settlement bounded context (mirrors the
// payments module convention). Currency lives on each entry, not the account.
const SOURCE_ANCHOR_CLEARING = "a0000000-0000-4000-8000-000000000001";
const USER_SOURCE_LIABILITY = "a0000000-0000-4000-8000-000000000002";
const FX_CONVERSION = "a0000000-0000-4000-8000-000000000003";
const USER_DEST_LIABILITY = "a0000000-0000-4000-8000-000000000004";
const DEST_ANCHOR_CLEARING = "a0000000-0000-4000-8000-000000000005";
const LIQUIDITY_FEE_REVENUE = "a0000000-0000-4000-8000-000000000006";

export interface SettlementActor {
  userId: string;
  roles: string[];
}

export class SettlementService {
  private readonly routing = new RoutingService();

  constructor(
    private readonly repository: SettlementRepository,
    private readonly liquidity: LiquidityGateway,
    private readonly anchor: AnchorGateway,
    private readonly audit: AuditRepository,
  ) {}

  /** Quote a corridor: route over available liquidity, apply constraints. */
  async quote(input: SettlementQuoteInput): Promise<SettlementQuoteDTO> {
    const parsed = settlementQuoteInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        "Invalid settlement quote request",
        parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    }

    const corridor = findCorridor(
      parsed.data.sourceCurrency,
      parsed.data.destinationCurrency,
    );
    if (!corridor) {
      throw new ValidationError(
        `No settlement corridor from ${parsed.data.sourceCurrency} to ${parsed.data.destinationCurrency}`,
      );
    }

    const maxSlippageBps =
      parsed.data.maxSlippageBps ?? config.SETTLEMENT_DEFAULT_MAX_SLIPPAGE_BPS;

    const candidates = await this.liquidity.quoteRoutes(
      corridor.sourceCurrency,
      corridor.destinationCurrency,
      parsed.data.sourceAmount,
    );
    const { best, ranked } = this.routing.select(candidates, {
      maxSlippageBps,
      maxFeeAmount: parsed.data.maxFeeAmount,
    });

    const now = new Date();
    const quote: SettlementQuoteDTO = {
      id: randomUUID(),
      corridorId: corridor.id,
      source: {
        amount: parsed.data.sourceAmount,
        currency: corridor.sourceCurrency,
      },
      route: best,
      consideredRoutes: ranked,
      maxSlippageBps,
      maxFeeAmount: parsed.data.maxFeeAmount ?? null,
      expiresAt: new Date(
        now.getTime() + config.SETTLEMENT_QUOTE_TTL_SECONDS * 1000,
      ).toISOString(),
      createdAt: now.toISOString(),
    };
    await this.repository.saveQuote(quote);
    return quote;
  }

  /**
   * Execute a previously issued quote end-to-end. Idempotent: re-executing the
   * same quote returns the existing settlement rather than moving funds twice.
   */
  async execute(
    actor: SettlementActor,
    input: SettlementExecuteInput,
  ): Promise<SettlementMutationResponse> {
    const parsed = settlementExecuteInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        "Invalid settlement execution request",
        parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    }

    // Idempotency: one settlement per quote (in addition to the route guard).
    const existing = await this.repository.findSettlementByQuote(
      parsed.data.quoteId,
    );
    if (existing) {
      if (existing.userId !== actor.userId) {
        throw new ForbiddenError("This quote belongs to another user");
      }
      return {
        settlement: existing,
        transitions: await this.repository.listTransitions(existing.id),
      };
    }

    const quote = await this.repository.findQuote(parsed.data.quoteId);
    if (!quote) throw new NotFoundError("Settlement quote not found");
    if (quote.expiresAt <= new Date().toISOString()) {
      throw new ConflictError("Settlement quote has expired; request a new quote");
    }

    const corridor = findCorridorById(quote.corridorId);
    if (!corridor) {
      throw new ValidationError("Settlement corridor is no longer supported");
    }

    const route = quote.route;
    const now = new Date().toISOString();
    const settlement: SettlementDTO = {
      id: randomUUID(),
      userId: actor.userId,
      quoteId: quote.id,
      corridorId: corridor.id,
      status: SettlementStatus.DepositPending,
      source: quote.source,
      destination: route.destinationAmount,
      route,
      destinationReference: parsed.data.destinationReference,
      createdAt: now,
      updatedAt: now,
    };

    // SEP-12 KYC exchange with the anchor before any transfer. Only an opaque
    // customer id is retained — never raw documents/PII (Rules.md §7, D25).
    const registration = await this.anchor.registerCustomer(
      `${actor.userId}:${corridor.id}`,
    );

    const transitions = [
      await this.runDeposit(settlement, corridor, route, actor, registration.customerId),
      await this.runConvert(settlement, corridor, route, actor),
      await this.runPayout(settlement, corridor, route, actor, registration.customerId),
    ];

    // The payout transition already persisted the Completed status; read it back
    // as the authoritative terminal snapshot.
    const completed =
      (await this.repository.findSettlement(settlement.id)) ?? {
        ...settlement,
        status: SettlementStatus.Completed,
        updatedAt: new Date().toISOString(),
      };

    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: "settlement.completed",
      entity: "settlement",
      entityId: settlement.id,
      metadata: {
        corridorId: corridor.id,
        routeType: route.type,
        sourceCurrency: route.source.currency,
        destinationCurrency: route.destinationAmount.currency,
        transitionCount: transitions.length,
      },
    });

    return {
      settlement: completed,
      transitions: await this.repository.listTransitions(settlement.id),
    };
  }

  async list(userId: string): Promise<SettlementDetailsResponse[]> {
    const settlements = await this.repository.listSettlements(userId);
    return Promise.all(
      settlements.map((settlement) => this.detailsFor(settlement, userId)),
    );
  }

  async details(
    settlementId: string,
    userId: string,
  ): Promise<SettlementDetailsResponse> {
    const settlement = await this.repository.findSettlement(settlementId);
    if (!settlement) throw new NotFoundError("Settlement not found");
    return this.detailsFor(settlement, userId);
  }

  private async detailsFor(
    settlement: SettlementDTO,
    userId: string,
  ): Promise<SettlementDetailsResponse> {
    if (settlement.userId !== userId) {
      throw new ForbiddenError("Only the settlement owner may view it");
    }
    return {
      settlement,
      transitions: await this.repository.listTransitions(settlement.id),
      blockedByReconciliation: await this.repository.hasUnresolvedMismatch(
        settlement.id,
      ),
    };
  }

  // ── Lifecycle steps ────────────────────────────────────────────────────────

  private async runDeposit(
    settlement: SettlementDTO,
    corridor: CorridorDTO,
    route: SettlementRouteDTO,
    actor: SettlementActor,
    customerId: string,
  ) {
    const amount = route.source.amount;
    const currency = route.source.currency;
    const transfer = await this.anchor.submitTransfer({
      kind: "deposit",
      protocol: corridor.anchorProtocol,
      amount,
      currency,
      customerId,
    });
    const snapshot: SettlementDTO = {
      ...settlement,
      status: SettlementStatus.Converting,
      updatedAt: new Date().toISOString(),
    };
    const transition = await this.repository.commitTransition({
      settlement: snapshot,
      transition: SettlementTransition.Deposit,
      actorId: actor.userId,
      anchorTransfer: transfer,
      chain: null,
      ledger: this.depositPosting(settlement.id, amount, currency),
    });
    await this.auditTransition(actor, settlement.id, transition.id, "deposit", {
      anchorReference: transfer.reference,
      currency,
    });
    return transition;
  }

  private async runConvert(
    settlement: SettlementDTO,
    corridor: CorridorDTO,
    route: SettlementRouteDTO,
    actor: SettlementActor,
  ) {
    const receipt = await this.liquidity.executeConversion(
      route,
      corridor.bridgeAsset,
    );
    const snapshot: SettlementDTO = {
      ...settlement,
      status: SettlementStatus.PayoutPending,
      updatedAt: new Date().toISOString(),
    };
    const transition = await this.repository.commitTransition({
      settlement: snapshot,
      transition: SettlementTransition.Convert,
      actorId: actor.userId,
      anchorTransfer: null,
      chain: receipt,
      ledger: this.convertPosting(settlement.id, route),
    });
    await this.auditTransition(actor, settlement.id, transition.id, "convert", {
      routeType: route.type,
      chainHash: receipt.hash,
    });
    return transition;
  }

  private async runPayout(
    settlement: SettlementDTO,
    corridor: CorridorDTO,
    route: SettlementRouteDTO,
    actor: SettlementActor,
    customerId: string,
  ) {
    const amount = route.destinationAmount.amount;
    const currency = route.destinationAmount.currency;
    const transfer = await this.anchor.submitTransfer({
      kind: "withdrawal",
      protocol: corridor.anchorProtocol,
      amount,
      currency,
      customerId,
    });
    const snapshot: SettlementDTO = {
      ...settlement,
      status: SettlementStatus.Completed,
      updatedAt: new Date().toISOString(),
    };
    const transition = await this.repository.commitTransition({
      settlement: snapshot,
      transition: SettlementTransition.Payout,
      actorId: actor.userId,
      anchorTransfer: transfer,
      chain: null,
      ledger: this.payoutPosting(settlement.id, amount, currency),
    });
    await this.auditTransition(actor, settlement.id, transition.id, "payout", {
      anchorReference: transfer.reference,
      currency,
    });
    return transition;
  }

  // ── Ledger postings (balanced per currency) ─────────────────────────────────

  private depositPosting(
    settlementId: string,
    amount: string,
    currency: CurrencyCode,
  ): LedgerTransactionInput {
    return {
      referenceId: `settlement:${settlementId}:deposit`,
      description: `Settlement deposit (${settlementId})`,
      entries: [
        { accountId: SOURCE_ANCHOR_CLEARING, direction: EntryDirection.Debit, amount, currency },
        { accountId: USER_SOURCE_LIABILITY, direction: EntryDirection.Credit, amount, currency },
      ],
    };
  }

  private convertPosting(
    settlementId: string,
    route: SettlementRouteDTO,
  ): LedgerTransactionInput {
    const source = route.source.currency;
    const dest = route.destinationAmount.currency;
    const sourceAmount = BigInt(route.source.amount);
    const fee = BigInt(route.fee.amount);
    const netSource = (sourceAmount - fee).toString();
    const destAmount = route.destinationAmount.amount;

    const entries: LedgerEntryInput[] = [
      // Source side balances in the source currency.
      { accountId: USER_SOURCE_LIABILITY, direction: EntryDirection.Debit, amount: route.source.amount, currency: source },
      { accountId: FX_CONVERSION, direction: EntryDirection.Credit, amount: netSource, currency: source },
    ];
    if (fee > 0n) {
      entries.push({
        accountId: LIQUIDITY_FEE_REVENUE,
        direction: EntryDirection.Credit,
        amount: route.fee.amount,
        currency: source,
      });
    } else {
      // Keep the source side balanced when no fee is charged.
      entries[1] = {
        accountId: FX_CONVERSION,
        direction: EntryDirection.Credit,
        amount: route.source.amount,
        currency: source,
      };
    }
    // Destination side balances in the destination currency.
    entries.push(
      { accountId: FX_CONVERSION, direction: EntryDirection.Debit, amount: destAmount, currency: dest },
      { accountId: USER_DEST_LIABILITY, direction: EntryDirection.Credit, amount: destAmount, currency: dest },
    );

    return {
      referenceId: `settlement:${settlementId}:convert`,
      description: `Settlement conversion ${source}->${dest} (${settlementId})`,
      entries,
    };
  }

  private payoutPosting(
    settlementId: string,
    amount: string,
    currency: CurrencyCode,
  ): LedgerTransactionInput {
    return {
      referenceId: `settlement:${settlementId}:payout`,
      description: `Settlement payout (${settlementId})`,
      entries: [
        { accountId: USER_DEST_LIABILITY, direction: EntryDirection.Debit, amount, currency },
        { accountId: DEST_ANCHOR_CLEARING, direction: EntryDirection.Credit, amount, currency },
      ],
    };
  }

  private async auditTransition(
    actor: SettlementActor,
    settlementId: string,
    transitionId: string,
    step: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: `settlement.${step}`,
      entity: "settlement",
      entityId: settlementId,
      metadata: { transitionId, ...metadata },
    });
  }
}
