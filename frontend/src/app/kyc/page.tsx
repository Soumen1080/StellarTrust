import { KycOnboarding } from "@/features/kyc/KycOnboarding";

export default function KycPage() {
  return (
    <main className="min-h-screen bg-surface-soft-light text-ink">
      <div className="mx-auto max-w-[1280px] px-lg py-xl">
        <header className="mb-xl flex flex-wrap items-center justify-between gap-md border-b border-hairline-light pb-lg">
          <a href="/" className="text-xl font-bold text-ink">
            Stellar<span className="text-primary-active">Trust</span>
          </a>
          <p className="text-xs uppercase tracking-wide text-muted">
            Identity & wallet
          </p>
        </header>
        <KycOnboarding />
      </div>
    </main>
  );
}
