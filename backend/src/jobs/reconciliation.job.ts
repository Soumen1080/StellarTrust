import { randomUUID } from "node:crypto";
import {
  ChainTxStatus,
  ReconciliationStatus,
  type ReconciliationMismatchDTO,
  type ReconciliationReportDTO,
} from "@stellartrust/shared";
import { logger } from "../lib/logger.js";
import type { EscrowGateway } from "../modules/escrow/escrow.gateway.js";
import { isBalanced } from "../modules/ledger/ledger.balance.js";
import type { PaymentRepository } from "../modules/payments/payment.repository.js";

export class ReconciliationJob {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly repository: PaymentRepository,
    private readonly gateway: EscrowGateway,
    private readonly intervalMs: number,
  ) {}

  async run(): Promise<ReconciliationReportDTO> {
    const transitions = await this.repository.listTransitions();
    const mismatches: ReconciliationMismatchDTO[] = [];

    for (const transition of transitions) {
      const observed = transition.stellarTransaction.hash
        ? await this.gateway.getTransaction(transition.stellarTransaction.hash)
        : undefined;
      let reason: string | undefined;
      if (!isBalanced(transition.ledgerTransaction.entries)) {
        reason = "ledger transaction is not balanced";
      } else if (!observed) {
        reason = "chain transaction was not found";
      } else if (observed.status !== ChainTxStatus.Success) {
        reason = `chain transaction status is ${observed.status}`;
      } else if (
        observed.orderId !== transition.orderId ||
        observed.transition !== transition.transition
      ) {
        reason = "chain transaction metadata does not match the ledger transition";
      }

      if (reason) {
        mismatches.push({
          id: randomUUID(),
          orderId: transition.orderId,
          transitionId: transition.id,
          reason,
          resolvedAt: null,
          createdAt: new Date().toISOString(),
        });
      }
    }

    await this.repository.replaceMismatches(mismatches);
    const unresolved = await this.repository.listUnresolvedMismatches();
    const report: ReconciliationReportDTO = {
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
      logger.error({ report }, "ledger-to-chain reconciliation mismatch");
    } else {
      logger.info({ checked: report.checked }, "ledger-to-chain reconciliation matched");
    }
    return report;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.run().catch((err: unknown) =>
        logger.error({ err }, "scheduled reconciliation failed"),
      );
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
