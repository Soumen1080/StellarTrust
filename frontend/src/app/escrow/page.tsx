import type { Metadata } from "next";
import { EscrowDashboard } from "@/features/escrow/EscrowDashboard";

export const metadata: Metadata = { title: "Smart escrow", description: "Create and manage ledger-backed Stellar escrow orders." };

export default function EscrowPage() {
  return <main id="main-content" className="min-h-[calc(100vh-4rem)]"><div className="mx-auto max-w-[1440px] px-md py-xl sm:px-lg sm:py-xxl"><header className="mb-xl flex flex-col justify-between gap-lg border-b border-hairline-dark pb-xl lg:flex-row lg:items-end"><div><p className="eyebrow">Settlement workspace</p><h1 className="mt-sm text-3xl font-bold tracking-tight text-on-dark sm:text-4xl">Smart escrow</h1><p className="mt-sm max-w-2xl leading-7 text-muted-strong">Create, fund, lock, confirm, and release orders with a linked ledger and Stellar record at every step.</p></div><div className="flex items-center gap-sm rounded-lg border border-hairline-dark bg-surface-card-dark px-md py-sm text-xs text-muted-strong"><span className="h-2 w-2 rounded-full bg-status-verified"/><span>Testnet operations available</span></div></header><EscrowDashboard /></div></main>;
}
