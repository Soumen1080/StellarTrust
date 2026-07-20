"use client";

import { CurrencyCode, OrderStatus, type AuthSessionResponse, type OrderDetailsResponse } from "@stellartrust/shared";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { loadSession } from "@/lib/wallet-auth";

type Action = "accept" | "deposit" | "lock" | "confirm" | "release";
type Filter = "all" | "action" | "active" | "complete";

const FLOW = ["created", "accepted", "deposited", "locked", "confirmed", "released"];
const ACTION_LABEL: Record<Action, string> = { accept: "Accept order", deposit: "Deposit funds", lock: "Lock in escrow", confirm: "Confirm delivery", release: "Release payment" };

export function EscrowDashboard() {
  const [session, setSession] = useState<AuthSessionResponse | null>(null);
  const [orders, setOrders] = useState<OrderDetailsResponse[]>([]);
  const [sellerId, setSellerId] = useState("");
  const [amount, setAmount] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const refresh = useCallback(async (active: AuthSessionResponse) => { const response = await api.listOrders(active.accessToken); setOrders(response.orders); }, []);

  useEffect(() => {
    const active = loadSession();
    setSession(active);
    if (!active) { setLoading(false); return; }
    void refresh(active).catch((err: unknown) => setError(message(err))).finally(() => setLoading(false));
  }, [refresh]);

  async function createOrder(event: FormEvent) {
    event.preventDefault();
    if (!session) return;
    setPendingId("create"); setError(null);
    try {
      const minorUnits = Math.round(Number(amount) * 100);
      if (!Number.isSafeInteger(minorUnits) || minorUnits <= 0) throw new Error("Enter a positive amount with no more than two decimals");
      await api.createOrder(session.accessToken, crypto.randomUUID(), { sellerId: sellerId.trim(), amount: { amount: String(minorUnits), currency: CurrencyCode.USDC } });
      setSellerId(""); setAmount(""); await refresh(session);
    } catch (err) { setError(message(err)); }
    finally { setPendingId(null); }
  }

  async function advance(orderId: string, action: Action) {
    if (!session) return;
    setPendingId(orderId); setError(null);
    try { await api.transitionOrder(session.accessToken, orderId, action, crypto.randomUUID()); await refresh(session); }
    catch (err) { setError(message(err)); }
    finally { setPendingId(null); }
  }

  const visibleOrders = useMemo(() => orders.filter((details) => {
    const status = String(details.order.status);
    const matchesQuery = !query || details.order.id.toLowerCase().includes(query.toLowerCase()) || details.order.sellerId.toLowerCase().includes(query.toLowerCase()) || details.order.buyerId.toLowerCase().includes(query.toLowerCase());
    if (!matchesQuery) return false;
    if (filter === "action") return session ? nextAction(details, session.user.id) !== null : false;
    if (filter === "complete") return ["released", "refunded", "cancelled"].includes(status);
    if (filter === "active") return !["released", "refunded", "cancelled"].includes(status);
    return true;
  }), [filter, orders, query, session]);

  const total = orders.reduce((sum, details) => sum + Number(details.order.amount.amount), 0) / 100;
  const actionCount = session ? orders.filter((details) => nextAction(details, session.user.id)).length : 0;
  const protectedCount = orders.filter((details) => ["deposited", "locked", "confirmed"].includes(String(details.order.status))).length;

  if (!session) return <section className="panel-dark overflow-hidden"><div className="grid lg:grid-cols-[1fr_.7fr]"><div className="p-xl sm:p-xxl"><span className="grid h-12 w-12 place-items-center rounded-lg bg-primary/10 text-primary"><Icon name="wallet" className="h-6 w-6" /></span><h2 className="mt-lg text-2xl font-bold text-on-dark">Connect your wallet to open escrow</h2><p className="mt-sm max-w-xl leading-7 text-muted-strong">Authenticate with SEP-10 to create orders, view transactions tied to your account, and approve eligible lifecycle steps.</p><Link href="/" className="btn-primary mt-lg">Connect wallet <Icon name="arrow-right" className="h-4 w-4" /></Link></div><div className="border-t border-hairline-dark bg-surface-elevated-dark/40 p-xl lg:border-l lg:border-t-0"><p className="text-sm font-semibold text-on-dark">Escrow lifecycle</p><div className="mt-lg space-y-md">{FLOW.map((step, index) => <div key={step} className="flex items-center gap-sm"><span className="grid h-7 w-7 place-items-center rounded-full border border-hairline-dark font-mono text-xs text-muted">{index + 1}</span><span className="text-sm capitalize text-muted-strong">{step}</span></div>)}</div></div></div></section>;

  return <div>
    <section className="mb-lg grid gap-md sm:grid-cols-3"><Metric label="Portfolio value" value={`${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`} detail={`${orders.length} total order${orders.length === 1 ? "" : "s"}`} icon="wallet"/><Metric label="Protected orders" value={String(protectedCount)} detail="Deposited or escrowed" icon="lock"/><Metric label="Action required" value={String(actionCount)} detail={actionCount ? "Review your next steps" : "You are all caught up"} icon="clock" attention={actionCount > 0}/></section>

    {error ? <div role="alert" className="mb-lg flex items-start justify-between gap-md rounded-lg border border-status-rejected/30 bg-status-rejected/10 p-md text-sm text-status-rejected"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss error"><Icon name="x" className="h-4 w-4" /></button></div> : null}

    <div className="grid items-start gap-lg xl:grid-cols-[minmax(0,1fr)_360px]">
      <section>
        <div className="mb-md flex flex-col gap-sm lg:flex-row lg:items-center lg:justify-between"><div className="flex gap-xs overflow-x-auto pb-1">{(["all", "action", "active", "complete"] as Filter[]).map((item) => <button key={item} type="button" onClick={() => setFilter(item)} className={`min-h-9 whitespace-nowrap rounded-md px-md text-sm font-medium capitalize transition ${filter === item ? "bg-primary text-ink" : "bg-surface-card-dark text-muted-strong hover:text-on-dark"}`}>{item === "action" ? `Needs action${actionCount ? ` (${actionCount})` : ""}` : item}</button>)}</div><label className="relative block min-w-0 lg:w-72"><span className="sr-only">Search orders</span><span className="pointer-events-none absolute left-sm top-1/2 -translate-y-1/2 text-muted">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search order or participant" className="input-dark pl-xl" /></label></div>

        {loading ? <div className="space-y-md">{Array.from({ length: 3 }).map((_, index) => <div key={index} className="panel-dark h-44 animate-pulse" />)}</div> : visibleOrders.length === 0 ? <div className="panel-dark px-lg py-xxl text-center"><span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-surface-elevated-dark text-muted"><Icon name="document" /></span><h2 className="mt-md font-semibold text-on-dark">{orders.length ? "No matching orders" : "No escrow orders yet"}</h2><p className="mx-auto mt-xs max-w-md text-sm text-muted">{orders.length ? "Try a different filter or search term." : "Create your first protected payment using the order form."}</p>{orders.length ? <button type="button" onClick={() => { setFilter("all"); setQuery(""); }} className="mt-md text-sm font-semibold text-primary">Clear filters</button> : null}</div> : <div className="space-y-md">{visibleOrders.map((details) => {
          const action = nextAction(details, session.user.id);
          const expanded = expandedId === details.order.id;
          const currentIndex = Math.max(0, FLOW.indexOf(String(details.order.status)));
          return <article key={details.order.id} className="panel-dark overflow-hidden"><div className="p-lg"><div className="flex flex-col justify-between gap-md sm:flex-row sm:items-start"><div><div className="flex flex-wrap items-center gap-sm"><StatusPill status={details.order.status}/>{action ? <span className="rounded-pill border border-primary/30 bg-primary/10 px-sm py-xs text-xs font-semibold text-primary">Action required</span> : null}</div><p className="mt-md font-mono text-2xl font-semibold text-on-dark">{(Number(details.order.amount.amount) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })} <span className="text-base text-muted">{details.order.amount.currency}</span></p><p className="mt-xs font-mono text-[11px] text-muted" title={details.order.id}>Order · {shortId(details.order.id)}</p></div><div className="flex flex-wrap gap-sm">{action ? <button type="button" disabled={pendingId !== null || details.blockedByReconciliation} onClick={() => void advance(details.order.id, action)} className="btn-primary">{pendingId === details.order.id ? "Processing…" : ACTION_LABEL[action]}<Icon name="arrow-right" className="h-4 w-4" /></button> : null}<button type="button" onClick={() => setExpandedId(expanded ? null : details.order.id)} className="btn-secondary-dark">{expanded ? "Hide details" : "View details"}<Icon name="chevron-down" className={`h-4 w-4 transition ${expanded ? "rotate-180" : ""}`} /></button></div></div>
          <div className="mt-lg grid grid-cols-2 gap-md border-t border-hairline-dark pt-md sm:grid-cols-4"><Detail label="Your role" value={details.order.buyerId === session.user.id ? "Buyer" : details.order.sellerId === session.user.id ? "Seller" : "Participant"}/><Detail label="Chain steps" value={String(details.transitions.length)}/><Detail label="Escrow" value={details.escrow ? "Contract linked" : "Not locked"}/><Detail label="Reconciliation" value={details.blockedByReconciliation ? "Mismatch" : "Healthy"} alert={details.blockedByReconciliation}/></div>
          {details.blockedByReconciliation ? <p role="alert" className="mt-md flex gap-xs rounded-md bg-status-disputed/10 p-sm text-sm text-status-disputed"><Icon name="shield" className="h-4 w-4 shrink-0" />Operations are blocked until the ledger-to-chain mismatch is resolved.</p> : null}</div>
          {expanded ? <div className="border-t border-hairline-dark bg-canvas-dark/40 p-lg"><p className="eyebrow">Settlement progress</p><div className="mt-md grid gap-xs sm:grid-cols-6">{FLOW.map((step, index) => <div key={step} className="flex items-center gap-xs sm:block"><span className={`grid h-7 w-7 place-items-center rounded-full text-xs ${index <= currentIndex ? "bg-status-verified/10 text-status-verified" : "border border-hairline-dark text-muted"}`}>{index <= currentIndex ? <Icon name="check" className="h-3.5 w-3.5" /> : index + 1}</span><p className={`mt-xs text-xs capitalize ${index <= currentIndex ? "text-body" : "text-muted"}`}>{step}</p></div>)}</div><dl className="mt-lg grid gap-md border-t border-hairline-dark pt-md sm:grid-cols-2"><div><dt className="text-xs text-muted">Buyer ID</dt><dd className="mt-xs break-all font-mono text-xs text-body">{details.order.buyerId}</dd></div><div><dt className="text-xs text-muted">Seller ID</dt><dd className="mt-xs break-all font-mono text-xs text-body">{details.order.sellerId}</dd></div><div className="sm:col-span-2"><dt className="text-xs text-muted">Contract ID</dt><dd className="mt-xs break-all font-mono text-xs text-body">{details.escrow?.contractId ?? "Contract will be created when funds are locked"}</dd></div></dl></div> : null}</article>;
        })}</div>}
      </section>

      <aside className="panel-light overflow-hidden text-ink xl:sticky xl:top-24"><div className="border-b border-hairline-light p-lg"><div className="flex items-center gap-sm"><span className="grid h-10 w-10 place-items-center rounded-lg bg-primary/20 text-primary-active"><Icon name="lock" /></span><div><h2 className="font-semibold">Create escrow order</h2><p className="text-xs text-muted">Protected testnet payment</p></div></div></div><form onSubmit={createOrder} className="p-lg"><div className="space-y-md"><label className="block text-sm font-medium">Seller user ID<span className="mt-xs block"><input required value={sellerId} onChange={(event) => setSellerId(event.target.value)} placeholder="Paste the seller's user ID" className="input font-mono" /></span></label><label className="block text-sm font-medium">Amount<span className="relative mt-xs block"><input required min="0.01" step="0.01" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" className="input pr-16 font-mono text-lg"/><span className="absolute right-sm top-1/2 -translate-y-1/2 font-mono text-xs font-semibold text-muted">USDC</span></span></label></div><div className="mt-lg rounded-lg bg-surface-strong-light p-md"><div className="flex justify-between text-xs"><span className="text-muted">Network</span><span className="font-medium">Stellar testnet</span></div><div className="mt-sm flex justify-between text-xs"><span className="text-muted">Settlement record</span><span className="font-medium">Ledger + chain</span></div><div className="mt-sm flex justify-between text-xs"><span className="text-muted">Estimated network fee</span><span className="font-mono font-medium">Calculated at deposit</span></div></div><button disabled={pendingId !== null} className="btn-primary mt-lg w-full">{pendingId === "create" ? "Creating order…" : "Create protected order"}<Icon name="arrow-right" className="h-4 w-4" /></button><p className="mt-md flex items-start gap-xs text-xs leading-5 text-muted"><Icon name="shield" className="mt-0.5 h-4 w-4 shrink-0"/>Funds are not moved when the order is created. The buyer explicitly deposits in a later step.</p></form></aside>
    </div>
  </div>;
}

function Metric({ label, value, detail, icon, attention = false }: { label: string; value: string; detail: string; icon: "wallet" | "lock" | "clock"; attention?: boolean }) { return <div className="panel-dark flex items-center justify-between p-lg"><div><p className="text-xs font-medium text-muted">{label}</p><p className={`mt-xs font-mono text-2xl font-semibold ${attention ? "text-primary" : "text-on-dark"}`}>{value}</p><p className="mt-xs text-xs text-muted">{detail}</p></div><span className="grid h-10 w-10 place-items-center rounded-lg bg-surface-elevated-dark text-muted-strong"><Icon name={icon}/></span></div>; }
function Detail({ label, value, alert = false }: { label: string; value: string; alert?: boolean }) { return <div><dt className="text-[10px] uppercase tracking-wider text-muted">{label}</dt><dd className={`mt-xs text-xs font-medium ${alert ? "text-status-disputed" : "text-body"}`}>{value}</dd></div>; }
function shortId(value: string) { return value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value; }
function nextAction(details: OrderDetailsResponse, userId: string): Action | null { const { order } = details; if (order.status === OrderStatus.Created && order.sellerId === userId) return "accept"; if (order.buyerId !== userId) return null; if (order.status === OrderStatus.Accepted) return "deposit"; if (order.status === OrderStatus.Deposited) return "lock"; if (order.status === OrderStatus.Locked) return "confirm"; if (order.status === OrderStatus.Confirmed) return "release"; return null; }
function message(error: unknown): string { return error instanceof Error ? error.message : "The escrow operation failed"; }
