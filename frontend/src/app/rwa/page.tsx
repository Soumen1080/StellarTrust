import type { Metadata } from "next";
import { RwaConsole } from "@/features/rwa/RwaConsole";

export const metadata: Metadata = {
  title: "RWA tokenization",
  description:
    "Tokenize invoices, commodities, and real estate into fractional units. Investors buy transparent ownership and receive pro-rata payouts when the buyer pays through escrow.",
};

export default function RwaPage() {
  return (
    <main id="main-content" className="min-h-[calc(100vh-4rem)]">
      <div className="mx-auto max-w-[1440px] px-md py-xl sm:px-lg sm:py-xxl">
        <header className="mb-xl flex flex-col justify-between gap-lg border-b border-hairline-dark pb-xl lg:flex-row lg:items-end">
          <div>
            <p className="eyebrow">Real-world assets</p>
            <h1 className="mt-sm text-3xl font-bold tracking-tight text-on-dark sm:text-4xl">RWA tokenization</h1>
            <p className="mt-sm max-w-2xl leading-7 text-muted-strong">
              Unlock working capital by tokenizing invoices, commodities, and real estate into fractional units. Investors buy transparent ownership; holders receive pro-rata payouts when the linked buyer payment settles through escrow — all reconciled in the ledger.
            </p>
          </div>
          <div className="flex items-center gap-sm rounded-lg border border-hairline-dark bg-surface-card-dark px-md py-sm text-xs text-muted-strong">
            <span className="h-2 w-2 rounded-full bg-status-verified" />
            <span>Opt-in module · Soroban rwa_token</span>
          </div>
        </header>
        <RwaConsole />
      </div>
    </main>
  );
}
