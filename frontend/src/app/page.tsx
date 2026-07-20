import Link from "next/link";
import { EscrowState, KycStatus } from "@stellartrust/shared";
import { StatusPill } from "@/components/StatusPill";
import { WalletConnect } from "@/features/wallet/WalletConnect";

export default function Home() {
  return (
    <main className="mx-auto max-w-[1280px] px-lg py-section">
      <header className="mb-xl">
        <span className="font-bold text-primary text-2xl">StellarTrust</span>
      </header>

      <h1 className="max-w-3xl text-5xl font-bold leading-tight tracking-tight text-on-dark">
        Fast, secure, transparent{" "}
        <span className="text-primary">global commerce</span> on Stellar.
      </h1>
      <p className="mt-md max-w-2xl text-body">
        Cross-border payments, smart-contract escrow, AI-assisted dispute
        resolution, and real-world asset tokenization — settled in near real
        time, protected by a double-entry ledger.
      </p>

      <div className="mt-lg flex flex-wrap gap-sm">
        <WalletConnect />
        <Link
          href="/escrow"
          className="rounded-md bg-surface-card-dark px-lg py-sm text-sm font-semibold text-body"
        >
          Open escrow dashboard
        </Link>
      </div>

      <section className="mt-section grid gap-lg sm:grid-cols-3">
        {[
          { label: "Escrow state", status: EscrowState.Locked },
          { label: "On release", status: EscrowState.Released },
          { label: "KYC", status: KycStatus.UnderReview },
        ].map((item) => (
          <div
            key={item.label}
            className="rounded-xl bg-surface-card-dark p-lg"
          >
            <p className="mb-sm text-xs uppercase tracking-wide text-muted">
              {item.label}
            </p>
            <StatusPill status={item.status} />
            <p className="mt-md font-mono text-2xl text-on-dark">$429.00</p>
          </div>
        ))}
      </section>
    </main>
  );
}
