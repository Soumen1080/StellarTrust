"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { useIdentity } from "@/components/IdentityProvider";
import { connectWalletAndSignIn, disconnectWallet } from "@/lib/wallet-auth";

export function WalletConnect() {
  const { session, isVerified, loading } = useIdentity();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setPending(true);
    setError(null);
    try { await connectWalletAndSignIn(); }
    catch (err) { setError(err instanceof Error ? err.message : "Wallet connection was cancelled"); }
    finally { setPending(false); }
  }

  async function disconnect() {
    setPending(true);
    setError(null);
    try { await disconnectWallet(); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not disconnect wallet"); }
    finally { setPending(false); }
  }

  if (session) {
    const key = session.wallet.stellarPublicKey;
    return <div className="flex max-w-2xl flex-col gap-sm sm:flex-row sm:items-center"><div className="flex min-h-11 items-center gap-sm rounded-md border border-hairline-dark bg-surface-card-dark px-md"><span className="grid h-7 w-7 place-items-center rounded-full bg-status-verified/10 text-status-verified"><Icon name="wallet" className="h-4 w-4" /></span><div><p className="text-[10px] uppercase tracking-wider text-muted">Wallet connected</p><p className="font-mono text-xs text-body" title={key}>{key.slice(0, 7)}…{key.slice(-6)}</p></div></div><Link href={isVerified ? "/dashboard" : "/kyc"} className="btn-primary">{loading ? "Checking account…" : isVerified ? "Open dashboard" : "Continue verification"} <Icon name="arrow-right" className="h-4 w-4" /></Link><button type="button" onClick={() => void disconnect()} disabled={pending} className="min-h-10 px-sm text-sm font-medium text-muted-strong transition hover:text-on-dark disabled:opacity-50">{pending ? "Disconnecting…" : "Disconnect"}</button></div>;
  }

  return <div><div className="flex flex-wrap gap-sm"><button type="button" disabled={pending} onClick={() => void connect()} className="btn-primary min-w-[210px]"><Icon name="wallet" className="h-4 w-4" />{pending ? "Approve in wallet…" : "Connect wallet"}</button><Link href="/escrow" className="btn-secondary-dark">Explore escrow</Link></div>{error ? <p role="alert" className="mt-sm flex max-w-lg items-start gap-xs text-sm text-status-refunded"><span aria-hidden="true">●</span>{error}</p> : null}</div>;
}
