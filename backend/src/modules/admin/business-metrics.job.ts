/**
 * Business-metric alerting (plane.md §4.4).
 *
 * The console shows an operator the default rate and the dispute rate. That
 * only helps someone who is looking. A book goes bad slowly and then all at
 * once, and the failure mode this job exists to prevent is a rate crossing a
 * threshold on a Friday evening with the dashboard closed.
 *
 * So the same numbers are swept on a schedule and published two ways: as
 * gauges on `/metrics`, so an external Prometheus can graph and alert on them
 * with the rest of the platform's signals; and through the {@link AlertSink},
 * which is what actually pages someone.
 *
 * **Alerts carry rates and counts, never amounts or identities** (Rules.md §3).
 * "The default rate is 14%" is an operational fact. "Investor X lost 40,000 on
 * position Y" is the same fact with a subject attached, and an alerting
 * pipeline is precisely the wrong place for that — it fans out to pagers,
 * chat channels, and third-party incident tools.
 *
 * Alerts fire on a *crossing*, not on every sweep. A rate that sits above the
 * threshold for a week is one incident, and re-paging every five minutes is
 * how an operator learns to ignore the channel.
 */
import { logger } from "../../lib/logger.js";
import type { AlertSink } from "../../lib/alerts.js";
import type { MetricsRegistry } from "../../lib/metrics.js";
import type { AdminService } from "./admin.service.js";

export interface BusinessMetricThresholds {
  /** Default rate, in basis points, above which someone is alerted. */
  defaultRateBps: number;
  /** Dispute rate, in basis points, above which someone is alerted. */
  disputeRateBps: number;
  /**
   * How many positions must have *resolved* before the default rate is
   * believed.
   *
   * Without this, one default out of one resolved position reads as a 100%
   * default rate and pages someone about a book that has barely started. The
   * rate is real; it is just not yet evidence of anything.
   */
  minimumResolvedPositions: number;
}

export const DEFAULT_THRESHOLDS: BusinessMetricThresholds = {
  // 10% and 5%. Credit-policy numbers, not code ones — configurable for the
  // same reason every other threshold in the platform is.
  defaultRateBps: 1_000,
  disputeRateBps: 500,
  minimumResolvedPositions: 5,
};

/** What one sweep observed, so a caller (and a test) can assert on it. */
export interface BusinessMetricsSweep {
  defaultRateBps: number;
  disputeRateBps: number;
  resolvedPositions: number;
  overduePositions: number;
  alertsRaised: string[];
}

export class BusinessMetricsJob {
  private timer?: NodeJS.Timeout;
  /**
   * Which alerts are currently standing.
   *
   * Held so an alert fires on the crossing and clears when the rate comes
   * back, rather than repeating on every sweep. In-process, which means a
   * restart re-fires a standing alert once — the conservative direction: a
   * duplicate page is recoverable, a missed one is not.
   */
  private readonly standing = new Set<string>();

  constructor(
    private readonly admin: AdminService,
    private readonly intervalMs: number,
    private readonly alerts: AlertSink,
    private readonly metrics: MetricsRegistry,
    private readonly thresholds: BusinessMetricThresholds = DEFAULT_THRESHOLDS,
  ) {}

  async run(): Promise<BusinessMetricsSweep> {
    const metrics = await this.admin.businessMetrics();
    const resolved =
      metrics.repaidTokenizations +
      metrics.defaultedTokenizations +
      metrics.writtenOffTokenizations;

    // Published as gauges whether or not anything is wrong. A metric that only
    // appears during an incident cannot be graphed before one.
    this.metrics.businessRateBps.set(metrics.defaultRateBps, {
      rate: "default",
    });
    this.metrics.businessRateBps.set(metrics.disputeRateBps, {
      rate: "dispute",
    });
    this.metrics.businessPositions.set(metrics.overduePositions, {
      kind: "overdue",
    });
    this.metrics.businessPositions.set(resolved, { kind: "resolved" });
    this.metrics.businessPositions.set(metrics.openDisputes, {
      kind: "open_disputes",
    });

    const alertsRaised: string[] = [];

    // The default rate is only believed once enough positions have resolved to
    // mean anything. One default out of one is a 100% rate and no evidence.
    if (resolved >= this.thresholds.minimumResolvedPositions) {
      this.evaluate(
        "rwa.default_rate",
        metrics.defaultRateBps > this.thresholds.defaultRateBps,
        {
          severity: "critical",
          message: "RWA default rate is above the review threshold",
          context: {
            defaultRateBps: metrics.defaultRateBps,
            thresholdBps: this.thresholds.defaultRateBps,
            resolvedPositions: resolved,
          },
        },
        alertsRaised,
      );
    }

    this.evaluate(
      "disputes.rate",
      metrics.ordersTotal > 0 &&
        metrics.disputeRateBps > this.thresholds.disputeRateBps,
      {
        severity: "warning",
        message: "Dispute rate is above the review threshold",
        context: {
          disputeRateBps: metrics.disputeRateBps,
          thresholdBps: this.thresholds.disputeRateBps,
          ordersTotal: metrics.ordersTotal,
        },
      },
      alertsRaised,
    );

    // Overdue positions are a leading indicator: they become defaults if
    // nobody chases them, which is exactly the window in which a human can
    // still change the outcome.
    this.evaluate(
      "rwa.overdue_positions",
      metrics.overduePositions > 0,
      {
        severity: "warning",
        message: "Positions are past maturity with no collection recorded",
        context: { overduePositions: metrics.overduePositions },
      },
      alertsRaised,
    );

    return {
      defaultRateBps: metrics.defaultRateBps,
      disputeRateBps: metrics.disputeRateBps,
      resolvedPositions: resolved,
      overduePositions: metrics.overduePositions,
      alertsRaised,
    };
  }

  /**
   * Fire on a crossing, clear on a recovery, stay quiet in between.
   *
   * The recovery is emitted too. An operator who was paged needs to know it
   * came back without having to go and look, and a channel that only ever
   * reports bad news is one where silence is ambiguous.
   */
  private evaluate(
    source: string,
    breached: boolean,
    alert: {
      severity: "warning" | "critical";
      message: string;
      context: Record<string, string | number | boolean>;
    },
    raised: string[],
  ): void {
    const wasStanding = this.standing.has(source);
    if (breached && !wasStanding) {
      this.standing.add(source);
      raised.push(source);
      void this.alerts.emit({
        severity: alert.severity,
        source,
        message: alert.message,
        context: alert.context,
      });
    } else if (!breached && wasStanding) {
      this.standing.delete(source);
      void this.alerts.emit({
        severity: "info",
        source,
        message: `Recovered: ${alert.message}`,
        context: alert.context,
      });
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.run().catch((err: unknown) =>
        logger.error({ err }, "scheduled business metrics sweep failed"),
      );
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
