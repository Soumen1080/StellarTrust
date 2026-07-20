"use client";

import {
  CurrencyCode,
  OrderStatus,
  type AuthSessionResponse,
  type OrderDetailsResponse,
} from "@stellartrust/shared";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { loadSession } from "@/lib/wallet-auth";

type Action = "accept" | "deposit" | "lock" | "confirm" | "release";

export function EscrowDashboard() {
  const [session, setSession] = useState<AuthSessionResponse | null>(null);
  const [orders, setOrders] = useState<OrderDetailsResponse[]>([]);
  const [sellerId, setSellerId] = useState("");
  const [amount, setAmount] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (active: AuthSessionResponse) => {
    const response = await api.listOrders(active.accessToken);
    setOrders(response.orders);
  }, []);

  useEffect(() => {
    const active = loadSession();
    setSession(active);
    if (active) void refresh(active).catch((err: unknown) => setError(message(err)));
  }, [refresh]);

  async function createOrder(event: FormEvent) {
    event.preventDefault();
    if (!session) return;
    setPending(true);
    setError(null);
    try {
      const minorUnits = Math.round(Number(amount) * 100);
      if (!Number.isSafeInteger(minorUnits) || minorUnits <= 0) {
        throw new Error("Enter a positive amount with no more than two decimals");
      }
      await api.createOrder(session.accessToken, crypto.randomUUID(), {
        sellerId: sellerId.trim(),
        amount: { amount: String(minorUnits), currency: CurrencyCode.USDC },
      });
      setSellerId("");
      setAmount("");
      await refresh(session);
    } catch (err) {
      setError(message(err));
    } finally {
      setPending(false);
    }
  }

  async function advance(orderId: string, action: Action) {
    if (!session) return;
    setPending(true);
    setError(null);
    try {
      await api.transitionOrder(
        session.accessToken,
        orderId,
        action,
        crypto.randomUUID(),
      );
      await refresh(session);
    } catch (err) {
      setError(message(err));
    } finally {
      setPending(false);
    }
  }

  if (!session) {
    return (
      <div className="rounded-xl bg-surface-card-dark p-lg text-body">
        Connect and sign in with your Stellar wallet on the home page before
        using escrow.
      </div>
    );
  }

  return (
    <div className="grid gap-lg lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
      <section className="space-y-lg">
        {orders.length === 0 ? (
          <div className="rounded-xl bg-surface-card-dark p-lg text-muted">
            No orders yet. Create the first escrow payment.
          </div>
        ) : null}
        {orders.map((details) => {
          const action = nextAction(details, session.user.id);
          return (
            <article
              key={details.order.id}
              className="rounded-xl bg-surface-card-dark p-lg"
            >
              <div className="flex flex-wrap items-start justify-between gap-md">
                <div>
                  <p className="font-mono text-xs text-muted">
                    {details.order.id}
                  </p>
                  <p className="mt-xs font-mono text-2xl text-on-dark">
                    {(Number(details.order.amount.amount) / 100).toFixed(2)}{" "}
                    {details.order.amount.currency}
                  </p>
                </div>
                <StatusPill status={details.order.status} />
              </div>
              <dl className="mt-md grid gap-xs text-sm text-body sm:grid-cols-2">
                <div><dt className="text-muted">Buyer</dt><dd className="font-mono text-xs">{details.order.buyerId}</dd></div>
                <div><dt className="text-muted">Seller</dt><dd className="font-mono text-xs">{details.order.sellerId}</dd></div>
                <div><dt className="text-muted">Contract</dt><dd className="font-mono text-xs">{details.escrow?.contractId ?? "Not locked"}</dd></div>
                <div><dt className="text-muted">Ledger/chain steps</dt><dd className="font-mono">{details.transitions.length}</dd></div>
              </dl>
              {details.blockedByReconciliation ? (
                <p role="alert" className="mt-md text-sm text-status-disputed">
                  Operations blocked: unresolved ledger-to-chain mismatch.
                </p>
              ) : null}
              {action ? (
                <button
                  type="button"
                  disabled={pending || details.blockedByReconciliation}
                  onClick={() => advance(details.order.id, action)}
                  className="mt-md rounded-md bg-primary px-lg py-sm text-sm font-semibold capitalize text-on-primary disabled:bg-primary-disabled disabled:text-muted"
                >
                  {action === "confirm" ? "Confirm delivery" : action}
                </button>
              ) : null}
            </article>
          );
        })}
      </section>

      <aside className="h-fit rounded-xl bg-canvas-light p-lg text-ink">
        <h2 className="text-xl font-semibold">Create escrow order</h2>
        <p className="mt-xs text-sm text-muted">
          Amounts are deposited and locked in USDC on testnet.
        </p>
        <form onSubmit={createOrder} className="mt-lg space-y-md">
          <label className="block text-sm font-medium">
            Seller user ID
            <input
              required
              value={sellerId}
              onChange={(event) => setSellerId(event.target.value)}
              className="mt-xs h-10 w-full rounded-md border border-hairline-light px-md font-mono text-sm"
            />
          </label>
          <label className="block text-sm font-medium">
            Amount (USDC)
            <input
              required
              min="0.01"
              step="0.01"
              type="number"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="mt-xs h-10 w-full rounded-md border border-hairline-light px-md font-mono"
            />
          </label>
          <button
            disabled={pending}
            className="h-10 w-full rounded-md bg-primary font-semibold text-on-primary disabled:bg-primary-disabled disabled:text-muted"
          >
            {pending ? "Processing…" : "Create order"}
          </button>
        </form>
        {error ? <p role="alert" className="mt-md text-sm text-status-refunded">{error}</p> : null}
      </aside>
    </div>
  );
}

function nextAction(details: OrderDetailsResponse, userId: string): Action | null {
  const { order } = details;
  if (order.status === OrderStatus.Created && order.sellerId === userId) return "accept";
  if (order.buyerId !== userId) return null;
  if (order.status === OrderStatus.Accepted) return "deposit";
  if (order.status === OrderStatus.Deposited) return "lock";
  if (order.status === OrderStatus.Locked) return "confirm";
  if (order.status === OrderStatus.Confirmed) return "release";
  return null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The escrow operation failed";
}
