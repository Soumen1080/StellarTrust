/**
 * Settlement service (Phase 3 — Cross-Border Settlement).
 *
 * Orchestrates a cross-border transfer: quote a corridor (routing over path
 * payments + AMM) for a specific LOCAL DELIVERY RAIL, then execute
 * deposit → convert → payout. Every step writes a balanced double-entry ledger
 * transaction linked to an anchor transfer and/or a Stellar (path payment)
 * record, plus an append-only audit event. The ledger — not the anchor or the
 * chain — is the system of record (Rules.md #1). Money math is integer minor
 * units with BigInt (Decision D12: no floats).
 *
 * The rail is part of the quote, not an afterthought: UPI, IMPS/NEFT, SEPA,
 * ACH/wire, and NIP each carry their own flat fee, clearing time, and
 * per-transaction cap, so the amount a beneficiary actually receives — and
 * whether the payout is deliverable at all — cannot be known without it.
 *
 * Beneficiary handles are validated with the schemes' own checksums, used for
 * the anchor call, and then dropped: only a masked form and a SHA-256
 * fingerprint are persisted (Rules.md §7, D25).
 */
import { createHash, randomUUID } from "node:crypto";
import {
  EntryDirection,
  maskAccountHolder,
  maskPayoutDestination,
  payoutFingerprintSource,
  PayoutFieldName,
  SettlementStatus,
  SettlementTransition,
  settlementExecuteInputSchema,
  settlementQuoteInputSchema,
  validatePayoutDestination,
  type CorridorDTO,
  type CurrencyCode,
  type LedgerEntryInput,
  type LedgerTransactionInput,
  type PayoutDestinationDTO,
  type PayoutRail,
  type PayoutRailSpec,
  type SettlementDetailsResponse,
  type SettlementDTO,
  type SettlementExecuteInput,
  type SettlementMutationResponse,
  type SettlementPayoutDTO,
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
import {
  SETTLEMENT_DEST_ANCHOR_CLEARING,
  SETTLEMENT_FX_CONVERSION,
  SETTLEMENT_LIQUIDITY_FEE_REVENUE,
  SETTLEMENT_PAYOUT_FEE_REVENUE,
  SETTLEMENT_SOURCE_ANCHOR_CLEARING,
  SETTLEMENT_USER_DEST_LIABILITY,
  SETTLEMENT_USER_SOURCE_LIABILITY,
} from "../ledger/system-accounts.js";
import type { AnchorGateway, AnchorPayoutInstruction } from "./anchor.gateway.js";
import {
  defaultRailFor,
  findCorridor,
  findCorridorById,
  railForCorridor,
} from "./corridors.js";
import type { LiquidityGateway } from "./liquidity.gateway.js";
import { RoutingService } from "./routing.service.js";
import type { SettlementRepository } from "./settlement.repository.js";

export interface SettlementActor {
  userId: string;
  roles: string[];
}

/** Normalized beneficiary fields — held only for the duration of one request. */
type NormalizedFields = Record<string, string>;

export class SettlementService {
  private readonly routing = new RoutingService();

  constructor(
    private readonly repository: SettlementRepository,
    private readonly liquidity: LiquidityGateway,
    private readonly anchor: AnchorGateway,
    private readonly audit: AuditRepository,
  ) {}

  /**
   * Quote a corridor for a delivery rail: route over available liquidity, apply
   * the caller's constraints, then subtract the rail fee and check the result
   * against the scheme's per-transaction limits. A quote that cannot be
   * delivered is rejected here rather than failing after the funds have already
   * converted on-chain.
   */
  async quote(
    actor: SettlementActor,
    input: SettlementQuoteInput,
  ): Promise<SettlementQuoteDTO> {
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

    const rail = this.resolveRail(corridor, parsed.data.payoutRail);
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

    const netDestination = this.netOfRailFee(best, rail, corridor);

    const now = new Date();
    const quote: SettlementQuoteDTO = {
      id: randomUUID(),
      userId: actor.userId,
      corridorId: corridor.id,
      source: {
        amount: parsed.data.sourceAmount,
        currency: corridor.sourceCurrency,
      },
      route: best,
      consideredRoutes: ranked,
      maxSlippageBps,
      maxFeeAmount: parsed.data.maxFeeAmount ?? null,
      payoutRail: rail.rail,
      payoutFee: {
        amount: rail.flatFeeAmount,
        currency: corridor.destinationCurrency,
      },
      netDestinationAmount: {
        amount: netDestination.toString(),
        currency: corridor.destinationCurrency,
      },
      totalEstimatedSeconds: best.estimatedSeconds + rail.estimatedSeconds,
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
    // A quote fixes a rate for its requester. Without this check anyone holding
    // the id could execute someone else's pricing against their own payout.
    if (quote.userId !== actor.userId) {
      throw new ForbiddenError("This quote belongs to another user");
    }
    if (quote.expiresAt <= new Date().toISOString()) {
      throw new ConflictError("Settlement quote has expired; request a new quote");
    }

    const corridor = findCorridorById(quote.corridorId);
    if (!corridor) {
      throw new ValidationError("Settlement corridor is no longer supported");
    }

    // The rail is priced into the quote, so the beneficiary handle must be for
    // that same rail — otherwise the fee and clearing time on the quote are
    // for a scheme that is not the one being paid.
    if (parsed.data.destination.rail !== quote.payoutRail) {
      throw new ValidationError(
        `This quote is priced for ${quote.payoutRail}; request a new quote to pay out over ${parsed.data.destination.rail}`,
        [{ path: "destination.rail", message: "rail does not match the quote" }],
      );
    }
    const rail = this.resolveRail(corridor, quote.payoutRail);

    const { destination, fields } = this.buildDestination(
      parsed.data.destination,
      rail,
    );

    const route = quote.route;
    // Re-check the limits against the quoted net amount. The quote already
    // passed them, but rail caps can change between quote and execution and
    // this is the last point before money moves.
    const netAmount = this.netOfRailFee(route, rail, corridor);

    const payout: SettlementPayoutDTO = {
      rail: rail.rail,
      network: rail.network,
      destination,
      fee: {
        amount: rail.flatFeeAmount,
        currency: corridor.destinationCurrency,
      },
      netAmount: {
        amount: netAmount.toString(),
        currency: corridor.destinationCurrency,
      },
      estimatedSeconds: rail.estimatedSeconds,
    };

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
      payout,
      destinationReference: destination.reference ?? destination.masked,
      completedAt: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    };

    // Persist the REQUEST before any leg runs. If a leg then fails, the
    // settlement still exists in the store with its terminal failure reason
    // instead of vanishing and leaving anchor-side movement unaccounted for.
    await this.repository.saveSettlement(settlement);
    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: "settlement.requested",
      entity: "settlement",
      entityId: settlement.id,
      metadata: {
        corridorId: corridor.id,
        quoteId: quote.id,
        payoutRail: rail.rail,
        destinationCountry: rail.country,
        // Fingerprint only — never the beneficiary handle itself.
        destinationFingerprint: destination.fingerprint,
        sourceAmount: quote.source.amount,
        sourceCurrency: quote.source.currency,
        netDestinationAmount: payout.netAmount.amount,
        destinationCurrency: payout.netAmount.currency,
      },
    });

    // SEP-12 KYC exchange with the anchor before any transfer. Only an opaque
    // customer id is retained — never raw documents/PII (Rules.md §7, D25).
    const registration = await this.anchor.registerCustomer(
      `${actor.userId}:${corridor.id}`,
    );

    const instruction: AnchorPayoutInstruction = {
      rail: rail.rail,
      fields,
      fingerprint: destination.fingerprint,
      ...(destination.reference ? { reference: destination.reference } : {}),
    };

    try {
      await this.runDeposit(
        settlement,
        corridor,
        route,
        actor,
        registration.customerId,
      );
      await this.runConvert(settlement, corridor, route, actor);
      await this.runPayout(
        settlement,
        corridor,
        payout,
        actor,
        registration.customerId,
        instruction,
      );
    } catch (err) {
      await this.markFailed(settlement, actor, err);
      throw err;
    }

    // The payout transition already persisted the Completed status; read it back
    // as the authoritative terminal snapshot.
    const completed =
      (await this.repository.findSettlement(settlement.id)) ?? settlement;

    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: "settlement.completed",
      entity: "settlement",
      entityId: settlement.id,
      metadata: {
        corridorId: corridor.id,
        routeType: route.type,
        payoutRail: rail.rail,
        payoutNetwork: rail.network,
        sourceCurrency: route.source.currency,
        destinationCurrency: route.destinationAmount.currency,
        netDestinationAmount: payout.netAmount.amount,
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

  // ── Rail + beneficiary resolution ──────────────────────────────────────────

  /** The requested rail if the corridor offers it, else the corridor default. */
  private resolveRail(
    corridor: CorridorDTO,
    requested: PayoutRail | undefined,
  ): PayoutRailSpec {
    if (!requested) return defaultRailFor(corridor);
    const rail = railForCorridor(corridor, requested);
    if (!rail) {
      const offered = corridor.payoutRails.map((spec) => spec.rail).join(", ");
      throw new ValidationError(
        `Payout rail ${requested} does not serve ${corridor.destinationCurrency}`,
        [{ path: "payoutRail", message: `available rails: ${offered}` }],
      );
    }
    return rail;
  }

  /**
   * Amount the beneficiary receives after the flat rail fee, checked against
   * the scheme's per-transaction floor and cap. When the amount is over the
   * cap, the error names a rail on this corridor that could carry it — the
   * caller's next step is a rail change, not a smaller transfer.
   */
  private netOfRailFee(
    route: SettlementRouteDTO,
    rail: PayoutRailSpec,
    corridor: CorridorDTO,
  ): bigint {
    const gross = BigInt(route.destinationAmount.amount);
    const fee = BigInt(rail.flatFeeAmount);
    const net = gross - fee;
    if (net <= 0n) {
      throw new ValidationError(
        `Amount is too small to deliver over ${rail.label}: the ${rail.network} fee alone is ${rail.flatFeeAmount} minor units`,
      );
    }
    if (net < BigInt(rail.minAmount)) {
      throw new ValidationError(
        `${rail.label} requires at least ${rail.minAmount} ${corridor.destinationCurrency} minor units after fees`,
        [{ path: "sourceAmount", message: "below the rail minimum" }],
      );
    }
    if (net > BigInt(rail.maxAmount)) {
      const alternative = corridor.payoutRails.find(
        (spec) => spec !== rail && net <= BigInt(spec.maxAmount),
      );
      throw new ValidationError(
        `${rail.label} caps a single transfer at ${rail.maxAmount} ${corridor.destinationCurrency} minor units`,
        [
          {
            path: "payoutRail",
            message: alternative
              ? `use ${alternative.label} for this amount`
              : "split the transfer across multiple payouts",
          },
        ],
      );
    }
    return net;
  }

  /**
   * Validate the beneficiary handle with its scheme's own checksum, then split
   * it into the persisted record (masked + fingerprint) and the normalized
   * fields, which live only long enough to reach the anchor.
   */
  private buildDestination(
    input: SettlementExecuteInput["destination"],
    rail: PayoutRailSpec,
  ): { destination: PayoutDestinationDTO; fields: NormalizedFields } {
    const result = validatePayoutDestination(input);
    if (!result.ok) {
      throw new ValidationError(
        "Beneficiary details are not valid for this payout rail",
        result.issues.map((issue) => ({
          path: `destination.fields.${issue.field}`,
          message: issue.message,
        })),
      );
    }

    const fields = result.fields;
    const fingerprint = createHash("sha256")
      .update(payoutFingerprintSource(rail.rail, fields))
      .digest("hex");

    return {
      destination: {
        rail: rail.rail,
        country: rail.country,
        currency: rail.currency,
        masked: maskPayoutDestination(rail.rail, fields),
        holderMasked: maskAccountHolder(
          fields[PayoutFieldName.AccountHolder] ?? "",
        ),
        fingerprint,
        reference: input.reference?.trim() || null,
      },
      fields,
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
    payout: SettlementPayoutDTO,
    actor: SettlementActor,
    customerId: string,
    instruction: AnchorPayoutInstruction,
  ) {
    // The anchor is instructed for the NET amount: the rail fee is retained on
    // this side, so what the beneficiary is promised is what the anchor pays.
    const transfer = await this.anchor.submitTransfer({
      kind: "withdrawal",
      protocol: corridor.anchorProtocol,
      amount: payout.netAmount.amount,
      currency: payout.netAmount.currency,
      customerId,
      payout: instruction,
    });
    const completedAt = new Date().toISOString();
    const snapshot: SettlementDTO = {
      ...settlement,
      status: SettlementStatus.Completed,
      completedAt,
      updatedAt: completedAt,
    };
    const transition = await this.repository.commitTransition({
      settlement: snapshot,
      transition: SettlementTransition.Payout,
      actorId: actor.userId,
      anchorTransfer: transfer,
      chain: null,
      ledger: this.payoutPosting(settlement.id, payout),
    });
    await this.auditTransition(actor, settlement.id, transition.id, "payout", {
      anchorReference: transfer.reference,
      currency: payout.netAmount.currency,
      payoutRail: payout.rail,
      destinationFingerprint: payout.destination.fingerprint,
    });
    return transition;
  }

  /**
   * Record a terminal failure. A settlement that died mid-flight is a support
   * case, not an absence: the row keeps the legs that did complete, so
   * reconciliation still sees the anchor movement they caused.
   */
  private async markFailed(
    settlement: SettlementDTO,
    actor: SettlementActor,
    err: unknown,
  ): Promise<void> {
    const reason = err instanceof Error ? err.message : "settlement failed";
    const current =
      (await this.repository.findSettlement(settlement.id)) ?? settlement;
    const now = new Date().toISOString();
    await this.repository.saveSettlement({
      ...current,
      status: SettlementStatus.Failed,
      failureReason: reason,
      completedAt: now,
      updatedAt: now,
    });
    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: "settlement.failed",
      entity: "settlement",
      entityId: settlement.id,
      metadata: { reason, statusAtFailure: current.status },
    });
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
        { accountId: SETTLEMENT_SOURCE_ANCHOR_CLEARING, direction: EntryDirection.Debit, amount, currency },
        { accountId: SETTLEMENT_USER_SOURCE_LIABILITY, direction: EntryDirection.Credit, amount, currency },
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
      { accountId: SETTLEMENT_USER_SOURCE_LIABILITY, direction: EntryDirection.Debit, amount: route.source.amount, currency: source },
      { accountId: SETTLEMENT_FX_CONVERSION, direction: EntryDirection.Credit, amount: netSource, currency: source },
    ];
    if (fee > 0n) {
      entries.push({
        accountId: SETTLEMENT_LIQUIDITY_FEE_REVENUE,
        direction: EntryDirection.Credit,
        amount: route.fee.amount,
        currency: source,
      });
    } else {
      // Keep the source side balanced when no fee is charged.
      entries[1] = {
        accountId: SETTLEMENT_FX_CONVERSION,
        direction: EntryDirection.Credit,
        amount: route.source.amount,
        currency: source,
      };
    }
    // Destination side balances in the destination currency.
    entries.push(
      { accountId: SETTLEMENT_FX_CONVERSION, direction: EntryDirection.Debit, amount: destAmount, currency: dest },
      { accountId: SETTLEMENT_USER_DEST_LIABILITY, direction: EntryDirection.Credit, amount: destAmount, currency: dest },
    );

    return {
      referenceId: `settlement:${settlementId}:convert`,
      description: `Settlement conversion ${source}->${dest} (${settlementId})`,
      entries,
    };
  }

  /**
   * Payout leg: the beneficiary's liability is discharged in full, split
   * between what the anchor pays out over the rail and the flat rail fee the
   * platform retains. Both sides are in the destination currency.
   */
  private payoutPosting(
    settlementId: string,
    payout: SettlementPayoutDTO,
  ): LedgerTransactionInput {
    const currency = payout.netAmount.currency;
    const gross = (
      BigInt(payout.netAmount.amount) + BigInt(payout.fee.amount)
    ).toString();

    const entries: LedgerEntryInput[] = [
      { accountId: SETTLEMENT_USER_DEST_LIABILITY, direction: EntryDirection.Debit, amount: gross, currency },
      { accountId: SETTLEMENT_DEST_ANCHOR_CLEARING, direction: EntryDirection.Credit, amount: payout.netAmount.amount, currency },
    ];
    if (BigInt(payout.fee.amount) > 0n) {
      entries.push({
        accountId: SETTLEMENT_PAYOUT_FEE_REVENUE,
        direction: EntryDirection.Credit,
        amount: payout.fee.amount,
        currency,
      });
    }

    return {
      referenceId: `settlement:${settlementId}:payout`,
      description: `Settlement payout over ${payout.network} (${settlementId})`,
      entries,
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
