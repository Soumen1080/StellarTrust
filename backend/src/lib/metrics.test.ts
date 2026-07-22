import { describe, expect, it } from "vitest";
import { Counter, Gauge, Histogram, MetricsRegistry } from "./metrics.js";
import { LoggingAlertSink, RecordingAlertSink } from "./alerts.js";

describe("Phase 6 metrics registry", () => {
  it("accumulates counter values per label set", () => {
    const counter = new Counter({ name: "widgets_total", help: "widgets" });
    counter.inc({ kind: "a" });
    counter.inc({ kind: "a" });
    counter.inc({ kind: "b" }, 3);
    const text = counter.render();
    expect(text).toContain("# TYPE widgets_total counter");
    expect(text).toContain('widgets_total{kind="a"} 2');
    expect(text).toContain('widgets_total{kind="b"} 3');
  });

  it("records the latest gauge value per label set", () => {
    const gauge = new Gauge({ name: "queue_depth", help: "depth" });
    gauge.set(5, { q: "x" });
    gauge.set(2, { q: "x" });
    expect(gauge.render()).toContain('queue_depth{q="x"} 2');
  });

  it("emits histogram buckets, sum, and count", () => {
    const hist = new Histogram({ name: "lat_seconds", help: "latency" }, [0.1, 1]);
    hist.observe(0.05);
    hist.observe(0.5);
    hist.observe(2);
    const text = hist.render();
    expect(text).toContain("# TYPE lat_seconds histogram");
    expect(text).toContain('lat_seconds_bucket{le="0.1"} 1'); // only 0.05 <= 0.1
    expect(text).toContain('lat_seconds_bucket{le="1"} 2'); // 0.05, 0.5 <= 1
    expect(text).toContain('lat_seconds_bucket{le="+Inf"} 3');
    expect(text).toContain("lat_seconds_count 3");
    expect(text).toContain("lat_seconds_sum 2.55");
  });

  it("renders all registry metrics together", () => {
    const registry = new MetricsRegistry();
    registry.httpRequestsTotal.inc({ method: "GET", route: "/health", status: "200" });
    registry.reconciliationUnresolved.set(0, { domain: "ledger" });
    const text = registry.render();
    expect(text).toContain("http_requests_total");
    expect(text).toContain("reconciliation_unresolved_mismatches");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("escapes label values safely", () => {
    const counter = new Counter({ name: "x_total", help: "x" });
    counter.inc({ route: 'a"b' });
    expect(counter.render()).toContain('route="a\\"b"');
  });
});

describe("Phase 6 alerts", () => {
  it("records alerts on the recording sink", () => {
    const sink = new RecordingAlertSink();
    sink.emit({ severity: "critical", source: "test", message: "boom" });
    expect(sink.alerts).toHaveLength(1);
    expect(sink.alerts[0]?.severity).toBe("critical");
  });

  it("increments the alerts metric via the logging sink", () => {
    const registry = new MetricsRegistry();
    const sink = new LoggingAlertSink(registry);
    sink.emit({ severity: "warning", source: "recon.ledger", message: "drift" });
    expect(registry.alertsTotal.render()).toContain(
      'alerts_total{severity="warning",source="recon.ledger"} 1',
    );
  });
});
