/**
 * RWA post-funding lifecycle (plane.md §1.4).
 *
 * A tokenization that can never fail is not an investment product. Until now
 * the statuses stopped at `Funded`/`Distributed`: a receivable whose debtor
 * simply never paid stayed `Funded` forever, indistinguishable from one paying
 * on time, and nothing in the system could say an investor was at risk.
 *
 * This job supplies the passage of time. It makes exactly two transitions, both
 * driven by dates rather than by anyone's action:
 *
 *     Funded ──past maturityDate──▶ Matured ──past grace window──▶ Defaulted
 *
 * Collection is deliberately *not* handled here. A position that gets paid
 * moves to `Repaid` through {@link RwaService.distributePayout}, because that
 * is where the money actually lands; a scheduler that also moved it would be a
 * second writer racing the payout. The write-off path is likewise operator-
 * initiated ({@link RwaService.writeOffTokenization}) — deciding a debt is
 * unrecoverable is a credit judgement, not a timeout.
 *
 * Both transitions are idempotent: they select on the current status and the
 * clock, so a re-run after a crash re-derives the same answer and a position
 * already moved is simply not selected again.
 */
import {
  TokenizationStatus,
  type TokenizationDTO,
} from "@stellartrust/shared";
import { logger } from "../../lib/logger.js";
import type { AlertSink } from "../../lib/alerts.js";
import type { MetricsRegistry } from "../../lib/metrics.js";
import type { AuditRepository } from "../audit/audit.repository.js";
import type { RwaRepository } from "./rwa.repository.js";

/** Milliseconds in a day. */
const MS_PER_DAY = 86_400_000;

/** What one sweep changed. */
export interface RwaLifecycleReport {
  /** Positions examined. */
  checked: number;
  /** `Funded` → `Matured` transitions applied. */
  matured: number;
  /** `Matured` → `Defaulted` transitions applied. */
  defaulted: number;
  /** Ids of positions that entered default this run, for alerting. */
  defaultedIds: string[];
}

export class RwaLifecycleJob {
  private timer: NodeJS.Timeout | undefined;
  private lastDefaultedCount = 0;

  /**
   * @param graceDays - days past maturity before an uncollected position is
   *   treated as defaulted. Zero means default the moment maturity passes.
   * @param now - clock seed, injectable so tests can pin the date rather than
   *   manipulate timers. Production passes nothing and reads the real clock.
   */
  constructor(
    private readonly repository: RwaRepository,
    private readonly audit: AuditRepository,
    private readonly intervalMs: number,
    private readonly graceDays: number,
    private readonly alerts?: AlertSink,
    private readonly metrics?: MetricsRegistry,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Positions that entered default on the last run (for readiness probes). */
  lastDefaulted(): number {
    return this.lastDefaultedCount;
  }

  async run(): Promise<RwaLifecycleReport> {
    const now = this.now();
    const report: RwaLifecycleReport = {
      checked: 0,
      matured: 0,
      defaulted: 0,
      defaultedIds: [],
    };

    // Only the two statuses this job can move. Everything else — draft, active,
    // repaid, written off, a payout held pending a dispute — is either not yet
    // exposed to maturity or already in a terminal or externally-owned state.
    const candidates = [
      ...(await this.repository.listTokenizations({
        status: TokenizationStatus.Funded,
      })),
      ...(await this.repository.listTokenizations({
        status: TokenizationStatus.Matured,
      })),
    ];

    for (const tokenization of candidates) {
      report.checked += 1;
      try {
        await this.advance(tokenization, now, report);
      } catch (err) {
        // One bad row must not stop the sweep: the remaining positions still
        // need their transitions, and a stuck row is visible in the logs.
        logger.error(
          { err, tokenizationId: tokenization.id },
          "RWA lifecycle transition failed",
        );
      }
    }

    this.lastDefaultedCount = report.defaulted;
    if (report.matured > 0) {
      this.metrics?.rwaLifecycleTransitionsTotal.inc(
        { transition: "matured" },
        report.matured,
      );
    }
    if (report.defaulted > 0) {
      this.metrics?.rwaLifecycleTransitionsTotal.inc(
        { transition: "defaulted" },
        report.defaulted,
      );
    }

    if (report.defaulted > 0) {
      // A default means investors are carrying a loss. That is not a log line.
      // Counts only — an alert must not carry amounts or ids tied to an
      // identity (Rules.md §3); the audit trail holds which positions moved.
      this.alerts?.emit({
        severity: "warning",
        source: "lifecycle.rwa",
        message: "RWA position(s) passed the grace window without collection",
        context: { defaulted: report.defaulted, graceDays: this.graceDays },
      });
    }

    return report;
  }

  /** Apply whichever date-driven transition this position is due, if any. */
  private async advance(
    tokenization: TokenizationDTO,
    now: Date,
    report: RwaLifecycleReport,
  ): Promise<void> {
    const maturity = new Date(tokenization.maturityDate);
    if (Number.isNaN(maturity.getTime())) {
      logger.warn(
        { tokenizationId: tokenization.id },
        "RWA lifecycle: unparseable maturity date, skipping",
      );
      return;
    }

    // A collection already recorded means the debtor paid. Maturity is then a
    // date that has passed, not a state to move into — the payout owns what
    // happens next.
    if (tokenization.collectedAt) return;

    if (
      tokenization.status === TokenizationStatus.Funded &&
      now.getTime() >= maturity.getTime()
    ) {
      await this.transition(
        tokenization,
        TokenizationStatus.Matured,
        "rwa.tokenization_matured",
        { maturityDate: tokenization.maturityDate },
      );
      report.matured += 1;
      return;
    }

    if (tokenization.status === TokenizationStatus.Matured) {
      const deadline = maturity.getTime() + this.graceDays * MS_PER_DAY;
      if (now.getTime() >= deadline) {
        await this.transition(
          tokenization,
          TokenizationStatus.Defaulted,
          "rwa.tokenization_defaulted",
          {
            maturityDate: tokenization.maturityDate,
            graceDays: this.graceDays,
            daysPastMaturity: Math.floor(
              (now.getTime() - maturity.getTime()) / MS_PER_DAY,
            ),
          },
        );
        report.defaulted += 1;
        report.defaultedIds.push(tokenization.id);
      }
    }
  }

  /** Persist a status change and record why it happened. */
  private async transition(
    tokenization: TokenizationDTO,
    status: TokenizationStatus,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.repository.updateTokenization({
      ...tokenization,
      status,
      updatedAt: new Date().toISOString(),
    });

    // `system:` rather than a user: no person decided this, a date did.
    await this.audit.append({
      actor: "system:rwa-lifecycle",
      action,
      entity: "tokenization",
      entityId: tokenization.id,
      metadata: { ...metadata, from: tokenization.status, to: status },
    });

    logger.info(
      { tokenizationId: tokenization.id, from: tokenization.status, to: status },
      "RWA lifecycle transition",
    );
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.run().catch((err: unknown) =>
        logger.error({ err }, "scheduled RWA lifecycle sweep failed"),
      );
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
