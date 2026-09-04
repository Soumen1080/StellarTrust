"use client";

/**
 * The operations console.
 *
 * One screen an operator can keep open: what the book is doing, what is
 * waiting on a decision, and the policy that decides what waits. Tabs rather
 * than one long scroll, because the overview is glanced at continuously while
 * the queues are worked through occasionally, and burying the first under the
 * second would mean scrolling past the queues to check a number.
 *
 * Everything here requires the compliance role. The API enforces that; this
 * component's job when the caller lacks it is to say so plainly rather than
 * render an empty console that looks broken.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AssetDTO,
  AuditEventDTO,
  BusinessMetricsDTO,
  CurrencyCode,
  DisputeDTO,
  EventSpineHealthResponse,
  KycReviewItem,
  SettlementDetailsResponse,
  TokenizationDTO,
  TreasuryMovementDTO,
  VerificationPolicyDTO,
  VolumeBucketDTO,
} from "@stellartrust/shared";
import { ApiClientError, api } from "@/lib/api";
import { useIdentity } from "@/components/IdentityProvider";
import { StatusPill } from "@/components/StatusPill";
import { fromMinorUnits } from "@/lib/money";
import {
  BarChart,
  CurrencyAmounts,
  DataTable,
  Panel,
  RateBar,
  ShortId,
  StatTile,
  Timestamp,
  type BarPoint,
} from "./AdminPrimitives";
import { PolicyEditor } from "./PolicyEditor";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "queues", label: "Queues" },
  { id: "book", label: "Book" },
  { id: "money", label: "Money" },
  { id: "policy", label: "Policy" },
  { id: "trail", label: "Audit trail" },
] as const;
type TabId = (typeof TABS)[number]["id"];

interface ConsoleData {
  metrics: BusinessMetricsDTO;
  volume: VolumeBucketDTO[];
  kycReviews: KycReviewItem[];
  assetReviews: AssetDTO[];
  tokenizations: TokenizationDTO[];
  disputes: DisputeDTO[];
  settlements: SettlementDetailsResponse[];
  movements: TreasuryMovementDTO[];
  audit: AuditEventDTO[];
  policies: VerificationPolicyDTO[];
  eventHealth: EventSpineHealthResponse;
}

/** A fresh idempotency key per mutating action (Rules.md #4). */
function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function AdminConsole() {
  const { session, loading: identityLoading } = useIdentity();
  const accessToken = session?.accessToken;

  const [tab, setTab] = useState<TabId>("overview");
  const [data, setData] = useState<ConsoleData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setError(null);
    try {
      // One batch rather than per-tab fetches. The console is a snapshot of
      // one moment; loading each tab separately would show an operator numbers
      // taken seconds apart and invite them to reconcile figures that were
      // never meant to agree.
      const [
        metrics,
        volume,
        kycReviews,
        assetReviews,
        tokenizations,
        disputes,
        settlements,
        movements,
        audit,
        policies,
        eventHealth,
      ] = await Promise.all([
        api.adminMetrics(accessToken),
        api.adminVolume(accessToken, 30),
        api.adminKycReviews(accessToken),
        api.adminAssetReviews(accessToken),
        api.adminTokenizations(accessToken),
        api.adminDisputes(accessToken),
        api.adminSettlements(accessToken),
        api.adminTreasuryMovements(accessToken),
        api.adminAudit(accessToken, 100),
        api.adminPolicies(accessToken),
        api.adminEventHealth(accessToken),
      ]);
      setData({
        metrics,
        volume: volume.buckets,
        kycReviews: kycReviews.reviews,
        assetReviews: assetReviews.assets,
        tokenizations: tokenizations.tokenizations,
        disputes: disputes.disputes,
        settlements: settlements.settlements,
        movements: movements.movements,
        audit: audit.events,
        policies: policies.policies,
        eventHealth,
      });
      setForbidden(false);
    } catch (err) {
      // A 403 is not an error to retry — it is an answer. Say so, rather than
      // showing an empty console that reads as broken.
      if (err instanceof ApiClientError && err.status === 403) {
        setForbidden(true);
      } else {
        setError(err instanceof Error ? err.message : "Could not load the console");
      }
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run a mutating action, then reload so every panel reflects the change. */
  const act = useCallback(
    async (key: string, action: () => Promise<unknown>) => {
      setBusy(key);
      setError(null);
      try {
        await action();
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "That action failed");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  if (identityLoading || (loading && !data)) {
    return (
      <p className="py-xl text-center text-sm text-muted">Loading the console…</p>
    );
  }

  if (!accessToken) {
    return (
      <div className="rounded-lg border border-hairline-dark bg-surface-card-dark p-lg text-center">
        <p className="text-sm text-body">
          Connect a wallet with the compliance role to open the console.
        </p>
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="rounded-lg border border-status-rejected/30 bg-status-rejected/5 p-lg text-center">
        <p className="text-sm font-semibold text-status-rejected">
          This account does not hold the compliance role.
        </p>
        <p className="mt-xs text-sm text-muted-strong">
          The console shows every user&rsquo;s position and the controls that
          decide verifications, so it is restricted deliberately.
        </p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-lg border border-hairline-dark bg-surface-card-dark p-lg text-center">
        <p className="text-sm text-value-down">{error ?? "No data"}</p>
        <button type="button" onClick={() => void load()} className="btn-primary mt-md">
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-lg">
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-status-rejected/30 bg-status-rejected/5 px-md py-sm text-sm text-status-rejected"
        >
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-sm">
        <nav
          className="flex flex-wrap gap-xxs rounded-lg border border-hairline-dark bg-surface-card-dark p-xxs"
          aria-label="Console sections"
        >
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setTab(entry.id)}
              aria-current={tab === entry.id ? "page" : undefined}
              className={`rounded-md px-sm py-xs text-sm font-medium transition-colors ${
                tab === entry.id
                  ? "bg-surface-elevated-dark text-on-dark"
                  : "text-muted-strong hover:text-on-dark"
              }`}
            >
              {entry.label}
              {entry.id === "queues" &&
              data.kycReviews.length + data.assetReviews.length > 0 ? (
                <span className="ml-xs rounded-pill bg-primary px-xs text-[11px] font-bold text-ink">
                  {data.kycReviews.length + data.assetReviews.length}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="flex items-center gap-sm">
          <span className="font-mono text-[11px] text-muted">
            as of{" "}
            {new Date(data.metrics.generatedAt).toLocaleTimeString(undefined, {
              timeStyle: "medium",
            })}
          </span>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-md border border-hairline-dark px-sm py-xs text-sm text-muted-strong transition-colors hover:text-on-dark"
          >
            Refresh
          </button>
        </div>
      </div>

      {tab === "overview" ? <Overview data={data} /> : null}
      {tab === "queues" ? (
        <Queues data={data} busy={busy} act={act} accessToken={accessToken} />
      ) : null}
      {tab === "book" ? <Book data={data} /> : null}
      {tab === "money" ? (
        <Money data={data} busy={busy} act={act} accessToken={accessToken} />
      ) : null}
      {tab === "policy" ? (
        <PolicyEditor
          policies={data.policies}
          accessToken={accessToken}
          onSaved={() => void load()}
        />
      ) : null}
      {tab === "trail" ? <Trail data={data} /> : null}
    </div>
  );
}

// ── Overview ────────────────────────────────────────────────────────────────

function Overview({ data }: { data: ConsoleData }) {
  const { metrics, volume } = data;

  const orderBars: BarPoint[] = useMemo(
    () =>
      volume.map((bucket) => ({
        label: bucket.date,
        value: bucket.orderCount,
        display: `${bucket.orderCount} order${bucket.orderCount === 1 ? "" : "s"}`,
      })),
    [volume],
  );

  const tokenizationBars: BarPoint[] = useMemo(
    () =>
      volume.map((bucket) => ({
        label: bucket.date,
        value: bucket.tokenizationCount,
        display: `${bucket.tokenizationCount} tokenization${
          bucket.tokenizationCount === 1 ? "" : "s"
        }`,
      })),
    [volume],
  );

  return (
    <div className="flex flex-col gap-lg">
      <div className="grid gap-md sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-hairline-dark bg-surface-card-dark p-md">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-strong">
            Total value locked
          </p>
          <div className="mt-xs">
            <CurrencyAmounts amounts={metrics.totalValueLocked} />
          </div>
          <p className="mt-xxs text-xs text-muted">
            Face value of positions still carrying risk
          </p>
        </div>
        <div className="rounded-lg border border-hairline-dark bg-surface-card-dark p-md">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-strong">
            Capital deployed
          </p>
          <div className="mt-xs">
            <CurrencyAmounts amounts={metrics.capitalDeployed} />
          </div>
          <p className="mt-xxs text-xs text-muted">What investors actually put in</p>
        </div>
        <StatTile
          label="Open disputes"
          value={String(metrics.openDisputes)}
          tone={metrics.openDisputes > 0 ? "warn" : "good"}
          hint={`${metrics.ordersTotal} orders total`}
        />
        <StatTile
          label="Overdue positions"
          value={String(metrics.overduePositions)}
          tone={metrics.overduePositions > 0 ? "bad" : "good"}
          hint="Past maturity, uncollected"
        />
      </div>

      <div className="grid gap-lg lg:grid-cols-2">
        <Panel
          title="Order volume"
          description="Orders opened per day, last 30 days"
        >
          <BarChart points={orderBars} label="Orders opened per day" />
        </Panel>
        <Panel
          title="Tokenizations created"
          description="New positions per day, last 30 days"
        >
          <BarChart
            points={tokenizationBars}
            label="Tokenizations created per day"
          />
        </Panel>
      </div>

      <div className="grid gap-lg lg:grid-cols-2">
        <Panel
          title="Portfolio health"
          description="Default rate counts resolved positions only — still-running ones are excluded, since counting them as successes would flatter a young book"
        >
          <div className="flex flex-col gap-md">
            <RateBar
              label="Default rate"
              bps={metrics.defaultRateBps}
              warnAboveBps={1_000}
            />
            <RateBar
              label="Dispute rate"
              bps={metrics.disputeRateBps}
              warnAboveBps={500}
            />
            <div className="grid grid-cols-2 gap-sm pt-xs sm:grid-cols-3">
              <MiniStat label="Active" value={metrics.activeTokenizations} />
              <MiniStat label="Funded" value={metrics.fundedTokenizations} />
              <MiniStat label="Matured" value={metrics.maturedTokenizations} />
              <MiniStat label="Repaid" value={metrics.repaidTokenizations} />
              <MiniStat
                label="Defaulted"
                value={metrics.defaultedTokenizations}
              />
              <MiniStat
                label="Written off"
                value={metrics.writtenOffTokenizations}
              />
            </div>
          </div>
        </Panel>

        <Panel
          title="Collection and flow"
          description="How long money takes to arrive, and where orders sit"
        >
          <div className="flex flex-col gap-md">
            <StatTile
              label="Average days to collect"
              value={
                metrics.averageDaysToCollect === null
                  ? "—"
                  : metrics.averageDaysToCollect.toFixed(1)
              }
              hint={
                metrics.averageDaysToCollect === null
                  ? "Nothing has been collected yet"
                  : "Across collected positions only"
              }
            />
            <div>
              <p className="mb-xs text-xs font-medium uppercase tracking-wider text-muted-strong">
                Orders by status
              </p>
              <div className="flex flex-wrap gap-xs">
                {Object.entries(metrics.ordersByStatus).length === 0 ? (
                  <span className="text-sm text-muted">No orders yet</span>
                ) : (
                  Object.entries(metrics.ordersByStatus).map(
                    ([status, count]) => (
                      <span
                        key={status}
                        className="inline-flex items-center gap-xs rounded-pill border border-hairline-dark px-sm py-xs text-xs"
                      >
                        <span className="capitalize text-muted-strong">
                          {status.replace(/_/g, " ")}
                        </span>
                        <span className="font-mono font-bold text-on-dark">
                          {count}
                        </span>
                      </span>
                    ),
                  )
                )}
              </div>
            </div>
          </div>
        </Panel>
      </div>

      <Panel
        title="Event spine"
        description="Facts published across domains, and how their handlers fared. A non-zero failed count means a cross-domain reaction did not run."
      >
        <EventHealth health={data.eventHealth} />
      </Panel>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-hairline-dark/60 px-sm py-xs">
      <p className="text-[11px] uppercase tracking-wider text-muted">{label}</p>
      <p className="font-mono text-lg font-bold tabular-nums text-on-dark">
        {value}
      </p>
    </div>
  );
}

function EventHealth({ health }: { health: EventSpineHealthResponse }) {
  const failed = health.handlers
    .filter((series) => series.labels.result === "failed")
    .reduce((sum, series) => sum + series.value, 0);
  const applied = health.handlers
    .filter((series) => series.labels.result === "applied")
    .reduce((sum, series) => sum + series.value, 0);
  const published = health.published.reduce(
    (sum, series) => sum + series.value,
    0,
  );

  return (
    <div className="flex flex-col gap-md">
      <div className="grid gap-md sm:grid-cols-3">
        <StatTile label="Events published" value={String(published)} />
        <StatTile label="Handlers applied" value={String(applied)} tone="good" />
        <StatTile
          label="Handlers failed"
          value={String(failed)}
          tone={failed > 0 ? "bad" : "good"}
          hint={failed > 0 ? "A cross-domain reaction did not run" : undefined}
        />
      </div>
      <DataTable
        columns={["Event type", "Published"]}
        rows={health.published.map((series) => [
          <span key="t" className="font-mono text-xs">
            {series.labels.type ?? "—"}
          </span>,
          <span key="v" className="font-mono tabular-nums">
            {series.value}
          </span>,
        ])}
        empty="No events published yet."
      />
    </div>
  );
}

// ── Queues ──────────────────────────────────────────────────────────────────

function Queues({
  data,
  busy,
  act,
  accessToken,
}: {
  data: ConsoleData;
  busy: string | null;
  act: (key: string, action: () => Promise<unknown>) => Promise<void>;
  accessToken: string;
}) {
  const [reasons, setReasons] = useState<Record<string, string>>({});

  return (
    <div className="flex flex-col gap-lg">
      <Panel
        title="KYC review queue"
        description="Every decision is recorded against the officer who made it, with the reason they gave"
      >
        <DataTable
          columns={["Applicant", "Risk", "Confidence", "Submitted", "Decision"]}
          rows={data.kycReviews.map((review) => [
            <ShortId key="u" value={review.userId} />,
            <span key="r" className="font-mono tabular-nums">
              {(review.advisory.riskScore * 100).toFixed(0)}%
            </span>,
            <span key="c" className="font-mono tabular-nums">
              {(review.advisory.confidence * 100).toFixed(0)}%
            </span>,
            <Timestamp key="t" value={review.createdAt} />,
            <div key="d" className="flex min-w-[280px] flex-col gap-xs">
              <input
                type="text"
                placeholder="Reason (required)"
                value={reasons[review.id] ?? ""}
                onChange={(event) =>
                  setReasons((current) => ({
                    ...current,
                    [review.id]: event.target.value,
                  }))
                }
                className="w-full rounded-md border border-hairline-dark bg-canvas-dark px-sm py-xs text-sm text-body placeholder:text-muted"
              />
              <div className="flex gap-xs">
                {(["approve", "reject"] as const).map((decision) => (
                  <button
                    key={decision}
                    type="button"
                    disabled={
                      busy !== null || !(reasons[review.id] ?? "").trim()
                    }
                    onClick={() =>
                      void act(`kyc:${review.id}`, () =>
                        api.adminDecideKycReview(
                          accessToken,
                          newIdempotencyKey(),
                          review.id,
                          {
                            decision,
                            reason: (reasons[review.id] ?? "").trim(),
                          },
                        ),
                      )
                    }
                    className={`rounded-md px-sm py-xs text-xs font-semibold capitalize transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      decision === "approve"
                        ? "bg-value-up/15 text-value-up hover:bg-value-up/25"
                        : "bg-value-down/15 text-value-down hover:bg-value-down/25"
                    }`}
                  >
                    {busy === `kyc:${review.id}` ? "…" : decision}
                  </button>
                ))}
              </div>
            </div>,
          ])}
          empty="Nothing waiting on a KYC decision."
        />
      </Panel>

      <Panel
        title="Asset verification queue"
        description="Only a verified asset may be tokenized, so a decision here is what lets a deal reach an investor at all"
      >
        <DataTable
          columns={["Asset", "Type", "Valuation", "Documents", "Decision"]}
          rows={data.assetReviews.map((asset) => [
            <div key="a" className="flex flex-col">
              <span className="text-sm text-body">{asset.description}</span>
              <ShortId value={asset.assetRef} />
            </div>,
            <span key="t" className="capitalize text-muted-strong">
              {asset.assetType.replace(/_/g, " ")}
            </span>,
            <span key="v" className="font-mono tabular-nums">
              {fromMinorUnits(
                asset.valuationAmount,
                asset.valuationCurrency as CurrencyCode,
              ).toLocaleString()}{" "}
              <span className="text-xs text-muted">
                {asset.valuationCurrency}
              </span>
            </span>,
            <span key="d" className="font-mono text-xs text-muted-strong">
              {asset.documents?.length ?? 0}
            </span>,
            <div key="x" className="flex min-w-[280px] flex-col gap-xs">
              <input
                type="text"
                placeholder="Note (required to reject)"
                value={reasons[asset.id] ?? ""}
                onChange={(event) =>
                  setReasons((current) => ({
                    ...current,
                    [asset.id]: event.target.value,
                  }))
                }
                className="w-full rounded-md border border-hairline-dark bg-canvas-dark px-sm py-xs text-sm text-body placeholder:text-muted"
              />
              <div className="flex gap-xs">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(`asset:${asset.id}`, () =>
                      api.adminReviewAsset(
                        accessToken,
                        newIdempotencyKey(),
                        asset.id,
                        { decision: "verify", note: reasons[asset.id] },
                      ),
                    )
                  }
                  className="rounded-md bg-value-up/15 px-sm py-xs text-xs font-semibold text-value-up transition-colors hover:bg-value-up/25 disabled:opacity-40"
                >
                  Verify
                </button>
                <button
                  type="button"
                  disabled={busy !== null || !(reasons[asset.id] ?? "").trim()}
                  onClick={() =>
                    void act(`asset:${asset.id}`, () =>
                      api.adminReviewAsset(
                        accessToken,
                        newIdempotencyKey(),
                        asset.id,
                        {
                          decision: "reject",
                          note: (reasons[asset.id] ?? "").trim(),
                        },
                      ),
                    )
                  }
                  className="rounded-md bg-value-down/15 px-sm py-xs text-xs font-semibold text-value-down transition-colors hover:bg-value-down/25 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Reject
                </button>
              </div>
            </div>,
          ])}
          empty="Nothing waiting on an asset decision."
        />
      </Panel>
    </div>
  );
}

// ── Book ────────────────────────────────────────────────────────────────────

function Book({ data }: { data: ConsoleData }) {
  return (
    <div className="flex flex-col gap-lg">
      <Panel
        title="Tokenizations"
        description="Every position on the platform, whatever its state"
      >
        <DataTable
          columns={[
            "Position",
            "Status",
            "Face value",
            "Sold",
            "Maturity",
            "Collected",
          ]}
          rows={data.tokenizations.map((tokenization) => [
            <ShortId key="i" value={tokenization.id} />,
            <StatusPill key="s" status={tokenization.status} />,
            <span key="f" className="font-mono tabular-nums">
              {fromMinorUnits(
                tokenization.faceValueAmount,
                tokenization.faceValueCurrency as CurrencyCode,
              ).toLocaleString()}{" "}
              <span className="text-xs text-muted">
                {tokenization.faceValueCurrency}
              </span>
            </span>,
            <span key="u" className="font-mono text-xs tabular-nums">
              {tokenization.unitsSold} / {tokenization.totalUnits}
            </span>,
            <Timestamp key="m" value={tokenization.maturityDate} />,
            <Timestamp key="c" value={tokenization.collectedAt} />,
          ])}
          empty="No tokenizations yet."
        />
      </Panel>

      <Panel title="Disputes" description="Claims filed against escrow orders">
        <DataTable
          columns={["Dispute", "Order", "Status", "Opened"]}
          rows={data.disputes.map((dispute) => [
            <ShortId key="i" value={dispute.id} />,
            <ShortId key="o" value={dispute.orderId} />,
            <StatusPill key="s" status={dispute.status} />,
            <Timestamp key="t" value={dispute.createdAt} />,
          ])}
          empty="No disputes filed."
        />
      </Panel>

      <Panel
        title="Settlements"
        description="Cross-border corridor transfers, including those funding an escrow order"
      >
        <DataTable
          columns={["Settlement", "Status", "Corridor", "Order", "Created"]}
          rows={data.settlements.map((entry) => [
            <ShortId key="i" value={entry.settlement.id} />,
            <StatusPill key="s" status={entry.settlement.status} />,
            <span key="c" className="font-mono text-xs text-muted-strong">
              {entry.settlement.source.currency} →{" "}
              {entry.settlement.destination.currency}
            </span>,
            <ShortId key="o" value={entry.settlement.orderId} />,
            <Timestamp key="t" value={entry.settlement.createdAt} />,
          ])}
          empty="No settlements yet."
        />
      </Panel>
    </div>
  );
}

// ── Money ───────────────────────────────────────────────────────────────────

function Money({
  data,
  busy,
  act,
  accessToken,
}: {
  data: ConsoleData;
  busy: string | null;
  act: (key: string, action: () => Promise<unknown>) => Promise<void>;
  accessToken: string;
}) {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const held = data.movements.filter(
    (movement) =>
      movement.direction === "withdrawal" && movement.status === "pending",
  );

  return (
    <div className="flex flex-col gap-lg">
      <Panel
        title="Withdrawals awaiting a decision"
        description="Above the configured ceiling a withdrawal is a decision, not a transfer. Nothing is debited while it waits."
      >
        <DataTable
          columns={["User", "Amount", "Destination", "Requested", "Decision"]}
          rows={held.map((movement) => [
            <ShortId key="u" value={movement.userId} />,
            <span key="a" className="font-mono tabular-nums">
              {fromMinorUnits(movement.amount, movement.currency).toLocaleString()}{" "}
              <span className="text-xs text-muted">{movement.currency}</span>
            </span>,
            <ShortId key="d" value={movement.counterpartyAddress} />,
            <Timestamp key="t" value={movement.createdAt} />,
            <div key="x" className="flex min-w-[260px] flex-col gap-xs">
              <input
                type="text"
                placeholder="Reason (required to refuse)"
                value={reasons[movement.id] ?? ""}
                onChange={(event) =>
                  setReasons((current) => ({
                    ...current,
                    [movement.id]: event.target.value,
                  }))
                }
                className="w-full rounded-md border border-hairline-dark bg-canvas-dark px-sm py-xs text-sm text-body placeholder:text-muted"
              />
              <div className="flex gap-xs">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(`wd:${movement.id}`, () =>
                      api.adminApproveWithdrawal(
                        accessToken,
                        newIdempotencyKey(),
                        movement.id,
                      ),
                    )
                  }
                  className="rounded-md bg-value-up/15 px-sm py-xs text-xs font-semibold text-value-up transition-colors hover:bg-value-up/25 disabled:opacity-40"
                >
                  Release
                </button>
                <button
                  type="button"
                  disabled={
                    busy !== null || !(reasons[movement.id] ?? "").trim()
                  }
                  onClick={() =>
                    void act(`wd:${movement.id}`, () =>
                      api.adminRejectWithdrawal(
                        accessToken,
                        newIdempotencyKey(),
                        movement.id,
                        (reasons[movement.id] ?? "").trim(),
                      ),
                    )
                  }
                  className="rounded-md bg-value-down/15 px-sm py-xs text-xs font-semibold text-value-down transition-colors hover:bg-value-down/25 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Refuse
                </button>
              </div>
            </div>,
          ])}
          empty="No withdrawals waiting on a decision."
        />
      </Panel>

      <Panel
        title="Treasury movements"
        description="Deposits verified against real Stellar payments, and withdrawals paid out"
      >
        <DataTable
          columns={["Direction", "User", "Amount", "Status", "Chain tx", "When"]}
          rows={data.movements.map((movement) => [
            <span
              key="d"
              className={`text-xs font-semibold capitalize ${
                movement.direction === "deposit"
                  ? "text-value-up"
                  : "text-status-locked"
              }`}
            >
              {movement.direction}
            </span>,
            <ShortId key="u" value={movement.userId} />,
            <span key="a" className="font-mono tabular-nums">
              {fromMinorUnits(movement.amount, movement.currency).toLocaleString()}{" "}
              <span className="text-xs text-muted">{movement.currency}</span>
            </span>,
            <StatusPill key="s" status={movement.status} />,
            movement.stellarTxHash ? (
              <a
                key="h"
                href={`https://stellar.expert/explorer/testnet/tx/${movement.stellarTxHash}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-xs text-primary hover:underline"
              >
                {movement.stellarTxHash.slice(0, 8)}…
              </a>
            ) : (
              <span key="h" className="text-muted">
                —
              </span>
            ),
            <Timestamp key="t" value={movement.createdAt} />,
          ])}
          empty="No treasury movements yet."
        />
      </Panel>
    </div>
  );
}

// ── Audit trail ─────────────────────────────────────────────────────────────

function Trail({ data }: { data: ConsoleData }) {
  return (
    <Panel
      title="Audit trail"
      description="Append-only. The 100 most recent entries across every domain."
    >
      <DataTable
        columns={["When", "Actor", "Action", "Entity"]}
        rows={data.audit.map((event) => [
          <Timestamp key="t" value={event.createdAt} />,
          <span key="a" className="font-mono text-xs text-muted-strong">
            {event.actor}
          </span>,
          <span key="c" className="font-mono text-xs text-body">
            {event.action}
          </span>,
          <div key="e" className="flex flex-col">
            <span className="text-xs text-muted-strong">{event.entity}</span>
            <ShortId value={event.entityId} />
          </div>,
        ])}
        empty="Nothing recorded yet."
      />
    </Panel>
  );
}
