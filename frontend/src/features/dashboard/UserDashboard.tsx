"use client";

import { OrderStatus, type OrderDetailsResponse } from "@stellartrust/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { useIdentity } from "@/components/IdentityProvider";
import { StatusPill } from "@/components/StatusPill";
import { ApiClientError, api } from "@/lib/api";
import { clearSession } from "@/lib/wallet-auth";

const ACTIVE_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.Created,
  OrderStatus.Accepted,
  OrderStatus.Deposited,
  OrderStatus.Locked,
  OrderStatus.Confirmed,
];
const PROTECTED_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.Deposited,
  OrderStatus.Locked,
  OrderStatus.Confirmed,
];

export function UserDashboard() {
  const router = useRouter();
  const { session, profile, loading: identityLoading, error: identityError, isVerified } = useIdentity();
  const [orders, setOrders] = useState<OrderDetailsResponse[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);

  useEffect(() => {
    if (identityLoading) return;
    if (!session || !profile || !isVerified) {
      router.replace("/kyc");
      return;
    }

    let active = true;
    setOrdersLoading(true);
    void api
      .listOrders(session.accessToken)
      .then(({ orders: loadedOrders }) => {
        if (active) setOrders(loadedOrders);
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof ApiClientError && err.status === 401) {
          clearSession();
          return;
        }
        setOrdersError(err instanceof Error ? err.message : "Could not load your orders");
      })
      .finally(() => {
        if (active) setOrdersLoading(false);
      });
    return () => {
      active = false;
    };
  }, [identityLoading, isVerified, profile, router, session]);

  const metrics = useMemo(() => {
    const activeOrders = orders.filter((details) =>
      ACTIVE_ORDER_STATUSES.includes(details.order.status),
    ).length;
    const protectedOrders = orders.filter((details) =>
      PROTECTED_ORDER_STATUSES.includes(details.order.status),
    ).length;
    const volumeByCurrency = new Map<string, number>();
    for (const details of orders) {
      const currency = details.order.amount.currency;
      volumeByCurrency.set(
        currency,
        (volumeByCurrency.get(currency) ?? 0) + Number(details.order.amount.amount),
      );
    }
    const volume =
      [...volumeByCurrency.entries()]
        .map(
          ([currency, minorUnits]) =>
            `${(minorUnits / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`,
        )
        .join(" · ") || "0.00 USDC";
    return { activeOrders, protectedOrders, volume };
  }, [orders]);

  if (identityLoading || !session || !profile || !isVerified) {
    return <DashboardLoading />;
  }

  const name = profile.user.displayName?.trim() || "StellarTrust user";
  const wallet = profile.wallets[0] ?? session.wallet;
  const recentOrders = orders.slice(0, 3);

  return (
    <div>
      <section className="grid gap-lg border-b border-hairline-dark pb-xl lg:grid-cols-[1fr_auto] lg:items-end">
        <div>
          <p className="eyebrow">Account dashboard</p>
          <h1 className="mt-sm text-3xl font-bold tracking-tight text-on-dark sm:text-4xl">
            Welcome back, {name}.
          </h1>
          <p className="mt-sm max-w-2xl leading-7 text-muted-strong">
            Your verified account, wallet, and protected settlement activity in one place.
          </p>
        </div>
        <div className="flex flex-wrap gap-sm">
          <Link href="/escrow" className="btn-primary">
            Open escrow <Icon name="arrow-right" className="h-4 w-4" />
          </Link>
        </div>
      </section>

      {identityError || ordersError ? (
        <div role="alert" className="mt-lg rounded-lg border border-status-rejected/30 bg-status-rejected/10 p-md text-sm text-status-rejected">
          {identityError ?? ordersError}
        </div>
      ) : null}

      <section className="mt-xl grid gap-md sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Verification" value="Verified" detail="Account access enabled" icon="user-check" />
        <Metric label="Active orders" value={String(metrics.activeOrders)} detail="In settlement lifecycle" icon="clock" />
        <Metric label="Protected orders" value={String(metrics.protectedOrders)} detail="Deposited or escrowed" icon="lock" />
        <Metric label="Historical volume" value={metrics.volume} detail={`${orders.length} total orders`} icon="wallet" />
      </section>

      <section className="mt-xl grid items-start gap-lg xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="panel-dark overflow-hidden">
          <div className="flex items-center justify-between gap-md border-b border-hairline-dark p-lg">
            <div>
              <p className="eyebrow">Recent activity</p>
              <h2 className="mt-xs text-xl font-semibold text-on-dark">Escrow orders</h2>
            </div>
            <Link href="/escrow" className="text-sm font-semibold text-primary">View all</Link>
          </div>
          {ordersLoading ? (
            <div className="space-y-md p-lg" aria-label="Loading recent orders">
              {Array.from({ length: 3 }).map((_, index) => <div key={index} className="h-20 animate-pulse rounded-lg bg-surface-elevated-dark" />)}
            </div>
          ) : recentOrders.length ? (
            <div className="divide-y divide-hairline-dark">
              {recentOrders.map(({ order }) => (
                <article key={order.id} className="flex flex-col justify-between gap-md p-lg sm:flex-row sm:items-center">
                  <div>
                    <div className="flex flex-wrap items-center gap-sm"><StatusPill status={order.status} /><span className="font-mono text-xs text-muted">{shortId(order.id)}</span></div>
                    <p className="mt-sm font-mono text-lg font-semibold text-on-dark">{(Number(order.amount.amount) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })} {order.amount.currency}</p>
                  </div>
                  <p className="text-xs text-muted">{order.buyerId === profile.user.id ? "Buyer" : order.sellerId === profile.user.id ? "Seller" : "Participant"}</p>
                </article>
              ))}
            </div>
          ) : (
            <div className="px-lg py-xxl text-center">
              <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-surface-elevated-dark text-muted"><Icon name="document" /></span>
              <h3 className="mt-md font-semibold text-on-dark">No escrow activity yet</h3>
              <p className="mx-auto mt-xs max-w-md text-sm text-muted">Create your first protected order to see settlement activity here.</p>
              <Link href="/escrow" className="btn-primary mt-lg">Create an order <Icon name="arrow-right" className="h-4 w-4" /></Link>
            </div>
          )}
        </div>

        <aside className="space-y-lg xl:sticky xl:top-24">
          <section className="panel-light p-lg text-ink">
            <div className="flex items-center justify-between gap-sm"><h2 className="font-semibold">Account status</h2><StatusPill status={profile.user.kycStatus} /></div>
            <dl className="mt-lg space-y-md border-t border-hairline-light pt-md">
              <Detail label="Account name" value={name} />
              <Detail label="Network" value="Stellar testnet" />
              <Detail label="Custody" value={wallet.custodyType === "self" ? "Self-custody" : "Contract"} />
            </dl>
          </section>
          <section className="panel-dark p-lg">
            <div className="flex items-center gap-sm"><span className="grid h-10 w-10 place-items-center rounded-lg bg-surface-elevated-dark text-primary"><Icon name="wallet" /></span><div><h2 className="font-semibold text-on-dark">Connected wallet</h2><p className="text-xs text-muted">SEP-10 authenticated</p></div></div>
            <p className="mt-md break-all font-mono text-xs leading-5 text-muted-strong">{wallet.stellarPublicKey}</p>
          </section>
        </aside>
      </section>
    </div>
  );
}

function Metric({ label, value, detail, icon }: { label: string; value: string; detail: string; icon: "user-check" | "clock" | "lock" | "wallet" }) {
  return <div className="panel-dark flex items-center justify-between gap-md p-lg"><div><p className="text-xs font-medium text-muted">{label}</p><p className="mt-xs font-mono text-xl font-semibold text-on-dark">{value}</p><p className="mt-xs text-xs text-muted">{detail}</p></div><span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-surface-elevated-dark text-primary"><Icon name={icon} /></span></div>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[10px] uppercase tracking-wider text-muted">{label}</dt><dd className="mt-xs text-sm font-medium">{value}</dd></div>;
}

function DashboardLoading() {
  return <div aria-label="Loading account dashboard"><div className="h-10 w-72 max-w-full animate-pulse rounded bg-surface-card-dark"/><div className="mt-xl grid gap-md sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }).map((_, index) => <div key={index} className="panel-dark h-32 animate-pulse" />)}</div><div className="mt-xl grid gap-lg xl:grid-cols-[1fr_360px]"><div className="panel-dark h-96 animate-pulse"/><div className="panel-dark h-64 animate-pulse"/></div></div>;
}

function shortId(value: string): string {
  return value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}
