/**
 * Alerting abstraction (Phase 6 observability).
 *
 * A thin sink interface so operational alerts (reconciliation drift, chain
 * failures, degraded dependencies) are emitted through one boundary. The local
 * default logs structured alerts and increments a metric; staging/production
 * can inject a sink that forwards to PagerDuty/Opsgenie/Slack without touching
 * call sites.
 *
 * Alerts must never carry PII, secrets, or amounts tied to an identity
 * (Rules.md §3) — pass opaque ids and counts only.
 */
import { logger } from "./logger.js";
import type { MetricsRegistry } from "./metrics.js";

export type AlertSeverity = "info" | "warning" | "critical";

export interface Alert {
  severity: AlertSeverity;
  /** Stable machine source, e.g. "reconciliation.ledger". */
  source: string;
  /** Short human-readable summary (no PII). */
  message: string;
  /** Optional non-sensitive structured context. */
  context?: Record<string, string | number | boolean>;
}

export interface AlertSink {
  emit(alert: Alert): Promise<void> | void;
}

/**
 * Default sink: structured log + metric increment. `critical`/`warning` log at
 * error/warn so existing log-based alerting still fires.
 */
export class LoggingAlertSink implements AlertSink {
  constructor(private readonly metrics?: MetricsRegistry) {}

  emit(alert: Alert): void {
    this.metrics?.alertsTotal.inc({
      severity: alert.severity,
      source: alert.source,
    });
    const payload = {
      alert: {
        severity: alert.severity,
        source: alert.source,
        ...(alert.context ? { context: alert.context } : {}),
      },
    };
    if (alert.severity === "critical") {
      logger.error(payload, alert.message);
    } else if (alert.severity === "warning") {
      logger.warn(payload, alert.message);
    } else {
      logger.info(payload, alert.message);
    }
  }
}

/** Test sink that records emitted alerts for assertions. */
export class RecordingAlertSink implements AlertSink {
  readonly alerts: Alert[] = [];
  emit(alert: Alert): void {
    this.alerts.push(alert);
  }
}
