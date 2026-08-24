import type { Metadata } from "next";
import { SettlementConsole } from "@/features/settlement/SettlementConsole";

export const metadata: Metadata = {
  title: "Cross-border settlement",
  description:
    "Quote and settle cross-currency transfers over path payments, AMM liquidity, and regulated anchors, paying out to local rails — UPI, IMPS, SEPA, ACH, NIP — reconciled to the ledger.",
};

export default function SettlementPage() {
  return (
    <main id="main-content" className="min-h-[calc(100dvh-4rem)]">
      <div className="mx-auto max-w-[1440px] px-md py-xl sm:px-lg sm:py-xxl">
        <header className="mb-lg flex flex-col justify-between gap-md border-b border-hairline-dark pb-lg sm:mb-xl sm:gap-lg sm:pb-xl lg:flex-row lg:items-end">
          <div>
            <p className="eyebrow">Settlement workspace</p>
            <h1 className="mt-sm text-3xl font-bold tracking-tight text-on-dark sm:text-4xl">Cross-border settlement</h1>
            <p className="mt-sm max-w-2xl leading-7 text-muted-strong">
              Route each transfer over the best available path-payment or AMM liquidity, then land it on the beneficiary&apos;s
              own rail — a UPI ID in India, an IFSC or IBAN account, a US ABA account, a Nigerian NUBAN — through a regulated
              anchor, with every deposit, conversion, and payout reconciled against the ledger.
            </p>
          </div>
          <div className="flex w-fit items-center gap-sm rounded-lg border border-hairline-dark bg-surface-card-dark px-md py-sm text-xs text-muted-strong">
            <span className="h-2 w-2 rounded-full bg-status-verified" />
            <span>Sandbox anchor · Testnet liquidity</span>
          </div>
        </header>
        <SettlementConsole />
      </div>
    </main>
  );
}
