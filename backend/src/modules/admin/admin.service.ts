/**
 * Admin service — the platform's operational view of itself, and the controls
 * that act on it.
 *
 * Two things live here that did not exist before:
 *
 * **Business metrics (plane.md §4.4).** The `/metrics` endpoint carried HTTP
 * counters and reconciliation gauges — everything about whether the *server*
 * is healthy, and nothing about whether the *platform* is. Total value locked,
 * default rate, dispute rate and days-to-collect are the numbers that say
 * whether the lending book is sound, and none of them were computed anywhere.
 *
 * **The control surface.** Verification routing was three environment
 * variables; it is now a policy an operator edits (`verification-policy.ts`).
 *
 * Everything here is read-only with respect to money. The admin console can
 * change *policy* and decide queued cases through the services that own them —
 * it can never post a ledger entry, move units, or submit a transaction. That
 * boundary is why this module depends on narrow read ports rather than on the
 * services themselves.
 */
import type { CurrencyCode } from "@stellartrust/shared";
import type { AuditRepository } from "../audit/audit.repository.js";
import { ValidationError } from "../../lib/errors.js";
import type { PolicyRepository } from "./policy.repository.js";
import {
  validatePolicyUpdate,
  type UpdateVerificationPolicyInput,
  type VerificationDomain,
  type VerificationPolicy,
} from "./verification-policy.js";

/**
 * The tokenization facts the metrics need.
 *
 * A narrow shape rather than `TokenizationDTO` so this module does not depend
 * on the RWA module's whole surface for six fields — and so a change to the
 * DTO does not silently change what a metric means.
 */
export interface TokenizationSnapshot {
  id: string;
  status: string;
  faceValueAmount: string;
  faceValueCurrency: string;
  totalUnits: string;
  unitsSold: string;
  pricePerUnitAmount: string;
  maturityDate: string | null;
  collectedAt: string | null;
  createdAt: string;
}

export interface OrderSnapshot {
  id: string;
  status: string;
  amount: string;
  currency: string;
  createdAt: string;
}

export interface DisputeSnapshot {
  id: string;
  status: string;
  orderId: string;
  createdAt: string;
}

export interface AdminReaders {
  tokenizations(): Promise<TokenizationSnapshot[]>;
  orders(): Promise<OrderSnapshot[]>;
  disputes(): Promise<DisputeSnapshot[]>;
}

/**
 * The platform's health as a lending business, not as a web service.
 *
 * Amounts are strings of minor units, per currency. A single scalar "total
 * value locked" across currencies would require an FX rate this service does
 * not have and must not invent — a number that silently assumes 1 USD = 1 EUR
 * is worse than no number.
 */
export interface BusinessMetrics {
  /** Face value of every position not yet repaid or written off, per currency. */
  totalValueLocked: Record<string, string>;
  /** Capital investors have actually subscribed, per currency. */
  capitalDeployed: Record<string, string>;
  activeTokenizations: number;
  fundedTokenizations: number;
  maturedTokenizations: number;
  defaultedTokenizations: number;
  repaidTokenizations: number;
  writtenOffTokenizations: number;
  /**
   * Defaulted + written off, over every position that has reached a terminal
   * state. Basis points, so it is an integer and compares exactly.
   *
   * Deliberately excludes positions still running: counting them as
   * "not defaulted" flatters the rate early in a book's life, when most
   * positions simply have not had time to fail yet.
   */
  defaultRateBps: number;
  /** Disputes over orders, in basis points. */
  disputeRateBps: number;
  openDisputes: number;
  /** Mean days from funding to collection, over collected positions only. */
  averageDaysToCollect: number | null;
  /** Positions past maturity with no collection recorded. */
  overduePositions: number;
  ordersTotal: number;
  ordersByStatus: Record<string, number>;
  generatedAt: string;
}

/** Statuses that mean the position is still carrying risk. */
const LOCKED_STATUSES = new Set([
  "active",
  "funded",
  "matured",
  "payout_held",
  "defaulted",
]);

/** Statuses that mean the position's outcome is known. */
const TERMINAL_STATUSES = new Set(["repaid", "written_off", "defaulted"]);

/** Statuses that count as a loss when computing the default rate. */
const LOSS_STATUSES = new Set(["defaulted", "written_off"]);

function addTo(
  totals: Record<string, string>,
  currency: string,
  amount: bigint,
): void {
  totals[currency] = (BigInt(totals[currency] ?? "0") + amount).toString();
}

export class AdminService {
  constructor(
    private readonly readers: AdminReaders,
    private readonly policies: PolicyRepository,
    private readonly audit: AuditRepository,
    /** Injected so tests pin a date rather than waiting on the clock. */
    private readonly now: () => Date = () => new Date(),
  ) {}

  async businessMetrics(): Promise<BusinessMetrics> {
    const [tokenizations, orders, disputes] = await Promise.all([
      this.readers.tokenizations(),
      this.readers.orders(),
      this.readers.disputes(),
    ]);

    const totalValueLocked: Record<string, string> = {};
    const capitalDeployed: Record<string, string> = {};
    const byStatus = new Map<string, number>();
    let terminal = 0;
    let losses = 0;
    let overdue = 0;
    let collectedCount = 0;
    let collectedDaysTotal = 0;
    const nowMs = this.now().getTime();

    for (const tokenization of tokenizations) {
      byStatus.set(
        tokenization.status,
        (byStatus.get(tokenization.status) ?? 0) + 1,
      );

      if (LOCKED_STATUSES.has(tokenization.status)) {
        addTo(
          totalValueLocked,
          tokenization.faceValueCurrency,
          BigInt(tokenization.faceValueAmount),
        );
        // What investors actually put in, which is units sold at the unit
        // price — not the face value, which includes the seller's retained
        // first-loss and the yield that has not been earned yet.
        addTo(
          capitalDeployed,
          tokenization.faceValueCurrency,
          BigInt(tokenization.unitsSold) *
            BigInt(tokenization.pricePerUnitAmount),
        );
      }

      if (TERMINAL_STATUSES.has(tokenization.status)) {
        terminal += 1;
        if (LOSS_STATUSES.has(tokenization.status)) losses += 1;
      }

      if (
        tokenization.maturityDate &&
        !tokenization.collectedAt &&
        new Date(tokenization.maturityDate).getTime() < nowMs &&
        LOCKED_STATUSES.has(tokenization.status)
      ) {
        overdue += 1;
      }

      if (tokenization.collectedAt) {
        const days =
          (new Date(tokenization.collectedAt).getTime() -
            new Date(tokenization.createdAt).getTime()) /
          86_400_000;
        // A negative interval means the two timestamps disagree about
        // ordering, which is a data problem rather than a fast collection.
        // Counting it would drag the average below zero and hide the fault.
        if (days >= 0) {
          collectedCount += 1;
          collectedDaysTotal += days;
        }
      }
    }

    const ordersByStatus: Record<string, number> = {};
    for (const order of orders) {
      ordersByStatus[order.status] = (ordersByStatus[order.status] ?? 0) + 1;
    }

    const openDisputes = disputes.filter(
      (dispute) => dispute.status !== "resolved",
    ).length;

    return {
      totalValueLocked,
      capitalDeployed,
      activeTokenizations: byStatus.get("active") ?? 0,
      fundedTokenizations: byStatus.get("funded") ?? 0,
      maturedTokenizations: byStatus.get("matured") ?? 0,
      defaultedTokenizations: byStatus.get("defaulted") ?? 0,
      repaidTokenizations: byStatus.get("repaid") ?? 0,
      writtenOffTokenizations: byStatus.get("written_off") ?? 0,
      // Integer basis points. A rate carried as a float compares differently
      // depending on how it was written down, and an alert threshold is
      // exactly a comparison.
      defaultRateBps:
        terminal === 0 ? 0 : Math.round((losses / terminal) * 10_000),
      disputeRateBps:
        orders.length === 0
          ? 0
          : Math.round((disputes.length / orders.length) * 10_000),
      openDisputes,
      averageDaysToCollect:
        collectedCount === 0
          ? null
          : Number((collectedDaysTotal / collectedCount).toFixed(2)),
      overduePositions: overdue,
      ordersTotal: orders.length,
      ordersByStatus,
      generatedAt: this.now().toISOString(),
    };
  }

  /**
   * Volume over time, for the console's charts.
   *
   * Bucketed by day, per currency, because that is the granularity an operator
   * reads a book at. `days` is bounded so a console request cannot ask the
   * database to walk the entire history.
   */
  async volumeSeries(days = 30): Promise<{
    buckets: Array<{
      date: string;
      orderCount: number;
      orderVolume: Record<string, string>;
      tokenizationCount: number;
      tokenizationVolume: Record<string, string>;
    }>;
  }> {
    const window = Math.min(Math.max(Math.trunc(days), 1), 365);
    const [orders, tokenizations] = await Promise.all([
      this.readers.orders(),
      this.readers.tokenizations(),
    ]);

    const start = new Date(this.now());
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - (window - 1));

    // Every day in the window is present, including the empty ones. A chart
    // that omits quiet days draws a line implying activity that never
    // happened, which is how a gap gets read as a trend.
    const buckets = new Map<
      string,
      {
        date: string;
        orderCount: number;
        orderVolume: Record<string, string>;
        tokenizationCount: number;
        tokenizationVolume: Record<string, string>;
      }
    >();
    for (let i = 0; i < window; i += 1) {
      const day = new Date(start);
      day.setUTCDate(start.getUTCDate() + i);
      const key = day.toISOString().slice(0, 10);
      buckets.set(key, {
        date: key,
        orderCount: 0,
        orderVolume: {},
        tokenizationCount: 0,
        tokenizationVolume: {},
      });
    }

    for (const order of orders) {
      const bucket = buckets.get(order.createdAt.slice(0, 10));
      if (!bucket) continue;
      bucket.orderCount += 1;
      addTo(bucket.orderVolume, order.currency, BigInt(order.amount));
    }
    for (const tokenization of tokenizations) {
      const bucket = buckets.get(tokenization.createdAt.slice(0, 10));
      if (!bucket) continue;
      bucket.tokenizationCount += 1;
      addTo(
        bucket.tokenizationVolume,
        tokenization.faceValueCurrency,
        BigInt(tokenization.faceValueAmount),
      );
    }

    return { buckets: [...buckets.values()] };
  }

  // ── The control surface ───────────────────────────────────────────────────

  async listPolicies(): Promise<VerificationPolicy[]> {
    return this.policies.list();
  }

  async getPolicy(domain: VerificationDomain): Promise<VerificationPolicy> {
    return this.policies.get(domain);
  }

  /**
   * Change how a domain routes its verification decisions.
   *
   * Audited with the before and after, not merely "policy updated". A control
   * that can be loosened without a trace is not a control: the question an
   * auditor asks is what it was changed *from*, and an audit entry that only
   * records the new value cannot answer it.
   */
  async updatePolicy(
    domain: VerificationDomain,
    input: UpdateVerificationPolicyInput,
    actor: { userId: string },
  ): Promise<VerificationPolicy> {
    const current = await this.policies.get(domain);
    const errors = validatePolicyUpdate(current, input);
    if (errors.length > 0) {
      throw new ValidationError(
        "That verification policy would not be coherent",
        errors.map((message) => ({ path: "policy", message })),
      );
    }

    const updated = await this.policies.update(domain, input, actor.userId);
    await this.audit.append({
      actor: `user:${actor.userId}`,
      action: "admin.verification_policy_updated",
      entity: "verification_policy",
      entityId: domain,
      metadata: {
        before: {
          mode: current.mode,
          approveMaxRiskBps: current.approveMaxRiskBps,
          rejectMinRiskBps: current.rejectMinRiskBps,
          minConfidenceBps: current.minConfidenceBps,
          humanReviewAboveAmount: current.humanReviewAboveAmount,
        },
        after: {
          mode: updated.mode,
          approveMaxRiskBps: updated.approveMaxRiskBps,
          rejectMinRiskBps: updated.rejectMinRiskBps,
          minConfidenceBps: updated.minConfidenceBps,
          humanReviewAboveAmount: updated.humanReviewAboveAmount,
        },
      },
    });
    return updated;
  }
}

/** Re-exported so the routes and tests have one import for the domain type. */
export type { CurrencyCode };
