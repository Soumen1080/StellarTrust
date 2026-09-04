import type { Metadata } from "next";
import { Icon } from "@/components/Icon";
import { TreasuryPanel } from "@/features/treasury/TreasuryPanel";

export const metadata: Metadata = { title: "Balance" };

export default function WalletPage() {
  return (
    <main id="main-content" className="min-h-[calc(100dvh-4rem)]">
      <div className="mx-auto max-w-[1280px] px-md py-xl sm:px-lg sm:py-xxl">
        <header className="mb-lg flex flex-col justify-between gap-md border-b border-hairline-dark pb-lg sm:mb-xl sm:gap-lg sm:pb-xl lg:flex-row lg:items-end">
          <div>
            <p className="eyebrow">Account</p>
            <h1 className="mt-sm text-3xl font-bold tracking-tight text-on-dark sm:text-4xl">
              Balance
            </h1>
            <p className="mt-sm max-w-2xl leading-7 text-muted-strong">
              Investing draws on a platform balance, funded by a real payment
              from your own wallet. Every deposit is verified against the chain
              before it is credited — the transaction is the evidence, not the
              amount you type.
            </p>
          </div>
          <span className="inline-flex w-fit items-center gap-xs rounded-pill border border-hairline-dark px-md py-sm text-xs font-medium text-muted-strong">
            <Icon name="shield" className="h-4 w-4 text-status-verified" />
            Testnet funds only
          </span>
        </header>

        <TreasuryPanel />
      </div>
    </main>
  );
}
