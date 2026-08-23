"use client";

import { CurrencyCode, EscrowState, LEDGER_CURRENCY_DECIMALS, OrderStatus, type OrderDetailsResponse } from "@stellartrust/shared";
import Link from "next/link";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { CopyableId } from "@/components/CopyableId";
import { Icon } from "@/components/Icon";
import { useIdentity } from "@/components/IdentityProvider";
import { StatusPill } from "@/components/StatusPill";
import { WalletBalances } from "@/features/wallet/WalletBalances";
import { api } from "@/lib/api";
import { fromMinorUnits, toMinorUnits } from "@/lib/money";
import { PHASE_LABEL, useEscrowOrders, type EscrowAction } from "./useEscrowOrders";

function explorerTxUrl(hash: string, network: "testnet" | "public" | undefined): string {
  return `https://stellar.expert/explorer/${network === "public" ? "public" : "testnet"}/tx/${hash}`;
}

type Filter = "all" | "action" | "active" | "complete";

const FLOW = ["created", "accepted", "deposited", "locked", "confirmed", "released"];
function minStep(currency: CurrencyCode): string { return (1 / 10 ** LEDGER_CURRENCY_DECIMALS[currency]).toFixed(LEDGER_CURRENCY_DECIMALS[currency]); }
const ACTION_LABEL: Record<EscrowAction, string> = { accept: "Accept order", deposit: "Deposit funds", lock: "Lock in escrow", confirm: "Confirm delivery", release: "Release payment", dispute: "Raise dispute" };

export function EscrowDashboard() {
  const { session } = useIdentity();
  const { orders, capabilities, loading, error, running, needsWallet, runAction, refresh, clearError } = useEscrowOrders(session);
  const [sellerId, setSellerId] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<CurrencyCode>(CurrencyCode.XLM);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Bumped after every escrow action so the wallet balance widget re-fetches
  // from Horizon and actually shows funds moving, instead of only the order
  // list updating.
  const [walletRefreshTick, setWalletRefreshTick] = useState(0);

  const busy = running !== null || creating;
  async function runActionAndSyncBalance(orderId: string, action: EscrowAction) {
    await runAction(orderId, action);
    setWalletRefreshTick((tick) => tick + 1);
  }
  const currencyOptions = capabilities?.supportedCurrencies?.length
    ? capabilities.supportedCurrencies
    : [CurrencyCode.XLM];
  useEffect(() => {
    if (!currencyOptions.includes(currency)) setCurrency(currencyOptions[0]);
  }, [currency, currencyOptions]);

  async function createOrder(event: FormEvent) {
    event.preventDefault();
    if (!session || busy) return;
    setCreating(true); setCreateError(null);
    try {
      const minorUnits = toMinorUnits(amount, currency);
      if (!minorUnits || BigInt(minorUnits) <= 0n) throw new Error(`Enter a positive amount for ${currency}`);
      await api.createOrder(session.accessToken, crypto.randomUUID(), { sellerId: sellerId.trim(), amount: { amount: minorUnits, currency } });
      setSellerId(""); setAmount(""); await refresh();
    } catch (err) { setCreateError(err instanceof Error ? err.message : "Could not create the order"); }
    finally { setCreating(false); }
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

  // USDC-only: summing raw minor units across currencies with different
  // ledger scales (2dp USDC vs 7dp XLM) would mix incompatible units.
  const usdcOrders = orders.filter((details) => details.order.amount.currency === CurrencyCode.USDC);
  const total = usdcOrders.reduce((sum, details) => sum + Number(details.order.amount.amount), 0) / 100;
  const actionCount = session ? orders.filter((details) => nextAction(details, session.user.id)).length : 0;
  const protectedCount = orders.filter((details) => ["deposited", "locked", "confirmed"].includes(String(details.order.status))).length;
  const banner = error ?? createError;

  if (!session) return <section className="panel-dark overflow-hidden"><div className="grid lg:grid-cols-[1fr_.7fr]"><div className="p-lg sm:p-xl md:p-xxl"><span className="grid h-12 w-12 place-items-center rounded-lg bg-primary/10 text-primary"><Icon name="wallet" className="h-6 w-6" /></span><h2 className="mt-lg text-xl font-bold text-on-dark sm:text-2xl">Connect your wallet to open escrow</h2><p className="mt-sm max-w-xl leading-7 text-muted-strong">Authenticate with SEP-10 to create orders, view transactions tied to your account, and approve eligible lifecycle steps.</p><Link href="/" className="btn-primary mt-lg">Connect wallet <Icon name="arrow-right" className="h-4 w-4" /></Link></div><div className="border-t border-hairline-dark bg-surface-elevated-dark/40 p-lg sm:p-xl lg:border-l lg:border-t-0"><p className="text-sm font-semibold text-on-dark">Escrow lifecycle</p><div className="mt-lg space-y-md">{FLOW.map((step, index) => <div key={step} className="flex items-center gap-sm"><span className="grid h-7 w-7 place-items-center rounded-full border border-hairline-dark font-mono text-xs text-muted">{index + 1}</span><span className="text-sm capitalize text-muted-strong">{step}</span></div>)}</div></div></div></section>;

  return <div>
    <section className="mb-lg grid gap-md sm:grid-cols-3"><Metric label="Historical order volume" value={`${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`} detail={`${usdcOrders.length} USDC order${usdcOrders.length === 1 ? "" : "s"} of ${orders.length} total`} icon="wallet"/><Metric label="Protected orders" value={String(protectedCount)} detail="Deposited or escrowed" icon="lock"/><Metric label="Action required" value={String(actionCount)} detail={actionCount ? "Review your next steps" : "You are all caught up"} icon="clock" attention={actionCount > 0}/></section>

    {capabilities?.gateway === "deterministic" ? <div role="status" className="mb-lg flex items-start gap-sm rounded-lg border border-status-disputed/30 bg-status-disputed/10 p-md text-sm text-status-disputed"><Icon name="shield" className="mt-0.5 h-4 w-4 shrink-0" /><span>Simulation mode: this deployment is not connected to Stellar. Escrow actions update records here only — no XLM or other assets actually move on-chain.</span></div> : null}

    {banner ? <div role="alert" className="mb-lg flex items-start justify-between gap-md rounded-lg border border-status-rejected/30 bg-status-rejected/10 p-md text-sm text-status-rejected"><span>{banner}</span><button type="button" onClick={() => { clearError(); setCreateError(null); }} aria-label="Dismiss error" className="icon-button"><Icon name="x" className="h-4 w-4" /></button></div> : null}

    <div className="grid items-start gap-lg xl:grid-cols-[minmax(0,1fr)_360px]">
      <section>
        <div className="mb-md flex flex-col gap-sm lg:flex-row lg:items-center lg:justify-between"><div className="chip-row">{(["all", "action", "active", "complete"] as Filter[]).map((item) => <button key={item} type="button" aria-pressed={filter === item} onClick={() => setFilter(item)} className={`chip ${filter === item ? "bg-primary text-ink" : "bg-surface-card-dark text-muted-strong hover:text-on-dark"}`}>{item === "action" ? `Needs action${actionCount ? ` (${actionCount})` : ""}` : item}</button>)}</div><label className="relative block min-w-0 lg:w-72"><span className="sr-only">Search orders</span><span className="pointer-events-none absolute left-sm top-1/2 -translate-y-1/2 text-muted">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search order or participant" className="input-dark pl-xl" /></label></div>

        {loading ? <div className="space-y-md">{Array.from({ length: 3 }).map((_, index) => <div key={index} className="panel-dark h-44 animate-pulse" />)}</div> : visibleOrders.length === 0 ? <div className="panel-dark px-lg py-xxl text-center"><span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-surface-elevated-dark text-muted"><Icon name="document" /></span><h2 className="mt-md font-semibold text-on-dark">{orders.length ? "No matching orders" : "No escrow orders yet"}</h2><p className="mx-auto mt-xs max-w-md text-sm text-muted">{orders.length ? "Try a different filter or search term." : "Create your first protected payment using the order form."}</p>{orders.length ? <button type="button" onClick={() => { setFilter("all"); setQuery(""); }} className="mt-md text-sm font-semibold text-primary">Clear filters</button> : null}</div> : <div className="space-y-md">{visibleOrders.map((details) => {
          const action = nextAction(details, session.user.id);
          const expanded = expandedId === details.order.id;
          const orderStatus = String(details.order.status);
          const branchState = ["refunded", "disputed", "cancelled"].includes(orderStatus) ? orderStatus : null;
          const currentIndex = Math.max(0, FLOW.indexOf(orderStatus));
          const timeline = branchState ? [...FLOW.slice(0, Math.min(Math.max(details.transitions.length, 1), FLOW.length - 1)), branchState] : FLOW;
          const active = running?.orderId === details.order.id ? running : null;
          const canDispute = details.escrow?.state === EscrowState.Locked && needsWallet("dispute");
          return <article key={details.order.id} className="panel-dark overflow-hidden"><div className="p-md sm:p-lg"><div className="flex flex-col justify-between gap-md sm:flex-row sm:items-start"><div className="min-w-0"><div className="flex flex-wrap items-center gap-sm"><StatusPill status={details.order.status}/>{action ? <span className="rounded-pill border border-primary/30 bg-primary/10 px-sm py-xs text-xs font-semibold text-primary">Action required</span> : null}{action && needsWallet(action) ? <span className="rounded-pill border border-hairline-dark px-sm py-xs text-xs font-medium text-muted-strong" title="This step is authorized by your wallet signature, not the server">Wallet signature</span> : null}</div><p className="mt-md break-words font-mono text-xl font-semibold text-on-dark sm:text-2xl">{fromMinorUnits(details.order.amount.amount, details.order.amount.currency).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 7 })} <span className="text-base text-muted">{details.order.amount.currency}</span></p><p className="mt-xs font-mono text-[11px] text-muted" title={details.order.id}>Order · {shortId(details.order.id)}</p></div><div className="flex flex-col gap-sm sm:flex-row sm:flex-wrap">{action ? <button type="button" disabled={busy || details.blockedByReconciliation} onClick={() => void runActionAndSyncBalance(details.order.id, action)} className="btn-primary w-full sm:w-auto">{active ? PHASE_LABEL[active.phase] : ACTION_LABEL[action]}<Icon name="arrow-right" className="h-4 w-4" /></button> : null}{canDispute ? <button type="button" disabled={busy || details.blockedByReconciliation} onClick={() => void runActionAndSyncBalance(details.order.id, "dispute")} className="btn-secondary-dark w-full sm:w-auto">{active?.action === "dispute" ? PHASE_LABEL[active.phase] : "Raise dispute"}</button> : null}<button type="button" aria-expanded={expanded} aria-controls={`order-details-${details.order.id}`} onClick={() => setExpandedId(expanded ? null : details.order.id)} className="btn-secondary-dark w-full sm:w-auto">{expanded ? "Hide details" : "View details"}<Icon name="chevron-down" className={`h-4 w-4 transition ${expanded ? "rotate-180" : ""}`} /></button></div></div>
          <div className="mt-lg grid grid-cols-2 gap-md border-t border-hairline-dark pt-md sm:grid-cols-4"><Detail label="Your role" value={details.order.buyerId === session.user.id ? "Buyer" : details.order.sellerId === session.user.id ? "Seller" : "Participant"}/><Detail label="Chain steps" value={String(details.transitions.length)}/><Detail label="Escrow" value={escrowLabel(details)}/><Detail label="Reconciliation" value={details.blockedByReconciliation ? "Mismatch" : "Healthy"} alert={details.blockedByReconciliation}/></div>
          {(() => {
            const lastOnChain = [...details.transitions].reverse().find((t) => t.stellarTransaction.hash);
            if (!lastOnChain) return null;
            const hash = lastOnChain.stellarTransaction.hash as string;
            return <p className="mt-md flex items-center gap-xs text-xs text-muted">On-chain <a href={explorerTxUrl(hash, capabilities?.network)} target="_blank" rel="noreferrer" className="font-mono text-primary hover:underline">{shortId(hash)}</a></p>;
          })()}
          {active ? <p role="status" className="mt-md flex items-center gap-xs rounded-md bg-primary/10 p-sm text-sm text-primary"><span className="h-2 w-2 animate-pulse rounded-full bg-primary" />{PHASE_LABEL[active.phase]}{active.phase === "signing" ? " Approve the transaction in your wallet extension." : null}</p> : null}
          {details.blockedByReconciliation ? <p role="alert" className="mt-md flex gap-xs rounded-md bg-status-disputed/10 p-sm text-sm text-status-disputed"><Icon name="shield" className="h-4 w-4 shrink-0" />Operations are blocked until the ledger-to-chain mismatch is resolved.</p> : null}</div>
          {expanded ? <div id={`order-details-${details.order.id}`} className="border-t border-hairline-dark bg-canvas-dark/40 p-md sm:p-lg"><p className="eyebrow">Settlement progress</p><div className="mt-md grid gap-xs sm:grid-cols-3 lg:grid-cols-6">{timeline.map((step, index) => { const complete = branchState ? true : index <= currentIndex; const terminal = step === branchState; return <div key={step} className="flex items-center gap-xs sm:block"><span className={`grid h-7 w-7 place-items-center rounded-full text-xs ${terminal ? "bg-status-disputed/10 text-status-disputed" : complete ? "bg-status-verified/10 text-status-verified" : "border border-hairline-dark text-muted"}`}>{complete ? (terminal ? "!" : <Icon name="check" className="h-3.5 w-3.5" />) : index + 1}</span><p className={`mt-xs text-xs capitalize ${terminal ? "text-status-disputed" : complete ? "text-body" : "text-muted"}`}>{step}</p></div>; })}</div><dl className="mt-lg grid gap-md border-t border-hairline-dark pt-md sm:grid-cols-2"><div><dt className="text-xs text-muted">Buyer ID</dt><dd className="mt-xs break-all font-mono text-xs text-body">{details.order.buyerId}</dd></div><div><dt className="text-xs text-muted">Seller ID</dt><dd className="mt-xs break-all font-mono text-xs text-body">{details.order.sellerId}</dd></div><div className="sm:col-span-2"><dt className="text-xs text-muted">Custody contract</dt><dd className="mt-xs break-all font-mono text-xs text-body">{details.escrow?.contractId ?? "Created when you lock funds"}</dd></div></dl></div> : null}</article>;
        })}</div>}
      </section>

      <aside className="panel-light overflow-hidden text-ink xl:sticky xl:top-24"><div className="border-b border-hairline-light bg-canvas-dark/60 p-lg"><p className="text-xs font-medium text-muted-strong">Your wallet balance</p><div className="mt-sm"><WalletBalances accessToken={session.accessToken} refreshKey={walletRefreshTick} /></div></div><div className="border-b border-hairline-light p-lg"><div className="flex items-center gap-sm"><span className="grid h-10 w-10 place-items-center rounded-lg bg-primary/20 text-primary-active"><Icon name="lock" /></span><div><h2 className="font-semibold">Create escrow order</h2><p className="text-xs text-muted">Protected {capabilities?.network === "public" ? "mainnet" : "testnet"} payment</p></div></div></div><form onSubmit={createOrder} className="p-lg"><CopyableId label="Your user ID" value={session.user.id} hint="Share this with a buyer so they can open an order with you as the seller." /><div className="mt-md space-y-md"><label className="block text-sm font-medium">Seller user ID<span className="mt-xs block"><input required value={sellerId} onChange={(event) => setSellerId(event.target.value)} placeholder="3f2b1a90-5c47-4d1e-9a8b-7c6d5e4f3a2b" className="input font-mono" /></span><span className="mt-xs block text-xs leading-5 text-muted">The seller&apos;s user ID, which they copy from this page. Not a wallet address.</span></label><label className="block text-sm font-medium">Amount<span className="relative mt-xs block"><input required min={minStep(currency)} step={minStep(currency)} type="number" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" className="input pr-20 font-mono text-lg"/><select value={currency} onChange={(event) => setCurrency(event.target.value as CurrencyCode)} aria-label="Currency" className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md border-0 bg-transparent font-mono text-xs font-semibold text-muted">{currencyOptions.map((code) => <option key={code} value={code}>{code}</option>)}</select></span></label></div><div className="mt-lg rounded-lg bg-surface-strong-light p-md"><div className="flex justify-between text-xs"><span className="text-muted">Network</span><span className="font-medium">Stellar {capabilities?.network ?? "testnet"}</span></div><div className="mt-sm flex justify-between text-xs"><span className="text-muted">Settlement record</span><span className="font-medium">Ledger + chain</span></div><div className="mt-sm flex justify-between text-xs"><span className="text-muted">Lock authorization</span><span className="font-medium">{capabilities?.walletSignedTransitions.length ? "Your wallet" : "Server signer"}</span></div></div><button disabled={busy} className="btn-primary mt-lg w-full">{creating ? "Creating order…" : "Create protected order"}<Icon name="arrow-right" className="h-4 w-4" /></button><p className="mt-md flex items-start gap-xs text-xs leading-5 text-muted"><Icon name="shield" className="mt-0.5 h-4 w-4 shrink-0"/>{capabilities?.walletSignedTransitions.length ? "No funds move when the order is created. You approve the transfer in your wallet at the lock step." : "Funds are not moved when the order is created. The buyer explicitly deposits in a later step."}</p></form></aside>
    </div>
  </div>;
}

function Metric({ label, value, detail, icon, attention = false }: { label: string; value: string; detail: string; icon: "wallet" | "lock" | "clock"; attention?: boolean }) { return <div className="panel-dark flex items-center justify-between gap-md p-lg"><div className="min-w-0"><p className="text-xs font-medium text-muted">{label}</p><p className={`mt-xs break-words font-mono text-xl font-semibold sm:text-2xl ${attention ? "text-primary" : "text-on-dark"}`}>{value}</p><p className="mt-xs text-xs text-muted">{detail}</p></div><span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-surface-elevated-dark text-muted-strong"><Icon name={icon}/></span></div>; }
function Detail({ label, value, alert = false }: { label: string; value: string; alert?: boolean }) { return <div><dt className="data-label">{label}</dt><dd className={`mt-xs text-xs font-medium ${alert ? "text-status-disputed" : "text-body"}`}>{value}</dd></div>; }
function shortId(value: string) { return value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value; }

/** Custody in the user's terms, including the deploy-before-lock gap. */
function escrowLabel(details: OrderDetailsResponse): string {
  if (!details.escrow) return "Not created";
  switch (details.escrow.state) {
    case EscrowState.Pending: return "Awaiting your signature";
    case EscrowState.Locked: return "Funds held";
    case EscrowState.Released: return "Released";
    case EscrowState.Refunded: return "Refunded";
    case EscrowState.Disputed: return "Disputed";
    default: return "Linked";
  }
}

function nextAction(details: OrderDetailsResponse, userId: string): EscrowAction | null {
  const { order } = details;
  if (order.status === OrderStatus.Created && order.sellerId === userId) return "accept";
  if (order.buyerId !== userId) return null;
  if (order.status === OrderStatus.Accepted) return "deposit";
  if (order.status === OrderStatus.Deposited) return "lock";
  if (order.status === OrderStatus.Locked) return "confirm";
  if (order.status === OrderStatus.Confirmed) return "release";
  return null;
}
