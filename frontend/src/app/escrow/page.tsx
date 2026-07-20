import { EscrowDashboard } from "@/features/escrow/EscrowDashboard";

export default function EscrowPage() {
  return (
    <main className="mx-auto max-w-[1440px] px-lg py-section">
      <header className="mb-xl">
        <a href="/" className="font-bold text-primary text-2xl">StellarTrust</a>
        <h1 className="mt-lg text-4xl font-bold text-on-dark">Smart escrow</h1>
        <p className="mt-sm max-w-2xl text-body">
          Create, accept, deposit, lock, confirm, and release with a balanced
          ledger entry and linked Stellar transaction at every step.
        </p>
      </header>
      <EscrowDashboard />
    </main>
  );
}
