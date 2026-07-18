"use client";

import type { AuthSessionResponse } from "@stellartrust/shared";
import { useEffect, useState } from "react";
import {
  connectWalletAndSignIn,
  disconnectWallet,
  loadSession,
} from "@/lib/wallet-auth";

export function WalletConnect() {
  const [session, setSession] = useState<AuthSessionResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setSession(loadSession()), []);

  async function connect() {
    setPending(true);
    setError(null);
    try {
      setSession(await connectWalletAndSignIn());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Wallet connection was cancelled",
      );
    } finally {
      setPending(false);
    }
  }

  async function disconnect() {
    await disconnectWallet();
    setSession(null);
  }

  if (session) {
    return (
      <div className="flex flex-wrap items-center gap-sm">
        <span className="rounded-pill border border-hairline-dark px-sm py-xs font-mono text-xs text-status-verified">
          Connected · {session.wallet.stellarPublicKey.slice(0, 8)}…
          {session.wallet.stellarPublicKey.slice(-6)}
        </span>
        <a
          href="/kyc"
          className="rounded-md bg-primary px-lg py-sm text-sm font-semibold text-on-primary"
        >
          Continue verification
        </a>
        <button
          type="button"
          onClick={disconnect}
          className="rounded-md bg-surface-card-dark px-md py-sm text-sm text-body"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={connect}
        className="rounded-md bg-primary px-lg py-sm text-sm font-semibold text-on-primary disabled:bg-primary-disabled disabled:text-muted"
      >
        {pending ? "Waiting for wallet…" : "Connect wallet & sign in"}
      </button>
      {error ? (
        <p role="alert" className="mt-xs max-w-md text-sm text-status-refunded">
          {error}
        </p>
      ) : null}
    </div>
  );
}
