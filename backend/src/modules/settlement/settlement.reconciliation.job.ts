/**
 * Settlement reconciliation (Phase 3 acceptance: deposits/withdrawals reconcile
 * against the ledger; Golden Rule #7).
 *
 * For every settlement transition it re-verifies that the ledger transaction is
 * balanced and that its linked external record — the anchor transfer (deposit/
 * payout) or the on-chain conversion receipt — is present and successful. Any
 * mismatch is persisted and blocks further operations on the affected
 * settlement until a human resolves it.
 */
import { randomUUID } from "node:crypto";
import {
  AnchorTransferStatus,
  ChainTxStatus,
  ReconciliationStatus,
  SettlementTransition,
  type SettlementReconciliationMismatchDTO,
  type SettlementReconciliationReportDTO,
} from "@stellartrust/shared";
import { logger } from "../../lib/logger.js";
import type { AlertSink } from "../../lib/alerts.js";
import type { MetricsRegistry } from "../../lib/metrics.js";
import { isBalanced } from "../ledger/ledger.balance.js";
import type { AnchorGateway } from "./anchor.gateway.js";
import type { SettlementRepository } from "./settlement.repository.js";

export class SettlementReconciliationJob {
  private timer: NodeJS.Timeout | undefined;
  private lastUnresolvedCount = 0;

  constructor(
    private readonly repository: SettlementRepository,
    private readonly anchor: AnchorGateway,
    private readonly intervalMs: number,
    private readonly alerts?: AlertSink,
    private readonly metrics?: MetricsRegistry,
  ) {}

  /** Last observed unresolved mismatch count (for readiness probes). */
  lastUnresolved(): number {
    return this.lastUnresolvedCount;
  }

  async run(): Promise<SettlementReconciliationReportDTO> {
    const transitions = await this.repository.listTransitions();
    const mismatches: SettlementReconciliationMismatchDTO[] = [];

    for (const transition of transitions) {
      const reason = await this.checkTransition(transition);
      if (reason) {
        mismatches.push({
          id: randomUUID(),
          settlementId: transition.settlementId,
          transitionId: transition.id,
          reason,
          resolvedAt: null,
          createdAt: new Date().toISOString(),
        });
      }
    }

    await this.repository.replaceMismatches(mismatches);
    const unresolved = await this.repository.listUnresolvedMismatches();
    const report: SettlementReconciliationReportDTO = {
      status:
        unresolved.length === 0
          ? ReconciliationStatus.Matched
          : ReconciliationStatus.Mismatch,
      checked: transitions.length,
      matched: transitions.length - mismatches.length,
      unresolved: unresolved.length,
      mismatches: unresolved,
      ranAt: new Date().toISOString(),
    };
    if (report.unresolved > 0) {
      logger.error({ report }, "settlement ledger-to-anchor reconciliation mismatch");
      this.alerts?.emit({
        severity: "critical",
        source: "reconciliation.settlement",
        message:
          "Unresolved settlement ledger-to-anchor reconciliation mismatch(es) detected",
        context: { unresolved: report.unresolved, checked: report.checked },
      });
    } else {
      logger.info(
        { checked: report.checked },
        "settlement ledger-to-anchor reconciliation matched",
      );
    }
    this.metrics?.reconciliationUnresolved.set(report.unresolved, {
      domain: "settlement",
    });
    this.metrics?.reconciliationRunsTotal.inc({
      domain: "settlement",
      result: report.status,
    });
    this.lastUnresolvedCount = report.unresolved;
    return report;
  }

  private async checkTransition(
    transition: Awaited<
      ReturnType<SettlementRepository["listTransitions"]>
    >[number],
  ): Promise<string | undefined> {
    if (!isBalanced(transition.ledgerTransaction.entries)) {
      return "ledger transaction is not balanced";
    }

    const isAnchorLeg =
      transition.transition === SettlementTransition.Deposit ||
      transition.transition === SettlementTransition.Payout;

    if (isAnchorLeg) {
      const transfer = transition.anchorTransfer;
      if (!transfer) return "anchor transfer record is missing";
      const observed = await this.anchor.getTransfer(transfer.reference);
      if (!observed) return "anchor transfer was not found";
      if (observed.status !== AnchorTransferStatus.Completed) {
        return `anchor transfer status is ${observed.status}`;
      }
      if (
        observed.amount !== transfer.amount ||
        observed.currency !== transfer.currency
      ) {
        return "anchor transfer amount/currency does not match the ledger";
      }
      return undefined;
    }

    // Conversion leg: must carry a successful on-chain receipt.
    const chain = transition.stellarTransaction;
    if (!chain) return "conversion chain record is missing";
    if (chain.status !== ChainTxStatus.Success) {
      return `conversion chain status is ${chain.status}`;
    }
    return undefined;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.run().catch((err: unknown) =>
        logger.error({ err }, "scheduled settlement reconciliation failed"),
      );
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
