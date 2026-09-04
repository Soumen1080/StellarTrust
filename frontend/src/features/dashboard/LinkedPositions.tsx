"use client";

/**
 * One trade, across four domains (plane.md §2.4).
 *
 * The escrow, settlement, dispute, and RWA consoles each show their own records
 * correctly and in isolation, which left a user who funded an escrow through a
 * corridor and then disputed the delivery reading three screens and inferring
 * for themselves that all three were about the same trade.
 *
 * This renders `GET /api/positions` — specifically its `links` block, which is
 * the part the client could not assemble itself. Orders with no cross-domain
 * relationships are deliberately not shown: they are already covered by the
 * orders table above, and repeating them here would bury the linked ones this
 * exists to surface.
 */

import type { PositionsResponse } from "@stellartrust/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { ApiClientError, api } from "@/lib/api";
import { clearSession } from "@/lib/wallet-auth";

export function LinkedPositions({ accessToken }: { accessToken: string }) {
  const [positions, setPositions] = useState<PositionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void api
      .getPositions(accessToken)
      .then((result) => {
        if (active) setPositions(result);
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof ApiClientError && err.status === 401) {
          clearSession();
          return;
        }
        setError(
          err instanceof Error ? err.message : "Could not load your positions",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [accessToken]);

  if (loading) {
    return (
      <section className="panel-dark p-lg" aria-label="Loading linked positions">
        <div className="h-6 w-48 animate-pulse rounded bg-surface-elevated-dark" />
        <div className="mt-md h-24 animate-pulse rounded bg-surface-elevated-dark" />
      </section>
    );
  }

  if (error) {
    return (
      <section className="panel-dark p-lg">
        <h2 className="text-lg font-semibold text-on-dark">Connected activity</h2>
        <p className="mt-sm text-sm text-status-rejected">{error}</p>
      </section>
    );
  }

  // Only orders that actually reach into another domain.
  const linked = (positions?.links ?? []).filter(
    (link) =>
      link.fundedBySettlementId !== null ||
      link.disputeIds.length > 0 ||
      link.tokenizationIds.length > 0,
  );

  return (
    <section className="panel-dark p-lg">
      <header className="flex items-center justify-between gap-md">
        <div>
          <h2 className="text-lg font-semibold text-on-dark">
            Connected activity
          </h2>
          <p className="mt-xs text-xs text-muted">
            Where one trade spans escrow, settlement, disputes, and tokenization.
          </p>
        </div>
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-surface-elevated-dark text-primary">
          <Icon name="lock" />
        </span>
      </header>

      {linked.length === 0 ? (
        <p className="mt-lg text-sm text-muted">
          None of your orders are linked to a settlement, dispute, or
          tokenization yet.
        </p>
      ) : (
        <ul className="mt-lg space-y-md">
          {linked.map((link) => (
            <li
              key={link.orderId}
              className="rounded-lg border border-hairline-dark bg-surface-elevated-dark p-md"
            >
              <div className="flex flex-wrap items-center gap-sm">
                <Link
                  href="/escrow"
                  className="font-mono text-sm font-semibold text-on-dark underline-offset-4 hover:underline"
                >
                  {shortId(link.orderId)}
                </Link>
                <span className="text-xs text-muted">order</span>
              </div>

              <dl className="mt-md grid gap-sm sm:grid-cols-3">
                <LinkFact
                  label="Funded by settlement"
                  href="/settlement"
                  values={
                    link.fundedBySettlementId ? [link.fundedBySettlementId] : []
                  }
                  empty="Funded directly"
                />
                <LinkFact
                  label="Disputes"
                  href="/disputes"
                  values={link.disputeIds}
                  empty="None"
                />
                <LinkFact
                  label="Tokenizations"
                  href="/rwa"
                  values={link.tokenizationIds}
                  empty="None"
                />
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LinkFact({
  label,
  href,
  values,
  empty,
}: {
  label: string;
  href: string;
  values: string[];
  empty: string;
}) {
  return (
    <div>
      <dt className="data-label">{label}</dt>
      <dd className="mt-xs text-sm font-medium">
        {values.length === 0 ? (
          <span className="text-muted">{empty}</span>
        ) : (
          <ul className="space-y-xs">
            {values.map((value) => (
              <li key={value}>
                <Link
                  href={href}
                  className="font-mono text-xs text-primary underline-offset-4 hover:underline"
                >
                  {shortId(value)}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </dd>
    </div>
  );
}

function shortId(value: string): string {
  return value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}
