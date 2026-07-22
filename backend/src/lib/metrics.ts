/**
 * Minimal, dependency-free in-process metrics registry (Phase 6 observability).
 *
 * Exposes Prometheus text-exposition format via `registry.render()`. We keep
 * this in-process (no external client) to avoid adding a runtime dependency and
 * to stay portable across the single-cloud deployment target (Architecture §5).
 *
 * Only non-sensitive operational signals are recorded here — never PII, secrets,
 * amounts tied to an identity, or raw Stellar keys (Rules.md §3).
 */

type Labels = Record<string, string>;

/** Serialize a label set into a stable, Prometheus-safe key. */
function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join(",");
}

/** Escape a label value per the Prometheus text format. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function renderLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  const inner = keys
    .map((k) => `${k}="${escapeLabelValue(labels[k] ?? "")}"`)
    .join(",");
  return `{${inner}}`;
}

interface MetricMeta {
  name: string;
  help: string;
}

export class Counter {
  private readonly values = new Map<string, { labels: Labels; value: number }>();

  constructor(private readonly meta: MetricMeta) {}

  inc(labels: Labels = {}, amount = 1): void {
    const key = labelKey(labels);
    const existing = this.values.get(key);
    if (existing) {
      existing.value += amount;
    } else {
      this.values.set(key, { labels, value: amount });
    }
  }

  render(): string {
    const lines = [
      `# HELP ${this.meta.name} ${this.meta.help}`,
      `# TYPE ${this.meta.name} counter`,
    ];
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.meta.name}${renderLabels(labels)} ${value}`);
    }
    return lines.join("\n");
  }
}

export class Gauge {
  private readonly values = new Map<string, { labels: Labels; value: number }>();

  constructor(private readonly meta: MetricMeta) {}

  set(value: number, labels: Labels = {}): void {
    this.values.set(labelKey(labels), { labels, value });
  }

  render(): string {
    const lines = [
      `# HELP ${this.meta.name} ${this.meta.help}`,
      `# TYPE ${this.meta.name} gauge`,
    ];
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.meta.name}${renderLabels(labels)} ${value}`);
    }
    return lines.join("\n");
  }
}

/** Fixed-bucket histogram (seconds). Emits _bucket/_sum/_count series. */
export class Histogram {
  private readonly series = new Map<
    string,
    { labels: Labels; counts: number[]; sum: number; count: number }
  >();

  constructor(
    private readonly meta: MetricMeta,
    private readonly buckets: number[] = [
      0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
    ],
  ) {}

  observe(value: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    let entry = this.series.get(key);
    if (!entry) {
      entry = { labels, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }
    entry.sum += value;
    entry.count += 1;
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (value <= (this.buckets[i] as number)) {
        entry.counts[i] = (entry.counts[i] as number) + 1;
      }
    }
  }

  render(): string {
    const lines = [
      `# HELP ${this.meta.name} ${this.meta.help}`,
      `# TYPE ${this.meta.name} histogram`,
    ];
    for (const entry of this.series.values()) {
      // `counts[i]` already holds the cumulative count for le=buckets[i]
      // (observe increments every bucket whose bound the value satisfies), so
      // emit it directly — Prometheus _bucket series are cumulative.
      for (let i = 0; i < this.buckets.length; i += 1) {
        const le = String(this.buckets[i]);
        lines.push(
          `${this.meta.name}_bucket${renderLabels({ ...entry.labels, le })} ${entry.counts[i]}`,
        );
      }
      lines.push(
        `${this.meta.name}_bucket${renderLabels({ ...entry.labels, le: "+Inf" })} ${entry.count}`,
      );
      lines.push(`${this.meta.name}_sum${renderLabels(entry.labels)} ${entry.sum}`);
      lines.push(`${this.meta.name}_count${renderLabels(entry.labels)} ${entry.count}`);
    }
    return lines.join("\n");
  }
}

/** A registry owning a set of metrics and rendering them together. */
export class MetricsRegistry {
  readonly httpRequestsTotal = new Counter({
    name: "http_requests_total",
    help: "Total HTTP requests processed, by method, route, and status.",
  });
  readonly httpRequestDurationSeconds = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request latency in seconds, by method and route.",
  });
  readonly reconciliationUnresolved = new Gauge({
    name: "reconciliation_unresolved_mismatches",
    help: "Current count of unresolved reconciliation mismatches, by domain.",
  });
  readonly reconciliationRunsTotal = new Counter({
    name: "reconciliation_runs_total",
    help: "Reconciliation runs, by domain and result (matched|mismatch).",
  });
  readonly alertsTotal = new Counter({
    name: "alerts_total",
    help: "Alerts emitted, by severity and source.",
  });

  render(): string {
    return [
      this.httpRequestsTotal.render(),
      this.httpRequestDurationSeconds.render(),
      this.reconciliationUnresolved.render(),
      this.reconciliationRunsTotal.render(),
      this.alertsTotal.render(),
    ].join("\n\n") + "\n";
  }
}

/** Process-wide registry. Constructed once and shared via the app. */
export const metrics = new MetricsRegistry();
