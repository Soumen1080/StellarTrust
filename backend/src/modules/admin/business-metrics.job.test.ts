/**
 * Business-metric alerting (plane.md §4.4).
 *
 * The behaviours worth pinning down are the ones that decide whether an
 * operator trusts the channel:
 *   - a rate crossing its threshold pages someone, once
 *   - a rate sitting above it does not page again every sweep
 *   - a rate coming back says so
 *   - a default rate computed from one resolved position does not page anyone
 *   - no alert ever carries an amount or an identity (Rules.md §3)
 */
import { describe, expect, it } from "vitest";
import { RecordingAlertSink } from "../../lib/alerts.js";
import { MetricsRegistry } from "../../lib/metrics.js";
import { InMemoryAuditRepository } from "../audit/audit.repository.js";
import { AdminService, type AdminReaders } from "./admin.service.js";
import { BusinessMetricsJob } from "./business-metrics.job.js";
import { InMemoryPolicyRepository } from "./policy.repository.js";

function tokenization(overrides: Record<string, unknown>) {
  return {
    id: "t1",
    status: "funded",
    faceValueAmount: "1000000",
    faceValueCurrency: "USDC",
    totalUnits: "1000",
    unitsSold: "1000",
    pricePerUnitAmount: "800",
    maturityDate: "2026-09-01T00:00:00.000Z",
    collectedAt: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  } as never;
}

function order(id: string) {
  return {
    id,
    status: "released",
    amount: "1000",
    currency: "USDC",
    createdAt: "2026-05-01T00:00:00.000Z",
  };
}

const NOW = new Date("2026-06-01T00:00:00.000Z");

function setup(readers: Partial<AdminReaders>) {
  const alerts = new RecordingAlertSink();
  const metrics = new MetricsRegistry();
  const admin = new AdminService(
    {
      tokenizations: async () => [],
      orders: async () => [],
      disputes: async () => [],
      ...readers,
    },
    new InMemoryPolicyRepository(),
    new InMemoryAuditRepository(),
    () => NOW,
  );
  const job = new BusinessMetricsJob(admin, 60_000, alerts, metrics, {
    defaultRateBps: 1_000,
    disputeRateBps: 500,
    minimumResolvedPositions: 5,
  });
  return { job, alerts, metrics };
}

/** A book with `losses` bad positions out of `resolved` that finished. */
function resolvedBook(resolved: number, losses: number) {
  return Array.from({ length: resolved }, (_, i) =>
    tokenization({
      id: `t${i}`,
      status: i < losses ? "defaulted" : "repaid",
      // Give them a future maturity so they do not also trip the overdue
      // alert and muddy what each test is asserting.
      maturityDate: "2027-01-01T00:00:00.000Z",
    }),
  );
}

describe("alerting on the default rate", () => {
  it("pages when the rate crosses the threshold", async () => {
    // 2 of 10 resolved = 20%, above the 10% threshold.
    const { job, alerts } = setup({
      tokenizations: async () => resolvedBook(10, 2),
    });
    const sweep = await job.run();

    expect(sweep.defaultRateBps).toBe(2_000);
    expect(sweep.alertsRaised).toContain("rwa.default_rate");
    expect(alerts.alerts[0]).toMatchObject({
      severity: "critical",
      source: "rwa.default_rate",
    });
  });

  it("stays quiet below the threshold", async () => {
    // 0 of 10 resolved.
    const { job, alerts } = setup({
      tokenizations: async () => resolvedBook(10, 0),
    });
    await job.run();
    expect(alerts.alerts).toEqual([]);
  });

  it("does not page on a rate computed from too few positions", async () => {
    // 1 of 1 is a 100% default rate and no evidence of anything. Paging here
    // is how an operator learns the channel cries wolf.
    const { job, alerts } = setup({
      tokenizations: async () => resolvedBook(1, 1),
    });
    const sweep = await job.run();

    expect(sweep.defaultRateBps).toBe(10_000);
    expect(sweep.alertsRaised).not.toContain("rwa.default_rate");
    expect(alerts.alerts).toEqual([]);
  });

  it("pages once, not on every sweep, while the rate stays high", async () => {
    // A rate above threshold for a week is one incident. Re-paging every five
    // minutes is how an operator learns to mute the channel.
    const { job, alerts } = setup({
      tokenizations: async () => resolvedBook(10, 2),
    });
    await job.run();
    await job.run();
    await job.run();

    expect(
      alerts.alerts.filter((alert) => alert.source === "rwa.default_rate"),
    ).toHaveLength(1);
  });

  it("says so when the rate comes back", async () => {
    // An operator who was paged needs to know it recovered without going to
    // look, and a channel that only ever reports bad news makes silence
    // ambiguous.
    let book = resolvedBook(10, 2);
    const { job, alerts } = setup({ tokenizations: async () => book });

    await job.run();
    book = resolvedBook(10, 0);
    await job.run();

    const forRate = alerts.alerts.filter(
      (alert) => alert.source === "rwa.default_rate",
    );
    expect(forRate).toHaveLength(2);
    expect(forRate[1]).toMatchObject({ severity: "info" });
    expect(forRate[1]?.message).toMatch(/^Recovered:/);
  });

  it("pages again if the rate crosses back over", async () => {
    let book = resolvedBook(10, 2);
    const { job, alerts } = setup({ tokenizations: async () => book });

    await job.run();
    book = resolvedBook(10, 0);
    await job.run();
    book = resolvedBook(10, 3);
    await job.run();

    const critical = alerts.alerts.filter(
      (alert) =>
        alert.source === "rwa.default_rate" && alert.severity === "critical",
    );
    expect(critical).toHaveLength(2);
  });
});

describe("alerting on disputes and overdue positions", () => {
  it("warns when the dispute rate crosses the threshold", async () => {
    const { job, alerts } = setup({
      orders: async () => [order("o1"), order("o2"), order("o3"), order("o4")],
      disputes: async () => [
        {
          id: "d1",
          status: "open",
          orderId: "o1",
          createdAt: "2026-05-02T00:00:00.000Z",
        },
      ],
    });
    const sweep = await job.run();

    expect(sweep.disputeRateBps).toBe(2_500);
    expect(
      alerts.alerts.find((alert) => alert.source === "disputes.rate"),
    ).toMatchObject({ severity: "warning" });
  });

  it("does not divide by zero on a platform with no orders", async () => {
    const { job, alerts } = setup({});
    const sweep = await job.run();
    expect(sweep.disputeRateBps).toBe(0);
    expect(alerts.alerts).toEqual([]);
  });

  it("warns on a position past maturity with no collection", async () => {
    // A leading indicator: these become defaults if nobody chases them, which
    // is the window in which a person can still change the outcome.
    const { job, alerts } = setup({
      tokenizations: async () => [
        tokenization({ maturityDate: "2026-05-01T00:00:00.000Z" }),
      ],
    });
    const sweep = await job.run();

    expect(sweep.overduePositions).toBe(1);
    expect(
      alerts.alerts.find((alert) => alert.source === "rwa.overdue_positions"),
    ).toMatchObject({ severity: "warning" });
  });
});

describe("what an alert is allowed to carry", () => {
  it("carries rates and counts, never amounts or identities", async () => {
    // Rules.md §3. Alerts fan out to pagers, chat channels, and third-party
    // incident tools — the wrong place for a user id or a position's value.
    const { job, alerts } = setup({
      tokenizations: async () => [
        ...resolvedBook(10, 3),
        tokenization({
          id: "overdue-1",
          maturityDate: "2026-05-01T00:00:00.000Z",
        }),
      ],
      orders: async () => [order("o1")],
      disputes: async () => [
        {
          id: "d1",
          status: "open",
          orderId: "o1",
          createdAt: "2026-05-02T00:00:00.000Z",
        },
      ],
    });
    await job.run();

    expect(alerts.alerts.length).toBeGreaterThan(0);
    for (const alert of alerts.alerts) {
      const serialized = JSON.stringify(alert);
      // No face values, no unit prices, no ids of any kind.
      expect(serialized).not.toContain("1000000");
      expect(serialized).not.toContain("overdue-1");
      expect(serialized).not.toContain("d1");
      expect(serialized).not.toContain("o1");
      for (const value of Object.values(alert.context ?? {})) {
        expect(typeof value).toBe("number");
      }
    }
  });
});

describe("the gauges", () => {
  it("publishes rates whether or not anything is wrong", async () => {
    // A metric that only appears during an incident cannot be graphed before
    // one.
    const { job, metrics } = setup({
      tokenizations: async () => resolvedBook(10, 0),
    });
    await job.run();

    const rendered = metrics.render();
    expect(rendered).toContain('business_rate_bps{rate="default"} 0');
    expect(rendered).toContain('business_rate_bps{rate="dispute"} 0');
    expect(rendered).toContain('business_positions{kind="resolved"} 10');
  });

  it("tracks the rate as it moves", async () => {
    const { job, metrics } = setup({
      tokenizations: async () => resolvedBook(10, 2),
    });
    await job.run();
    expect(metrics.render()).toContain('business_rate_bps{rate="default"} 2000');
  });
});
