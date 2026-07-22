"use client";

import {
  CURRENCY_SCALE,
  type AuthSessionResponse,
  type CorridorDTO,
  type CurrencyCode,
  type SettlementDetailsResponse,
  type SettlementQuoteDTO,
} from "@stellartrust/shared";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { loadSession } from "@/lib/wallet-auth";

/** Format an integer minor-unit string into a human amount for a currency. */
function formatMinor(amount: string, currency: CurrencyCode): string {
  const scale = CURRENCY_SCALE[currency] ?? 2;
  const negative = amount.startsWith("-");
  const digits = (negative ? amount.slice(1) : amount).padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale) || "0";
  const frac = scale > 0 ? `.${digits.slice(digits.length - scale)}` : "";
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${frac}`;
}

function toMinorUnits(value: string, currency: CurrencyCode): string {
  const scale = CURRENCY_SCALE[currency] ?? 2;
  if (!/^\d+(\.\d+)?$/.test(value.trim())) throw new Error("Enter a valid amount");
  const [whole, frac = ""] = value.trim().split(".");
  if (frac.length > scale) throw new Error(`At most ${scale} decimal places for ${currency}`);
  const minor = `${whole}${frac.padEnd(scale, "0")}`.replace(/^0+(?=\d)/, "");
  if (!/^\d+$/.test(minor) || minor === "0") throw new Error("Amount must be greater than zero");
  return minor;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The settlement operation failed";
}

export function SettlementConsole() {
  const [session, setSession] = useState<AuthSessionResponse | null>(null);
  const [corridors, setCorridors] = useState<CorridorDTO[]>([]);
  const [corridorId, setCorridorId] = useState("");
  const [amount, setAmount] = useState("");
  const [destinationReference, setDestinationReference] = useState("");
  const [quote, setQuote] = useState<SettlementQuoteDTO | null>(null);
  const [settlements, setSettlements] = useState<SettlementDetailsResponse[]>([]);
  const [pending, setPending] = useState<"quote" | "execute" | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const selectedCorridor = useMemo(
    () => corridors.find((item) => item.id === corridorId) ?? null,
    [corridorId, corridors],
  );

  const refresh = useCallback(async (active: AuthSessionResponse) => {
    const [{ corridors: list }, { settlements: history }] = await Promise.all([
      api.listCorridors(active.accessToken),
      api.listSettlements(active.accessToken),
    ]);
    setCorridors(list);
    setSettlements(history);
    setCorridorId((current) => current || (list[0]?.id ?? ""));
  }, []);

  useEffect(() => {
    const active = loadSession();
    setSession(active);
    if (!active) {
      setLoading(false);
      return;
    }
    void refresh(active)
      .catch((err: unknown) => setError(message(err)))
      .finally(() => setLoading(false));
  }, [refresh]);

  async function getQuote(event: FormEvent) {
    event.preventDefault();
    if (!session || !selectedCorridor) return;
    setPending("quote");
    setError(null);
    setQuote(null);
    try {
      const sourceAmount = toMinorUnits(amount, selectedCorridor.sourceCurrency);
      const result = await api.quoteSettlement(session.accessToken, {
        sourceCurrency: selectedCorridor.sourceCurrency,
        destinationCurrency: selectedCorridor.destinationCurrency,
        sourceAmount,
      });
      setQuote(result);
    } catch (err) {
      setError(message(err));
    } finally {
      setPending(null);
    }
  }

  async function execute() {
    if (!session || !quote) return;
    setPending("execute");
    setError(null);
    try {
      if (destinationReference.trim().length < 3) {
        throw new Error("Enter a destination reference (min 3 characters)");
      }
      await api.executeSettlement(session.accessToken, crypto.randomUUID(), {
        quoteId: quote.id,
        destinationReference: destinationReference.trim(),
      });
      setQuote(null);
      setAmount("");
      setDestinationReference("");
      await refresh(session);
    } catch (err) {
      setError(message(err));
    } finally {
      setPending(null);
    }
  }

  if (!session) {
    return (
      <section className="panel-dark overflow-hidden">
        <div className="p-xl sm:p-xxl">
          <span className="grid h-12 w-12 place-items-center rounded-lg bg-primary/10 text-primary">
            <Icon name="globe" className="h-6 w-6" />
          </span>
          <h2 className="mt-lg text-2xl font-bold text-on-dark">Connect your wallet to settle cross-border</h2>
          <p className="mt-sm max-w-xl leading-7 text-muted-strong">
            Authenticate with SEP-10 to quote a corridor, route over path payments and AMM liquidity, and settle through a regulated anchor — every leg reconciled to the ledger.
          </p>
          <Link href="/" className="btn-primary mt-lg">Connect wallet <Icon name="arrow-right" className="h-4 w-4" /></Link>
        </div>
      </section>
    );
  }

  const completed = settlements.filter((item) => item.settlement.status === "completed").length;

  return (
    <div>
      <section className="mb-lg grid gap-md sm:grid-cols-3">
        <Metric label="Corridors available" value={String(corridors.length)} detail="Sandbox anchor ramps" icon="globe" />
        <Metric label="Settlements" value={String(settlements.length)} detail={`${completed} completed`} icon="network" />
        <Metric label="Liquidity" value="Path + AMM" detail="Best-rate routing" icon="sparkles" />
      </section>

      {error ? (
        <div role="alert" className="mb-lg flex items-start justify-between gap-md rounded-lg border border-status-rejected/30 bg-status-rejected/10 p-md text-sm text-status-rejected">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error"><Icon name="x" className="h-4 w-4" /></button>
        </div>
      ) : null}

      <div className="grid items-start gap-lg xl:grid-cols-[minmax(0,1fr)_380px]">
        <section>
          <h2 className="mb-md text-sm font-semibold text-on-dark">Your settlements</h2>
          {loading ? (
            <div className="space-y-md">{Array.from({ length: 3 }).map((_, index) => <div key={index} className="panel-dark h-32 animate-pulse" />)}</div>
          ) : settlements.length === 0 ? (
            <div className="panel-dark px-lg py-xxl text-center">
              <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-surface-elevated-dark text-muted"><Icon name="globe" /></span>
              <h3 className="mt-md font-semibold text-on-dark">No settlements yet</h3>
              <p className="mx-auto mt-xs max-w-md text-sm text-muted">Request a quote for a corridor to route and settle your first cross-border transfer.</p>
            </div>
          ) : (
            <div className="space-y-md">
              {settlements.map((details) => {
                const expanded = expandedId === details.settlement.id;
                const s = details.settlement;
                return (
                  <article key={s.id} className="panel-dark overflow-hidden">
                    <div className="p-lg">
                      <div className="flex flex-col justify-between gap-md sm:flex-row sm:items-start">
                        <div>
                          <div className="flex flex-wrap items-center gap-sm">
                            <StatusPill status={s.status} />
                            <span className="rounded-pill border border-hairline-dark px-sm py-xs text-xs font-medium text-muted-strong capitalize">{s.route.type.replace(/_/g, " ")}</span>
                          </div>
                          <p className="mt-md font-mono text-2xl font-semibold text-on-dark">
                            {formatMinor(s.source.amount, s.source.currency)} <span className="text-base text-muted">{s.source.currency}</span>
                            <span className="mx-sm text-muted">→</span>
                            {formatMinor(s.destination.amount, s.destination.currency)} <span className="text-base text-muted">{s.destination.currency}</span>
                          </p>
                          <p className="mt-xs font-mono text-[11px] text-muted" title={s.id}>Settlement · {s.id.slice(0, 10)}…{s.id.slice(-8)}</p>
                        </div>
                        <button type="button" aria-expanded={expanded} onClick={() => setExpandedId(expanded ? null : s.id)} className="btn-secondary-dark">
                          {expanded ? "Hide legs" : "View legs"}<Icon name="chevron-down" className={`h-4 w-4 transition ${expanded ? "rotate-180" : ""}`} />
                        </button>
                      </div>
                      <div className="mt-lg grid grid-cols-2 gap-md border-t border-hairline-dark pt-md sm:grid-cols-4">
                        <Detail label="Rate" value={s.route.effectiveRate} />
                        <Detail label="Fee" value={`${formatMinor(s.route.fee.amount, s.route.fee.currency)} ${s.route.fee.currency}`} />
                        <Detail label="Slippage" value={`${s.route.slippageBps} bps`} />
                        <Detail label="Reconciliation" value={details.blockedByReconciliation ? "Mismatch" : "Healthy"} alert={details.blockedByReconciliation} />
                      </div>
                    </div>
                    {expanded ? (
                      <div className="border-t border-hairline-dark bg-canvas-dark/40 p-lg">
                        <p className="eyebrow">Settlement legs</p>
                        <ul className="mt-md space-y-sm">
                          {details.transitions.map((t) => (
                            <li key={t.id} className="flex items-center justify-between gap-sm rounded-md border border-hairline-dark bg-surface-card-dark px-md py-sm">
                              <span className="flex items-center gap-sm text-sm text-body">
                                <span className="grid h-6 w-6 place-items-center rounded-full bg-status-verified/10 text-status-verified"><Icon name="check" className="h-3.5 w-3.5" /></span>
                                <span className="capitalize">{t.transition}</span>
                              </span>
                              <span className="font-mono text-[11px] text-muted">
                                {t.anchorTransfer ? `anchor · ${t.anchorTransfer.protocol}` : t.stellarTransaction ? `chain · ${t.stellarTransaction.type}` : "ledger"}
                              </span>
                            </li>
                          ))}
                        </ul>
                        <dl className="mt-lg grid gap-md border-t border-hairline-dark pt-md sm:grid-cols-2">
                          <div><dt className="text-xs text-muted">Corridor</dt><dd className="mt-xs font-mono text-xs text-body">{s.corridorId}</dd></div>
                          <div><dt className="text-xs text-muted">Destination reference</dt><dd className="mt-xs break-all font-mono text-xs text-body">{s.destinationReference}</dd></div>
                        </dl>
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <aside className="panel-light overflow-hidden text-ink xl:sticky xl:top-24">
          <div className="border-b border-hairline-light p-lg">
            <div className="flex items-center gap-sm">
              <span className="grid h-10 w-10 place-items-center rounded-lg bg-primary/20 text-primary-active"><Icon name="globe" /></span>
              <div><h2 className="font-semibold">New cross-border settlement</h2><p className="text-xs text-muted">Quote, route, and settle</p></div>
            </div>
          </div>
          <form onSubmit={getQuote} className="p-lg">
            <div className="space-y-md">
              <label className="block text-sm font-medium">Corridor
                <span className="mt-xs block">
                  <select required value={corridorId} onChange={(event) => { setCorridorId(event.target.value); setQuote(null); }} className="input">
                    {corridors.map((corridor) => (
                      <option key={corridor.id} value={corridor.id}>
                        {corridor.sourceCurrency} → {corridor.destinationCurrency} · {corridor.anchorName}
                      </option>
                    ))}
                  </select>
                </span>
              </label>
              <label className="block text-sm font-medium">Send amount
                <span className="relative mt-xs block">
                  <input required value={amount} onChange={(event) => { setAmount(event.target.value); setQuote(null); }} placeholder="0.00" inputMode="decimal" className="input pr-16 font-mono text-lg" />
                  <span className="absolute right-sm top-1/2 -translate-y-1/2 font-mono text-xs font-semibold text-muted">{selectedCorridor?.sourceCurrency ?? ""}</span>
                </span>
              </label>
            </div>
            <button disabled={pending !== null} className="btn-primary mt-lg w-full">
              {pending === "quote" ? "Finding best route…" : "Get quote"}<Icon name="arrow-right" className="h-4 w-4" />
            </button>
          </form>

          {quote ? (
            <div className="border-t border-hairline-light p-lg">
              <div className="rounded-lg bg-surface-strong-light p-md">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted">You receive</span>
                  <span className="rounded-pill bg-primary/15 px-sm py-xs text-[11px] font-semibold uppercase tracking-wide text-primary-active capitalize">{quote.route.type.replace(/_/g, " ")}</span>
                </div>
                <p className="mt-xs font-mono text-2xl font-semibold">
                  {formatMinor(quote.route.destinationAmount.amount, quote.route.destinationAmount.currency)}
                  <span className="ml-xs text-sm text-muted">{quote.route.destinationAmount.currency}</span>
                </p>
                <div className="mt-sm space-y-xs text-xs">
                  <Row label="Rate" value={`1 ${quote.source.currency} = ${quote.route.effectiveRate} ${quote.route.destinationAmount.currency}`} />
                  <Row label="Fee" value={`${formatMinor(quote.route.fee.amount, quote.route.fee.currency)} ${quote.route.fee.currency}`} />
                  <Row label="Slippage" value={`${quote.route.slippageBps} bps`} />
                  <Row label="Est. time" value={`~${quote.route.estimatedSeconds}s`} />
                  <Row label="Routes considered" value={String(quote.consideredRoutes.length)} />
                </div>
              </div>
              <label className="mt-md block text-sm font-medium">Destination reference
                <input required value={destinationReference} onChange={(event) => setDestinationReference(event.target.value)} placeholder="Beneficiary reference" className="input mt-xs font-mono text-sm" />
              </label>
              <button type="button" disabled={pending !== null} onClick={() => void execute()} className="btn-primary mt-md w-full">
                {pending === "execute" ? "Settling…" : "Settle now"}<Icon name="arrow-right" className="h-4 w-4" />
              </button>
              <p className="mt-md flex items-start gap-xs text-xs leading-5 text-muted">
                <Icon name="shield" className="mt-0.5 h-4 w-4 shrink-0" />
                Deposit, conversion, and payout each write a balanced ledger transaction reconciled against the anchor and chain.
              </p>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function Metric({ label, value, detail, icon }: { label: string; value: string; detail: string; icon: "globe" | "network" | "sparkles" }) {
  return (
    <div className="panel-dark flex items-center justify-between p-lg">
      <div>
        <p className="text-xs font-medium text-muted">{label}</p>
        <p className="mt-xs font-mono text-2xl font-semibold text-on-dark">{value}</p>
        <p className="mt-xs text-xs text-muted">{detail}</p>
      </div>
      <span className="grid h-10 w-10 place-items-center rounded-lg bg-surface-elevated-dark text-muted-strong"><Icon name={icon} /></span>
    </div>
  );
}

function Detail({ label, value, alert = false }: { label: string; value: string; alert?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-muted">{label}</dt>
      <dd className={`mt-xs text-xs font-medium ${alert ? "text-status-disputed" : "text-body"}`}>{value}</dd>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-md">
      <span className="text-muted">{label}</span>
      <span className="font-mono font-medium text-ink">{value}</span>
    </div>
  );
}
