import { randomUUID } from "node:crypto";
import {
  ChainTxStatus,
  OrderStatus,
  ReconciliationStatus,
  type EscrowState,
  type OrderDTO,
  type PaymentTransitionDTO,
  type ReconciliationMismatchDTO,
  type ReconciliationReportDTO,
} from "@stellartrust/shared";
import { logger } from "../lib/logger.js";
import type { AlertSink } from "../lib/alerts.js";
import type { MetricsRegistry } from "../lib/metrics.js";
import {
  touchesChain,
  type EscrowGateway,
  type EscrowSnapshot,
} from "../modules/escrow/escrow.gateway.js";
import { isBalanced } from "../modules/ledger/ledger.balance.js";
import type { PaymentRepository } from "../modules/payments/payment.repository.js";

/** What the books say about custody, next to what the chain says. */
interface CustodyComparison {
  recorded: EscrowState | undefined;
  onChain: EscrowSnapshot | undefined;
  /** The order itself, so custody can be checked for value, not just state. */
  order: OrderDTO | undefined;
}

export class ReconciliationJob {
  private timer: NodeJS.Timeout | undefined;
  private lastUnresolvedCount = 0;

  constructor(
    private readonly repository: PaymentRepository,
    private readonly gateway: EscrowGateway,
    private readonly intervalMs: number,
    private readonly alerts?: AlertSink,
    private readonly metrics?: MetricsRegistry,
  ) {}

  /** Last observed unresolved mismatch count (for readiness probes). */
  lastUnresolved(): number {
    return this.lastUnresolvedCount;
  }

  async run(): Promise<ReconciliationReportDTO> {
    const transitions = await this.repository.listTransitions();
    const mismatches: ReconciliationMismatchDTO[] = [];
    // One custody read per order, not per transition: an order's escrow state
    // is the same fact however many transitions point at it, and each read is
    // a network round trip against the real gateway.
    const custody = new Map<string, CustodyComparison>();

    for (const transition of transitions) {
      const reason =
        (await this.checkLedgerAndChain(transition)) ??
        (await this.checkCustody(transition, custody));

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
      this.alerts?.emit({
        severity: "critical",
        source: "reconciliation.ledger",
        message: "Unresolved ledger-to-chain reconciliation mismatch(es) detected",
        context: { unresolved: report.unresolved, checked: report.checked },
      });
    } else {
      logger.info({ checked: report.checked }, "ledger-to-chain reconciliation matched");
    }
    this.metrics?.reconciliationUnresolved.set(report.unresolved, {
      domain: "ledger",
    });
    this.metrics?.reconciliationRunsTotal.inc({
      domain: "ledger",
      result: report.status,
    });
    this.lastUnresolvedCount = report.unresolved;
    return report;
  }

  /**
   * The ledger transaction is balanced and its chain transaction really
   * succeeded. `orderId`/`transition` attribution is only compared when the
   * adapter supplies it — a public ledger carries no record of our internal
   * ids, so demanding it there would flag every healthy on-chain transition.
   */
  private async checkLedgerAndChain(
    transition: PaymentTransitionDTO,
  ): Promise<string | undefined> {
    if (!isBalanced(transition.ledgerTransaction.entries)) {
      return "ledger transaction is not balanced";
    }

    // `create`, `accept`, and `deposit` move no funds on-chain. They still
    // carry a chain-record row so every transition has a unique key, but its
    // hash is synthetic — asking the network about it returns NOT_FOUND, which
    // would mark every healthy order mismatched and block it permanently.
    if (!touchesChain(transition.transition)) return undefined;

    const observed = transition.stellarTransaction.hash
      ? await this.gateway.getTransaction(transition.stellarTransaction.hash)
      : undefined;
    if (!observed) return "chain transaction was not found";
    if (observed.status !== ChainTxStatus.Success) {
      return `chain transaction status is ${observed.status}`;
    }
    if (
      (observed.orderId !== undefined &&
        observed.orderId !== transition.orderId) ||
      (observed.transition !== undefined &&
        observed.transition !== transition.transition)
    ) {
      return "chain transaction metadata does not match the ledger transition";
    }
    return undefined;
  }

  /**
   * The escrow contract the ledger points at really is this order's custody,
   * and really is in the state the ledger claims.
   *
   * This is the check that has teeth against a live chain: transaction hashes
   * only prove something happened, whereas custody state proves the funds are
   * where the books say they are.
   */
  private async checkCustody(
    transition: PaymentTransitionDTO,
    cache: Map<string, CustodyComparison>,
  ): Promise<string | undefined> {
    let pair = cache.get(transition.orderId);
    if (!pair) {
      const escrow = await this.repository.findEscrow(transition.orderId);
      pair = {
        recorded: escrow?.state,
        onChain: escrow?.contractId
          ? await this.gateway.getEscrowSnapshot(escrow.contractId)
          : undefined,
        order: await this.repository.findOrder(transition.orderId),
      };
      cache.set(transition.orderId, pair);
    }

    // No escrow, or a contract the gateway cannot see: the transaction-level
    // check above already covers whether anything is wrong.
    if (!pair.onChain || !pair.recorded) return undefined;

    if (
      pair.onChain.orderId !== null &&
      pair.onChain.orderId !== transition.orderId
    ) {
      return `escrow contract belongs to order ${pair.onChain.orderId}`;
    }
    if (pair.onChain.state !== pair.recorded) {
      return `escrow is ${pair.onChain.state} on-chain but ${pair.recorded} in the ledger`;
    }
    return this.checkCustodyValue(pair);
  }

  /**
   * Custody holds what the order says it is worth, in the asset the order is
   * denominated in.
   *
   * This is the half of reconciliation that state comparison cannot reach. An
   * escrow funded with the wrong token, or with a fraction of the order value,
   * is `Locked` on-chain and `locked` in the books — identical states, wholly
   * different facts about where the money is.
   */
  private checkCustodyValue(pair: CustodyComparison): string | undefined {
    const { onChain, order } = pair;
    // Nothing funded yet (the deploy→lock gap), or no order to compare to.
    if (!onChain?.value || !order) return undefined;

    const { amount, currency, tokenContractId } = onChain.value;
    if (amount === null || currency === null) {
      return (
        `escrow custody holds token ${tokenContractId ?? "unknown"}, which ` +
        "this deployment cannot express in ledger units"
      );
    }
    if (currency !== order.amount.currency || amount !== order.amount.amount) {
      return (
        `escrow custody holds ${amount} ${currency} but the order is ` +
        `${order.amount.amount} ${order.amount.currency}`
      );
    }

    // The contract's own `delivery_confirmed` is what gates a happy-path
    // release. If the books say the buyer confirmed and the contract does not,
    // the next release will be rejected on-chain — better to know now.
    if (order.status === OrderStatus.Confirmed && !onChain.deliveryConfirmed) {
      return "order is confirmed in the ledger but the contract records no delivery confirmation";
    }
    return undefined;
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
