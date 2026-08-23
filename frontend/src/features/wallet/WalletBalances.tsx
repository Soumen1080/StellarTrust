"use client";

import { useEffect, useState } from "react";
import type { WalletBalancesResponse } from "@stellartrust/shared";
import { api, ApiClientError, ApiUnreachableError } from "@/lib/api";

/**
 * Live testnet/mainnet balances for the connected wallet, read from Horizon.
 *
 * `refreshKey` lets a caller force a re-fetch (e.g. after an escrow action
 * settles) without needing the access token itself to change.
 */
export function WalletBalances({
  accessToken,
  refreshKey,
}: {
  accessToken: string;
  refreshKey?: number | string;
}) {
  const [data, setData] = useState<WalletBalancesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api
      .getWalletBalances(accessToken)
      .then((response) => {
        if (!cancelled) setData(response);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof ApiClientError || err instanceof ApiUnreachableError
            ? err.message
            : "Could not load wallet balances",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, refreshKey]);

  if (loading) return <p className="text-xs text-muted">Loading balances…</p>;
  if (error) return <p className="text-xs text-status-refunded">{error}</p>;
  if (!data || data.balances.length === 0) {
    return <p className="text-xs text-muted">No balances found on this account.</p>;
  }

  return (
    <div className="flex flex-wrap gap-sm">
      {data.balances.map((entry) => (
        <div
          key={entry.currency}
          className="rounded-md border border-hairline-dark bg-surface-card-dark px-sm py-xs"
        >
          <p className="data-label">
            {entry.currency}
          </p>
          <p className="font-mono text-sm font-semibold text-on-dark">
            {Number(entry.balance).toLocaleString(undefined, {
              maximumFractionDigits: 7,
            })}
          </p>
        </div>
      ))}
    </div>
  );
}
