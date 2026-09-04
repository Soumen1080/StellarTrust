"use client";

/**
 * Presentation primitives for the operations console.
 *
 * Charts are hand-drawn SVG rather than a charting library. Three reasons, in
 * order of weight: the shapes needed here are a bar series and a sparkline;
 * every charting library in the ecosystem is larger than this whole file; and
 * Rules.md §4 requires a decision entry for each new dependency, which is not
 * worth spending on two shapes.
 *
 * Colour follows the design tokens rather than a per-chart palette. An
 * operations dashboard is read at a glance under stress, and a chart whose
 * colours mean something different from the status pills beside it is a chart
 * that gets misread.
 */
import type { CurrencyCode } from "@stellartrust/shared";
import { fromMinorUnits } from "@/lib/money";

/** A headline number with its label and an optional qualifier beneath. */
export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  const toneClass = {
    neutral: "text-on-dark",
    good: "text-value-up",
    warn: "text-status-disputed",
    bad: "text-value-down",
  }[tone];

  return (
    <div className="rounded-lg border border-hairline-dark bg-surface-card-dark p-md">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-strong">
        {label}
      </p>
      <p className={`mt-xs font-mono text-2xl font-bold tabular-nums ${toneClass}`}>
        {value}
      </p>
      {hint ? <p className="mt-xxs text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

/**
 * Amounts keyed by currency, listed rather than summed.
 *
 * The backend deliberately does not add currencies together — that would need
 * an FX rate it does not have — so the UI must not either. Showing them
 * stacked is the honest presentation of "two numbers that are not comparable".
 */
export function CurrencyAmounts({
  amounts,
  empty = "—",
}: {
  amounts: Record<string, string>;
  empty?: string;
}) {
  const entries = Object.entries(amounts);
  if (entries.length === 0) {
    return <span className="font-mono text-2xl font-bold text-muted">{empty}</span>;
  }
  return (
    <span className="flex flex-col gap-xxs">
      {entries.map(([currency, minor]) => (
        <span key={currency} className="font-mono text-xl font-bold tabular-nums text-on-dark">
          {fromMinorUnits(minor, currency as CurrencyCode).toLocaleString(
            undefined,
            { maximumFractionDigits: 2 },
          )}
          <span className="ml-xs text-xs font-medium text-muted-strong">
            {currency}
          </span>
        </span>
      ))}
    </span>
  );
}

export interface BarPoint {
  label: string;
  value: number;
  /** Shown in the tooltip instead of the raw value when given. */
  display?: string;
}

/**
 * A bar series.
 *
 * Deliberately renders *every* bucket it is given, including the zero ones.
 * Dropping quiet days would draw a line implying activity that never happened,
 * which is how a gap gets read as a trend.
 */
export function BarChart({
  points,
  height = 160,
  label,
}: {
  points: BarPoint[];
  height?: number;
  label: string;
}) {
  if (points.length === 0) {
    return (
      <p className="py-lg text-center text-sm text-muted">
        No activity in this window yet.
      </p>
    );
  }

  const max = Math.max(...points.map((point) => point.value), 1);
  const barWidth = 100 / points.length;

  return (
    <figure className="w-full">
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height }}
        role="img"
        aria-label={label}
      >
        {/* A baseline, so a run of zeros still reads as "measured and empty"
            rather than as a rendering failure. */}
        <line
          x1="0"
          y1={height - 1}
          x2="100"
          y2={height - 1}
          stroke="currentColor"
          strokeWidth="0.5"
          className="text-hairline-dark"
        />
        {points.map((point, index) => {
          const barHeight = point.value === 0 ? 0 : (point.value / max) * (height - 8);
          return (
            <rect
              key={point.label}
              x={index * barWidth + barWidth * 0.15}
              y={height - 1 - barHeight}
              width={barWidth * 0.7}
              height={barHeight}
              className="fill-primary"
              rx="0.5"
            >
              <title>{`${point.label}: ${point.display ?? point.value}`}</title>
            </rect>
          );
        })}
      </svg>
      <figcaption className="mt-xs flex justify-between text-[11px] text-muted">
        <span>{points[0]?.label}</span>
        <span>{points.at(-1)?.label}</span>
      </figcaption>
    </figure>
  );
}

/**
 * A proportion, drawn as a filled track.
 *
 * Used for rates that have a meaningful ceiling (a default rate, a dispute
 * rate) where the shape of "how close to bad" matters more than the digits.
 */
export function RateBar({
  label,
  bps,
  warnAboveBps,
}: {
  label: string;
  bps: number;
  warnAboveBps: number;
}) {
  const percent = bps / 100;
  const alarming = bps > warnAboveBps;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-strong">
          {label}
        </span>
        <span
          className={`font-mono text-sm font-bold tabular-nums ${
            alarming ? "text-value-down" : "text-on-dark"
          }`}
        >
          {percent.toFixed(2)}%
        </span>
      </div>
      <div className="mt-xs h-1.5 w-full overflow-hidden rounded-pill bg-surface-elevated-dark">
        <div
          className={`h-full rounded-pill ${
            alarming ? "bg-value-down" : "bg-value-up"
          }`}
          // Capped at 100% so a rate above the axis still draws a full bar
          // rather than overflowing its track.
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
      {alarming ? (
        <p className="mt-xxs text-[11px] text-value-down">
          Above the {(warnAboveBps / 100).toFixed(0)}% review threshold.
        </p>
      ) : null}
    </div>
  );
}

/** A titled panel. Every section of the console sits in one. */
export function Panel({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-hairline-dark bg-surface-card-dark">
      <header className="flex flex-wrap items-start justify-between gap-sm border-b border-hairline-dark px-md py-sm">
        <div>
          <h2 className="text-sm font-semibold text-on-dark">{title}</h2>
          {description ? (
            <p className="mt-xxs text-xs text-muted">{description}</p>
          ) : null}
        </div>
        {action}
      </header>
      <div className="p-md">{children}</div>
    </section>
  );
}

/** A scrolling table. Wide content scrolls inside itself, never the page. */
export function DataTable({
  columns,
  rows,
  empty,
}: {
  columns: string[];
  rows: React.ReactNode[][];
  empty: string;
}) {
  if (rows.length === 0) {
    return <p className="py-md text-center text-sm text-muted">{empty}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-hairline-dark">
            {columns.map((column) => (
              <th
                key={column}
                scope="col"
                className="pb-xs pr-md text-xs font-medium uppercase tracking-wider text-muted-strong"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={index}
              className="border-b border-hairline-dark/50 last:border-0"
            >
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="py-sm pr-md align-top text-body">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A short, monospaced identifier. Long ids are truncated with the tail kept. */
export function ShortId({ value }: { value: string | null }) {
  if (!value) return <span className="text-muted">—</span>;
  const short =
    value.length > 16 ? `${value.slice(0, 6)}…${value.slice(-6)}` : value;
  return (
    <span className="font-mono text-xs text-muted-strong" title={value}>
      {short}
    </span>
  );
}

/** A timestamp, rendered compactly and consistently across the console. */
export function Timestamp({ value }: { value: string | null }) {
  if (!value) return <span className="text-muted">—</span>;
  return (
    <span className="whitespace-nowrap font-mono text-xs text-muted-strong">
      {new Date(value).toLocaleString(undefined, {
        dateStyle: "short",
        timeStyle: "short",
      })}
    </span>
  );
}
