/**
 * Business metrics, computed from rows this console read directly.
 *
 * The arithmetic mirrors `backend/src/modules/admin/admin.service.ts`, which
 * has 40 tests against it. It is duplicated rather than imported because the
 * two applications deploy separately and share no runtime — importing across
 * that boundary would couple their release cycles, which is the coupling the
 * split exists to remove.
 *
 * The two decisions worth restating, because they are what make these numbers
 * honest:
 *
 *   - Amounts are **per currency, never summed**. A cross-currency total needs
 *     an FX rate this console does not have, and a number that silently
 *     assumes 1 USD = 1 EUR is worse than no number.
 *
 *   - The default rate counts **resolved positions only**. Counting
 *     still-running ones as successes flatters a young book, and an operator
 *     making a credit decision on that figure is being misled by their own
 *     dashboard.
 */
import type { DisputeRow, OrderRow, TokenizationRow } from "./db.js";

/** Statuses meaning the position still carries risk. */
const LOCKED = new Set(["active", "funded", "matured", "payout_held", "defaulted"]);
/** Statuses meaning the outcome is known. */
const TERMINAL = new Set(["repaid", "written_off", "defaulted"]);
/** Statuses that count as a loss. */
const LOSS = new Set(["defaulted", "written_off"]);

export interface BusinessMetrics {
  totalValueLocked: Record<string, string>;
  capitalDeployed: Record<string, string>;
  byStatus: Record<string, number>;
  defaultRateBps: number;
  disputeRateBps: number;
  openDisputes: number;
  averageDaysToCollect: number | null;
  overduePositions: number;
  ordersTotal: number;
  ordersByStatus: Record<string, number>;
  generatedAt: string;
}

function addTo(
  totals: Record<string, string>,
  currency: string,
  amount: bigint,
): void {
  totals[currency] = (BigInt(totals[currency] ?? "0") + amount).toString();
}

export function computeMetrics(
  tokenizations: TokenizationRow[],
  orders: OrderRow[],
  disputes: DisputeRow[],
  now: Date = new Date(),
): BusinessMetrics {
  const totalValueLocked: Record<string, string> = {};
  const capitalDeployed: Record<string, string> = {};
  const byStatus: Record<string, number> = {};
  let terminal = 0;
  let losses = 0;
  let overdue = 0;
  let collectedCount = 0;
  let collectedDays = 0;
  const nowMs = now.getTime();

  for (const t of tokenizations) {
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;

    if (LOCKED.has(t.status)) {
      addTo(totalValueLocked, t.face_value_currency, BigInt(t.face_value_amount));
      // What investors actually put in — units sold at the unit price. Not the
      // face value, which includes the seller's retained first-loss and a
      // yield nobody has earned yet.
      addTo(
        capitalDeployed,
        t.face_value_currency,
        BigInt(t.units_sold) * BigInt(t.price_per_unit_amount),
      );
    }

    if (TERMINAL.has(t.status)) {
      terminal += 1;
      if (LOSS.has(t.status)) losses += 1;
    }

    if (
      t.maturity_date &&
      !t.collected_at &&
      new Date(t.maturity_date).getTime() < nowMs &&
      LOCKED.has(t.status)
    ) {
      overdue += 1;
    }

    if (t.collected_at) {
      const days =
        (new Date(t.collected_at).getTime() - new Date(t.created_at).getTime()) /
        86_400_000;
      // A negative interval means the timestamps disagree about ordering,
      // which is a data fault rather than a fast collection. Counting it would
      // drag the average down and hide the fault.
      if (days >= 0) {
        collectedCount += 1;
        collectedDays += days;
      }
    }
  }

  const ordersByStatus: Record<string, number> = {};
  for (const order of orders) {
    ordersByStatus[order.status] = (ordersByStatus[order.status] ?? 0) + 1;
  }

  return {
    totalValueLocked,
    capitalDeployed,
    byStatus,
    // Integer basis points: a rate carried as a float compares differently
    // depending on how it was written down, and a threshold is a comparison.
    defaultRateBps:
      terminal === 0 ? 0 : Math.round((losses / terminal) * 10_000),
    disputeRateBps:
      orders.length === 0
        ? 0
        : Math.round((disputes.length / orders.length) * 10_000),
    openDisputes: disputes.filter((d) => d.status !== "resolved").length,
    averageDaysToCollect:
      collectedCount === 0
        ? null
        : Number((collectedDays / collectedCount).toFixed(2)),
    overduePositions: overdue,
    ordersTotal: orders.length,
    ordersByStatus,
    generatedAt: now.toISOString(),
  };
}
