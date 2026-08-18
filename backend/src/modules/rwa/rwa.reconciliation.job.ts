/**
 * RWA ledger-to-chain reconciliation.
 *
 * Escrow has had a reconciliation loop since Phase 2; tokenization has not,
 * which left the one module that mints transferable property with no answer to
 * "do our records still describe the contract?". The failure modes are real and
 * silent: a `transferUnits` that succeeds while the holdings insert fails, a
 * holder moving units directly on-chain, a freeze applied to the contract but
 * not the row (or the reverse, which is worse — the books say frozen while
 * transfers still execute).
 *
 * Every finding blocks nothing on its own; it is surfaced through the readiness
 * probe and the alert sink, exactly as the escrow job's are. What it does
 * guarantee is that a payout computed from `holdings` is never the first time
 * anyone checks whether `holdings` is still true — {@link RwaService} refuses
 * to distribute against drifted records, and this job finds the drift before a
 * payout is ever attempted.
 */
import { randomUUID } from "node:crypto";
import {
  PayoutStatus,
  ReconciliationStatus,
  RwaCustodyMode,
  TokenHoldingStatus,
} from "@stellartrust/shared";
import { logger } from "../../lib/logger.js";
import type { AlertSink } from "../../lib/alerts.js";
import type { MetricsRegistry } from "../../lib/metrics.js";
import type { RwaGateway } from "./rwa.gateway.js";
import type { RwaRepository } from "./rwa.repository.js";
import type { TokenizationDTO } from "./rwa.types.js";

export interface RwaReconciliationMismatch {
  id: string;
  tokenizationId: string;
  contractId: string;
  reason: string;
  createdAt: string;
}

export interface RwaReconciliationReport {
  status: ReconciliationStatus;
  checked: number;
  matched: number;
  unresolved: number;
  mismatches: RwaReconciliationMismatch[];
  ranAt: string;
}

export class RwaReconciliationJob {
  private timer: NodeJS.Timeout | undefined;
  private lastUnresolvedCount = 0;
  private lastMismatches: RwaReconciliationMismatch[] = [];

  constructor(
    private readonly repository: RwaRepository,
    private readonly gateway: RwaGateway,
    private readonly intervalMs: number,
    private readonly alerts?: AlertSink,
    private readonly metrics?: MetricsRegistry,
  ) {}

  /** Last observed unresolved mismatch count (for readiness probes). */
  lastUnresolved(): number {
    return this.lastUnresolvedCount;
  }

  async run(): Promise<RwaReconciliationReport> {
    const tokenizations = await this.repository.listTokenizations();
    // A draft tokenization has no contract to disagree with.
    const deployed = tokenizations.filter((t) => t.contractId !== null);
    const mismatches: RwaReconciliationMismatch[] = [];

    for (const tokenization of deployed) {
      const reasons = await this.check(tokenization);
      for (const reason of reasons) {
        mismatches.push({
          id: randomUUID(),
          tokenizationId: tokenization.id,
          contractId: tokenization.contractId as string,
          reason,
          createdAt: new Date().toISOString(),
        });
      }
    }

    const report: RwaReconciliationReport = {
      status:
        mismatches.length === 0
          ? ReconciliationStatus.Matched
          : ReconciliationStatus.Mismatch,
      checked: deployed.length,
      matched: deployed.length - new Set(mismatches.map((m) => m.tokenizationId)).size,
      unresolved: mismatches.length,
      mismatches,
      ranAt: new Date().toISOString(),
    };

    if (report.unresolved > 0) {
      logger.error({ report }, "RWA records-to-chain reconciliation mismatch");
      this.alerts?.emit({
        severity: "critical",
        source: "reconciliation.rwa",
        message: "Unresolved RWA records-to-chain mismatch(es) detected",
        context: { unresolved: report.unresolved, checked: report.checked },
      });
    } else {
      logger.info(
        { checked: report.checked },
        "RWA records-to-chain reconciliation matched",
      );
    }
    this.metrics?.reconciliationUnresolved.set(report.unresolved, {
      domain: "rwa",
    });
    this.metrics?.reconciliationRunsTotal.inc({
      domain: "rwa",
      result: report.status,
    });
    this.lastUnresolvedCount = report.unresolved;
    this.lastMismatches = mismatches;
    return report;
  }

  /** Findings for one tokenization. Empty means records and contract agree. */
  private async check(tokenization: TokenizationDTO): Promise<string[]> {
    const contractId = tokenization.contractId as string;
    const reasons: string[] = [];

    // A read failure is itself a finding, not a reason to skip the check: an
    // unreadable contract holding real units is exactly what we want surfaced.
    let meta: Awaited<ReturnType<RwaGateway["getContractMeta"]>>;
    try {
      meta = await this.gateway.getContractMeta(contractId);
    } catch (err) {
      return [
        `token contract could not be read: ${err instanceof Error ? err.message : String(err)}`,
      ];
    }
    if (!meta) {
      return ["tokenization records a contract id that is not deployed on-chain"];
    }

    if (meta.totalUnits !== BigInt(tokenization.totalUnits)) {
      reasons.push(
        `total supply is ${meta.totalUnits} on-chain but ` +
          `${tokenization.totalUnits} in our records`,
      );
    }
    if (meta.frozen !== tokenization.frozen) {
      // Direction matters for the operator reading this: "frozen in the books,
      // live on-chain" means transfers a compliance hold was meant to stop are
      // still executing. Under issuer custody that is the expected shape of a
      // compliance freeze the issuer has not countersigned — still a finding,
      // because someone has to chase it, but a different one.
      const issuerCustody =
        this.gateway.custody() === RwaCustodyMode.Issuer;
      reasons.push(
        meta.frozen
          ? "contract transfers are frozen but our records say they are not"
          : issuerCustody
            ? "our records say transfers are frozen but the contract still " +
              "allows them; under issuer custody only the issuer can sign the freeze"
            : "our records say transfers are frozen but the contract still allows them",
      );
    }

    // The contract's `distributed` flag is the on-chain double-payout guard.
    // Under issuer custody the platform cannot set it, so a completed payout
    // can leave it unclaimed — which means the guard is not actually armed.
    const distributions = await this.repository.listDistributions(
      tokenization.id,
    );
    const completed = distributions.some(
      (distribution) => distribution.status === PayoutStatus.Completed,
    );
    if (completed && !meta.distributed) {
      reasons.push(
        "a payout has been distributed in our records but the contract's " +
          "one-shot payout guard is unset; it needs the issuer's signature",
      );
    }

    reasons.push(...(await this.checkHolders(tokenization, contractId)));
    return reasons;
  }

  /** Every recorded holding is backed by the units the contract says it is. */
  private async checkHolders(
    tokenization: TokenizationDTO,
    contractId: string,
  ): Promise<string[]> {
    const reasons: string[] = [];
    const onChainIssuer = await this.gateway.issuerAddress(
      tokenization.issuerUserId,
    );
    const allHoldings = await this.repository.listHoldings(tokenization.id);
    // A pending holding is a purchase the issuer has not signed over yet. It
    // deliberately has no on-chain balance, so comparing it would report the
    // normal state of an undelivered purchase as drift.
    const holdings = allHoldings.filter(
      (holding) => holding.status === TokenHoldingStatus.Settled,
    );

    const onChain = new Map(
      (await this.gateway.getHolderBalances(contractId))
        // Undistributed supply sits with the issuer and is not a holding.
        .filter((balance) => balance.holderAddress !== onChainIssuer)
        .map((balance) => [balance.holderAddress, balance.units]),
    );

    // A purchase left waiting too long is an operational problem, not drift:
    // the investor has paid and holds nothing. Surface it as its own finding.
    for (const pending of allHoldings) {
      if (pending.status !== TokenHoldingStatus.Pending) continue;
      reasons.push(
        `${pending.holderAddress} has paid for ${pending.units} units that ` +
          "the issuer has not yet signed over",
      );
      // Their address may legitimately hold units from an earlier settled
      // purchase; only the undelivered ones are outstanding.
      onChain.delete(pending.holderAddress);
    }

    for (const holding of holdings) {
      const units = onChain.get(holding.holderAddress);
      if (units === undefined) {
        reasons.push(
          `holding for ${holding.holderAddress} (${holding.units} units) has ` +
            "no matching balance on-chain",
        );
        continue;
      }
      if (units !== BigInt(holding.units)) {
        reasons.push(
          `${holding.holderAddress} holds ${units} units on-chain but ` +
            `${holding.units} in our records`,
        );
      }
      onChain.delete(holding.holderAddress);
    }

    for (const [address, units] of onChain) {
      reasons.push(
        `${address} holds ${units} units on-chain with no recorded holding`,
      );
    }
    return reasons;
  }

  /** Findings from the last run, for a compliance-facing report. */
  lastReportMismatches(): RwaReconciliationMismatch[] {
    return this.lastMismatches;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.run().catch((err: unknown) =>
        logger.error({ err }, "scheduled RWA reconciliation failed"),
      );
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
