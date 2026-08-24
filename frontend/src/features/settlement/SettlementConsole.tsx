"use client";

import {
  CURRENCY_SCALE,
  PAYOUT_COUNTRY_FLAG,
  PAYOUT_COUNTRY_LABEL,
  normalizePayoutField,
  validatePayoutDestination,
  type AuthSessionResponse,
  type CorridorDTO,
  type CurrencyCode,
  type PayoutCountry,
  type PayoutFieldName,
  type PayoutFieldSpec,
  type PayoutRail,
  type PayoutRailSpec,
  type SettlementDetailsResponse,
  type SettlementQuoteDTO,
} from "@stellartrust/shared";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { useIdentity } from "@/components/IdentityProvider";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";

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

/** "instant", "~30s", "~30 min", "next business day" — how a rail actually reads. */
function formatDuration(seconds: number): string {
  if (seconds <= 15) return "seconds";
  if (seconds < 90) return `~${seconds}s`;
  if (seconds < 3600) return `~${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `~${Math.round(seconds / 3600)} h`;
  return "next business day";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The settlement operation failed";
}

/** Seconds left on a quote, floored at zero. */
function secondsUntil(iso: string, now: number): number {
  return Math.max(0, Math.floor((new Date(iso).getTime() - now) / 1000));
}

type ListFilter = "all" | "in_flight" | "completed" | "failed";

const FILTERS: { id: ListFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "in_flight", label: "In flight" },
  { id: "completed", label: "Completed" },
  { id: "failed", label: "Failed" },
];

export function SettlementConsole() {
  const { session } = useIdentity();
  const [corridors, setCorridors] = useState<CorridorDTO[]>([]);
  const [country, setCountry] = useState<PayoutCountry | "">("");
  const [corridorId, setCorridorId] = useState("");
  const [railId, setRailId] = useState<PayoutRail | "">("");
  const [amount, setAmount] = useState("");
  const [beneficiary, setBeneficiary] = useState<Partial<Record<PayoutFieldName, string>>>({});
  const [reference, setReference] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<PayoutFieldName, string>>>({});
  const [quote, setQuote] = useState<SettlementQuoteDTO | null>(null);
  const [settlements, setSettlements] = useState<SettlementDetailsResponse[]>([]);
  const [filter, setFilter] = useState<ListFilter>("all");
  const [pending, setPending] = useState<"quote" | "execute" | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // ── Derived selection ─────────────────────────────────────────────────────
  // Corridors are grouped by where the money lands, because that is the choice
  // a payer actually makes ("send to India"), not the currency pair.
  const countries = useMemo(() => {
    const seen = new Map<PayoutCountry, number>();
    for (const corridor of corridors) {
      seen.set(corridor.destinationCountry, (seen.get(corridor.destinationCountry) ?? 0) + 1);
    }
    return [...seen.keys()];
  }, [corridors]);

  const countryCorridors = useMemo(
    () => corridors.filter((item) => item.destinationCountry === country),
    [corridors, country],
  );

  const selectedCorridor = useMemo(
    () => corridors.find((item) => item.id === corridorId) ?? null,
    [corridorId, corridors],
  );

  const selectedRail: PayoutRailSpec | null = useMemo(() => {
    if (!selectedCorridor) return null;
    return (
      selectedCorridor.payoutRails.find((rail) => rail.rail === railId) ??
      selectedCorridor.payoutRails[0] ??
      null
    );
  }, [railId, selectedCorridor]);

  const expiresIn = quote ? secondsUntil(quote.expiresAt, now) : 0;
  const quoteExpired = quote !== null && expiresIn === 0;

  // A quote is priced for one rail and one amount; changing either makes the
  // numbers on screen wrong, so the quote is dropped rather than left stale.
  const invalidateQuote = useCallback(() => setQuote(null), []);

  const refresh = useCallback(async (active: AuthSessionResponse) => {
    const [{ corridors: list }, { settlements: history }] = await Promise.all([
      api.listCorridors(active.accessToken),
      api.listSettlements(active.accessToken),
    ]);
    setCorridors(list);
    setSettlements(history);
    setCountry((current) => current || (list[0]?.destinationCountry ?? ""));
  }, []);

  useEffect(() => {
    if (!session) {
      setCorridors([]);
      setSettlements([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void refresh(session)
      .catch((err: unknown) => setError(message(err)))
      .finally(() => setLoading(false));
  }, [refresh, session]);

  // Keep the corridor and rail consistent with the country in one place, so a
  // country change can never leave a corridor from the previous destination.
  useEffect(() => {
    if (countryCorridors.length === 0) return;
    setCorridorId((current) =>
      countryCorridors.some((item) => item.id === current)
        ? current
        : (countryCorridors[0]?.id ?? ""),
    );
  }, [countryCorridors]);

  useEffect(() => {
    if (!selectedCorridor) return;
    setRailId((current) =>
      selectedCorridor.payoutRails.some((rail) => rail.rail === current)
        ? current
        : (selectedCorridor.payoutRails[0]?.rail ?? ""),
    );
  }, [selectedCorridor]);

  // The expiry countdown only needs to tick while a quote is on screen.
  useEffect(() => {
    if (!quote) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [quote]);

  async function getQuote(event: FormEvent) {
    event.preventDefault();
    if (!session || !selectedCorridor || !selectedRail) return;
    setPending("quote");
    setError(null);
    setQuote(null);
    try {
      const sourceAmount = toMinorUnits(amount, selectedCorridor.sourceCurrency);
      const result = await api.quoteSettlement(session.accessToken, {
        sourceCurrency: selectedCorridor.sourceCurrency,
        destinationCurrency: selectedCorridor.destinationCurrency,
        sourceAmount,
        payoutRail: selectedRail.rail,
      });
      setQuote(result);
      setNow(Date.now());
    } catch (err) {
      setError(message(err));
    } finally {
      setPending(null);
    }
  }

  function setField(name: PayoutFieldName, value: string) {
    setBeneficiary((current) => ({ ...current, [name]: value }));
    setFieldErrors((current) => {
      if (!current[name]) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  }

  /** Normalize on blur so the payer sees the value the scheme will receive. */
  function normalizeField(field: PayoutFieldSpec) {
    setBeneficiary((current) => {
      const raw = current[field.name];
      if (!raw) return current;
      return { ...current, [field.name]: normalizePayoutField(raw, field.transform) };
    });
  }

  async function execute() {
    if (!session || !quote || !selectedRail) return;
    setError(null);

    // The same validator the backend runs — IBAN mod-97, ABA checksum, NUBAN
    // check digit, UPI shape — so a typo is caught here, not at the anchor.
    const destination = {
      rail: selectedRail.rail,
      fields: beneficiary,
      ...(reference.trim() ? { reference: reference.trim() } : {}),
    };
    const validation = validatePayoutDestination(destination);
    if (!validation.ok) {
      const errors: Partial<Record<PayoutFieldName, string>> = {};
      for (const issue of validation.issues) errors[issue.field] = issue.message;
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});

    setPending("execute");
    try {
      await api.executeSettlement(session.accessToken, crypto.randomUUID(), {
        quoteId: quote.id,
        destination,
      });
      setQuote(null);
      setAmount("");
      setBeneficiary({});
      setReference("");
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
        <div className="p-lg sm:p-xl md:p-xxl">
          <span className="grid h-12 w-12 place-items-center rounded-lg bg-primary/10 text-primary">
            <Icon name="globe" className="h-6 w-6" />
          </span>
          <h2 className="mt-lg text-xl font-bold text-on-dark sm:text-2xl">Connect your wallet to settle cross-border</h2>
          <p className="mt-sm max-w-xl leading-7 text-muted-strong">
            Authenticate with SEP-10 to quote a corridor, route over path payments and AMM liquidity, and pay out to a local
            rail — UPI, IMPS, SEPA, ACH, or NIP — with every leg reconciled to the ledger.
          </p>
          <Link href="/" className="btn-primary mt-lg">Connect wallet <Icon name="arrow-right" className="h-4 w-4" /></Link>
        </div>
      </section>
    );
  }

  const completed = settlements.filter((item) => item.settlement.status === "completed").length;
  const visible = settlements.filter((details) => {
    const status = details.settlement.status;
    if (filter === "completed") return status === "completed";
    if (filter === "failed") return status === "failed";
    if (filter === "in_flight") return status !== "completed" && status !== "failed";
    return true;
  });

  return (
    <div>
      <section className="mb-lg grid gap-md sm:grid-cols-3">
        <Metric label="Destinations" value={String(countries.length)} detail={`${corridors.length} corridors`} icon="globe" />
        <Metric label="Settlements" value={String(settlements.length)} detail={`${completed} completed`} icon="network" />
        <Metric label="Local rails" value={String(selectedCorridor?.payoutRails.length ?? 0)} detail={selectedRail?.network ?? "Best-rate routing"} icon="sparkles" />
      </section>

      {error ? (
        <div role="alert" className="mb-lg flex items-start justify-between gap-md rounded-lg border border-status-rejected/30 bg-status-rejected/10 p-md text-sm text-status-rejected">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error" className="icon-button"><Icon name="x" className="h-4 w-4" /></button>
        </div>
      ) : null}

      <div className="grid items-start gap-lg xl:grid-cols-[minmax(0,1fr)_400px]">
        <section>
          <div className="mb-md flex flex-wrap items-center justify-between gap-sm">
            <h2 className="text-sm font-semibold text-on-dark">Your settlements</h2>
            <div role="tablist" aria-label="Filter settlements" className="flex flex-wrap gap-xxs rounded-pill border border-hairline-dark p-xxs">
              {FILTERS.map((item) => (
                <button
                  key={item.id}
                  role="tab"
                  type="button"
                  aria-selected={filter === item.id}
                  onClick={() => setFilter(item.id)}
                  className={`rounded-pill px-sm py-xs text-xs font-medium transition ${
                    filter === item.id ? "bg-surface-elevated-dark text-on-dark" : "text-muted hover:text-muted-strong"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="space-y-md">{Array.from({ length: 3 }).map((_, index) => <div key={index} className="panel-dark h-32 animate-pulse" />)}</div>
          ) : visible.length === 0 ? (
            <div className="panel-dark px-lg py-xxl text-center">
              <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-surface-elevated-dark text-muted"><Icon name="globe" /></span>
              <h3 className="mt-md font-semibold text-on-dark">
                {settlements.length === 0 ? "No settlements yet" : `No ${filter.replace("_", " ")} settlements`}
              </h3>
              <p className="mx-auto mt-xs max-w-md text-sm text-muted">
                {settlements.length === 0
                  ? "Pick a destination, choose a local payout rail, and quote your first cross-border transfer."
                  : "Try a different filter to see the rest of your settlement history."}
              </p>
            </div>
          ) : (
            <div className="space-y-md">
              {visible.map((details) => {
                const expanded = expandedId === details.settlement.id;
                const s = details.settlement;
                const payout = s.payout;
                return (
                  <article key={s.id} className="panel-dark overflow-hidden">
                    <div className="p-md sm:p-lg">
                      <div className="flex flex-col justify-between gap-md sm:flex-row sm:items-start">
                        <div>
                          <div className="flex flex-wrap items-center gap-sm">
                            <StatusPill status={s.status} />
                            <span className="rounded-pill border border-hairline-dark px-sm py-xs text-xs font-medium text-muted-strong capitalize">{s.route.type.replace(/_/g, " ")}</span>
                            <span className="rounded-pill border border-hairline-dark px-sm py-xs text-xs font-medium text-muted-strong">
                              {PAYOUT_COUNTRY_FLAG[payout.destination.country]} {payout.network}
                            </span>
                          </div>
                          {/* Source and destination each stay on their own line
                              until there is room for the inline form. Wrapped
                              mid-run, the arrow ends up beside the source
                              currency and the pair reads as the wrong rate. */}
                          <p className="mt-md flex flex-col gap-xxs font-mono text-xl font-semibold text-on-dark sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-sm sm:text-2xl">
                            <span className="whitespace-nowrap">{formatMinor(s.source.amount, s.source.currency)} <span className="text-base text-muted">{s.source.currency}</span></span>
                            <span aria-hidden="true" className="text-muted">→</span>
                            <span className="whitespace-nowrap">{formatMinor(payout.netAmount.amount, payout.netAmount.currency)} <span className="text-base text-muted">{payout.netAmount.currency}</span></span>
                          </p>
                          <p className="mt-xs text-xs text-muted">
                            Paid to <span className="font-mono text-body">{payout.destination.masked}</span>
                            <span className="text-muted"> · {payout.destination.holderMasked}</span>
                          </p>
                          <p className="mt-xxs font-mono text-[11px] text-muted" title={s.id}>Settlement · {s.id.slice(0, 10)}…{s.id.slice(-8)}</p>
                        </div>
                        <button type="button" aria-expanded={expanded} onClick={() => setExpandedId(expanded ? null : s.id)} className="btn-secondary-dark w-full sm:w-auto">
                          {expanded ? "Hide legs" : "View legs"}<Icon name="chevron-down" className={`h-4 w-4 transition ${expanded ? "rotate-180" : ""}`} />
                        </button>
                      </div>
                      {s.failureReason ? (
                        <p className="mt-md rounded-md border border-status-rejected/30 bg-status-rejected/10 p-sm text-xs text-status-rejected">{s.failureReason}</p>
                      ) : null}
                      <div className="mt-lg grid grid-cols-2 gap-md border-t border-hairline-dark pt-md sm:grid-cols-4">
                        <Detail label="Rate" value={s.route.effectiveRate} />
                        <Detail label="FX fee" value={`${formatMinor(s.route.fee.amount, s.route.fee.currency)} ${s.route.fee.currency}`} />
                        <Detail label={`${payout.network} fee`} value={`${formatMinor(payout.fee.amount, payout.fee.currency)} ${payout.fee.currency}`} />
                        <Detail label="Reconciliation" value={details.blockedByReconciliation ? "Mismatch" : "Healthy"} alert={details.blockedByReconciliation} />
                      </div>
                    </div>
                    {expanded ? (
                      <div className="border-t border-hairline-dark bg-canvas-dark/40 p-md sm:p-lg">
                        <p className="eyebrow">Settlement legs</p>
                        <ul className="mt-md space-y-sm">
                          {details.transitions.map((t) => (
                            <li key={t.id} className="flex flex-wrap items-center justify-between gap-sm rounded-md border border-hairline-dark bg-surface-card-dark px-md py-sm">
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
                          <div><dt className="text-xs text-muted">Corridor</dt><dd className="mt-xs break-all font-mono text-xs text-body">{s.corridorId}</dd></div>
                          <div><dt className="text-xs text-muted">Payout rail</dt><dd className="mt-xs font-mono text-xs text-body">{payout.rail} · {payout.network}</dd></div>
                          <div><dt className="text-xs text-muted">Remittance reference</dt><dd className="mt-xs break-all font-mono text-xs text-body">{s.destinationReference}</dd></div>
                          <div>
                            <dt className="text-xs text-muted">Beneficiary fingerprint</dt>
                            <dd className="mt-xs break-all font-mono text-xs text-body" title="SHA-256 of the beneficiary handle — the account itself is never stored">
                              {payout.destination.fingerprint.slice(0, 16)}…
                            </dd>
                          </div>
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
              <div><h2 className="font-semibold">New cross-border settlement</h2><p className="text-xs text-muted">Destination, rail, amount, beneficiary</p></div>
            </div>
          </div>

          <form onSubmit={getQuote} className="p-lg">
            <div className="space-y-md">
              <fieldset>
                <legend className="text-sm font-medium">Where is the money going?</legend>
                <div className="mt-xs flex flex-wrap gap-xs">
                  {countries.map((code) => (
                    <button
                      key={code}
                      type="button"
                      aria-pressed={country === code}
                      onClick={() => { setCountry(code); invalidateQuote(); }}
                      className={`rounded-pill border px-md py-sm text-xs font-medium transition ${
                        country === code
                          ? "border-primary bg-primary/15 text-primary-active"
                          : "border-hairline-light text-muted hover:text-ink"
                      }`}
                    >
                      {PAYOUT_COUNTRY_FLAG[code]} {PAYOUT_COUNTRY_LABEL[code]}
                    </button>
                  ))}
                </div>
              </fieldset>

              <label className="block text-sm font-medium">Send from
                <span className="mt-xs block">
                  <select
                    required
                    value={corridorId}
                    onChange={(event) => { setCorridorId(event.target.value); invalidateQuote(); }}
                    className="input"
                  >
                    {countryCorridors.map((corridor) => (
                      <option key={corridor.id} value={corridor.id}>
                        {corridor.sourceCurrency} → {corridor.destinationCurrency} · {corridor.anchorName}
                      </option>
                    ))}
                  </select>
                </span>
              </label>

              {selectedCorridor ? (
                <fieldset>
                  <legend className="text-sm font-medium">Local payout rail</legend>
                  <p className="mt-xxs text-xs text-muted">
                    Each scheme has its own fee, speed, and per-transfer cap — so it is priced into the quote.
                  </p>
                  <div className="mt-xs space-y-xs">
                    {selectedCorridor.payoutRails.map((rail) => {
                      const active = selectedRail?.rail === rail.rail;
                      return (
                        <button
                          key={rail.rail}
                          type="button"
                          aria-pressed={active}
                          onClick={() => { setRailId(rail.rail); setBeneficiary({}); setFieldErrors({}); invalidateQuote(); }}
                          className={`w-full rounded-lg border p-md text-left transition ${
                            active ? "border-primary bg-primary/10" : "border-hairline-light hover:border-muted"
                          }`}
                        >
                          <span className="flex flex-wrap items-baseline justify-between gap-xs">
                            <span className="text-sm font-semibold">{rail.label}</span>
                            <span className="font-mono text-xs text-muted">
                              {rail.flatFeeAmount === "0"
                                ? "no fee"
                                : `${formatMinor(rail.flatFeeAmount, rail.currency)} ${rail.currency}`}
                            </span>
                          </span>
                          <span className="mt-xxs flex flex-wrap items-center gap-xs text-xs text-muted">
                            <span className={rail.instant ? "text-status-verified" : ""}>{formatDuration(rail.estimatedSeconds)}</span>
                            <span aria-hidden="true">·</span>
                            <span>{rail.network}</span>
                            <span aria-hidden="true">·</span>
                            <span>max {formatMinor(rail.maxAmount, rail.currency)}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </fieldset>
              ) : null}

              <label className="block text-sm font-medium">Send amount
                <span className="relative mt-xs block">
                  <input
                    required
                    value={amount}
                    onChange={(event) => { setAmount(event.target.value); invalidateQuote(); }}
                    placeholder="0.00"
                    inputMode="decimal"
                    className="input pr-16 font-mono text-lg"
                  />
                  <span className="absolute right-sm top-1/2 -translate-y-1/2 font-mono text-xs font-semibold text-muted">{selectedCorridor?.sourceCurrency ?? ""}</span>
                </span>
                {selectedRail ? (
                  <span className="mt-xs block text-xs text-muted">{selectedRail.notes}</span>
                ) : null}
              </label>
            </div>

            <button disabled={pending !== null || !selectedRail} className="btn-primary mt-lg w-full">
              {pending === "quote" ? "Finding best route…" : "Get quote"}<Icon name="arrow-right" className="h-4 w-4" />
            </button>
          </form>

          {quote && selectedRail ? (
            <div className="border-t border-hairline-light p-lg">
              <div className="rounded-lg bg-surface-strong-light p-md">
                <div className="flex items-center justify-between gap-sm">
                  <span className="text-xs text-muted">Beneficiary receives</span>
                  <span className="rounded-pill bg-primary/15 px-sm py-xs text-[11px] font-semibold uppercase tracking-wide text-primary-active">{quote.route.type.replace(/_/g, " ")}</span>
                </div>
                <p className="mt-xs font-mono text-2xl font-semibold">
                  {formatMinor(quote.netDestinationAmount.amount, quote.netDestinationAmount.currency)}
                  <span className="ml-xs text-sm text-muted">{quote.netDestinationAmount.currency}</span>
                </p>
                <div className="mt-sm space-y-xs text-xs">
                  <Row label="Rate" value={`1 ${quote.source.currency} = ${quote.route.effectiveRate} ${quote.route.destinationAmount.currency}`} />
                  <Row label="Converted" value={`${formatMinor(quote.route.destinationAmount.amount, quote.route.destinationAmount.currency)} ${quote.route.destinationAmount.currency}`} />
                  <Row label="FX fee" value={`${formatMinor(quote.route.fee.amount, quote.route.fee.currency)} ${quote.route.fee.currency}`} />
                  <Row label={`${selectedRail.label} fee`} value={`${formatMinor(quote.payoutFee.amount, quote.payoutFee.currency)} ${quote.payoutFee.currency}`} />
                  <Row label="Slippage" value={`${quote.route.slippageBps} bps`} />
                  <Row label="Arrives in" value={formatDuration(quote.totalEstimatedSeconds)} />
                  <Row label="Routes considered" value={String(quote.consideredRoutes.length)} />
                </div>
                <p className={`mt-sm flex items-center gap-xs text-xs ${quoteExpired ? "text-status-rejected" : "text-muted"}`}>
                  <Icon name="clock" className="h-3.5 w-3.5" />
                  {quoteExpired
                    ? "This quote has expired — request a new one to lock the current rate."
                    : `Rate held for ${expiresIn}s`}
                </p>
              </div>

              <fieldset className="mt-md" disabled={quoteExpired}>
                <legend className="text-sm font-medium">
                  {PAYOUT_COUNTRY_FLAG[selectedRail.country]} Beneficiary · {selectedRail.label}
                </legend>
                <div className="mt-xs space-y-sm">
                  {selectedRail.fields.map((field) => (
                    <BeneficiaryField
                      key={field.name}
                      field={field}
                      value={beneficiary[field.name] ?? ""}
                      error={fieldErrors[field.name]}
                      onChange={(value) => setField(field.name, value)}
                      onBlur={() => normalizeField(field)}
                    />
                  ))}
                  <label className="block text-xs font-medium">
                    Remittance reference <span className="font-normal text-muted">(optional)</span>
                    <input
                      value={reference}
                      onChange={(event) => setReference(event.target.value)}
                      placeholder="invoice-4471"
                      maxLength={140}
                      className="input mt-xxs font-mono text-sm"
                    />
                    <span className="mt-xxs block text-[11px] text-muted">Shown on the beneficiary&apos;s bank statement.</span>
                  </label>
                </div>
              </fieldset>

              <button
                type="button"
                disabled={pending !== null || quoteExpired}
                onClick={() => void execute()}
                className="btn-primary mt-md w-full"
              >
                {pending === "execute" ? "Settling…" : quoteExpired ? "Quote expired" : "Settle now"}
                <Icon name="arrow-right" className="h-4 w-4" />
              </button>
              <p className="mt-md flex items-start gap-xs text-xs leading-5 text-muted">
                <Icon name="shield" className="mt-0.5 h-4 w-4 shrink-0" />
                Deposit, conversion, and payout each write a balanced ledger transaction reconciled against the anchor and
                chain. Only a masked beneficiary and a one-way fingerprint are stored — never the account itself.
              </p>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function BeneficiaryField({
  field,
  value,
  error,
  onChange,
  onBlur,
}: {
  field: PayoutFieldSpec;
  value: string;
  error?: string;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  const describedBy = `${field.name}-help`;
  return (
    <label className="block text-xs font-medium">
      {field.label}
      <input
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        placeholder={field.placeholder}
        maxLength={field.maxLength + 8 /* room for the spaces people type */}
        inputMode={field.inputMode}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`input mt-xxs font-mono text-sm ${error ? "border-status-rejected" : ""}`}
      />
      <span id={describedBy} className={`mt-xxs block text-[11px] ${error ? "text-status-rejected" : "text-muted"}`}>
        {error ?? field.help}
      </span>
    </label>
  );
}

function Metric({ label, value, detail, icon }: { label: string; value: string; detail: string; icon: "globe" | "network" | "sparkles" }) {
  return (
    <div className="panel-dark flex items-center justify-between p-lg">
      <div>
        <p className="text-xs font-medium text-muted">{label}</p>
        <p className="mt-xs break-words font-mono text-xl font-semibold text-on-dark sm:text-2xl">{value}</p>
        <p className="mt-xs text-xs text-muted">{detail}</p>
      </div>
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-surface-elevated-dark text-muted-strong"><Icon name={icon} /></span>
    </div>
  );
}

function Detail({ label, value, alert = false }: { label: string; value: string; alert?: boolean }) {
  return (
    <div>
      <dt className="data-label">{label}</dt>
      <dd className={`mt-xs text-xs font-medium ${alert ? "text-status-disputed" : "text-body"}`}>{value}</dd>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-md gap-y-xxs">
      <span className="text-muted">{label}</span>
      <span className="font-mono font-medium text-ink">{value}</span>
    </div>
  );
}
