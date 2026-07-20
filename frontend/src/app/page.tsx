import Link from "next/link";
import { Icon, type IconName } from "@/components/Icon";
import { WalletConnect } from "@/features/wallet/WalletConnect";

const capabilities: { icon: IconName; title: string; copy: string; meta: string }[] = [
  { icon: "lock", title: "Programmable escrow", copy: "Funds move through an explicit order lifecycle and remain protected until delivery is confirmed.", meta: "Soroban-secured" },
  { icon: "network", title: "Auditable settlement", copy: "Every transition links the order, balanced ledger entries, actor, and Stellar transaction.", meta: "Ledger ↔ chain" },
  { icon: "user-check", title: "Human-gated compliance", copy: "Provider checks and AI risk signals inform a review; accountable people make final decisions.", meta: "AI is advisory" },
];

const steps = [
  ["01", "Connect securely", "Authenticate by signing a SEP-10 challenge. Your secret key never leaves your wallet."],
  ["02", "Verify your identity", "Complete sandbox KYC or KYB checks and receive a transparent verification status."],
  ["03", "Settle with confidence", "Create an escrow, follow each ledger-backed transition, and release after confirmation."],
];

export default function Home() {
  return (
    <main id="main-content">
      <section className="relative overflow-hidden border-b border-hairline-dark">
        <div aria-hidden="true" className="absolute inset-y-0 right-0 hidden w-[42%] border-l border-hairline-dark lg:block">
          <div className="absolute inset-0 opacity-30" style={{ backgroundImage: "linear-gradient(#2b3139 1px, transparent 1px), linear-gradient(90deg, #2b3139 1px, transparent 1px)", backgroundSize: "48px 48px" }} />
          <div className="absolute left-[18%] top-[18%] h-3 w-3 rounded-full bg-primary" />
          <div className="absolute bottom-[24%] right-[20%] h-3 w-3 rounded-full bg-status-verified" />
          <div className="absolute left-[20%] top-[20%] h-px w-[63%] origin-left rotate-[28deg] bg-gradient-to-r from-primary to-status-verified" />
        </div>
        <div className="relative mx-auto grid min-h-[680px] max-w-[1280px] items-center gap-xxl px-md py-section sm:px-lg lg:grid-cols-[1.15fr_.85fr]">
          <div>
            <div className="mb-lg inline-flex items-center gap-xs rounded-pill border border-hairline-dark bg-surface-card-dark px-sm py-xs text-xs font-medium text-muted-strong"><span className="h-1.5 w-1.5 rounded-full bg-status-verified" />Stellar testnet · Infrastructure preview</div>
            <h1 className="max-w-4xl text-4xl font-bold leading-[1.08] tracking-[-0.04em] text-on-dark sm:text-6xl lg:text-[68px]">Global commerce,<br/><span className="text-primary">without the trust gap.</span></h1>
            <p className="mt-lg max-w-2xl text-base leading-7 text-muted-strong sm:text-lg">Secure cross-border trade with programmable escrow, verified counterparties, and settlement records that reconcile from ledger to chain.</p>
            <div className="mt-xl"><WalletConnect /></div>
            <div className="mt-xl flex flex-wrap items-center gap-lg text-xs text-muted"><span className="flex items-center gap-xs"><Icon name="shield" className="h-4 w-4 text-status-verified" />Non-custodial sign-in</span><span className="flex items-center gap-xs"><Icon name="clock" className="h-4 w-4 text-status-verified" />Near real-time settlement</span><span className="flex items-center gap-xs"><Icon name="document" className="h-4 w-4 text-status-verified" />Complete audit trail</span></div>
          </div>
          <div className="hidden lg:block">
            <div className="ml-auto max-w-sm panel-dark p-lg">
              <div className="flex items-center justify-between border-b border-hairline-dark pb-md"><div><p className="eyebrow">Protected transfer</p><p className="mt-xs font-mono text-xs text-muted">ORDER · ST-8F20A4</p></div><span className="rounded-pill bg-status-locked/10 px-sm py-xs text-xs font-semibold text-status-locked">● Funds locked</span></div>
              <div className="py-xl"><p className="text-sm text-muted">Escrow balance</p><p className="mt-xs font-mono text-4xl font-semibold text-on-dark">$24,500.00</p><p className="mt-xs font-mono text-xs text-muted">USDC · Stellar testnet</p></div>
              <div className="space-y-md border-t border-hairline-dark pt-lg">{["Order accepted", "Deposit reconciled", "Escrow locked", "Delivery confirmation"].map((label, index) => <div key={label} className="flex items-center gap-sm"><span className={`grid h-6 w-6 place-items-center rounded-full text-xs ${index < 3 ? "bg-status-verified/10 text-status-verified" : "border border-hairline-dark text-muted"}`}>{index < 3 ? <Icon name="check" className="h-3.5 w-3.5" /> : "4"}</span><span className={index < 3 ? "text-sm text-body" : "text-sm text-muted"}>{label}</span>{index === 2 ? <span className="ml-auto font-mono text-[10px] text-status-locked">CURRENT</span> : null}</div>)}</div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1280px] px-md py-section sm:px-lg">
        <div className="grid border-y border-hairline-dark sm:grid-cols-3">{[["6", "State-linked settlement steps"], ["100%", "Balanced ledger transitions"], ["0", "Secret keys stored by StellarTrust"]].map(([value, label], index) => <div key={label} className={`py-lg sm:px-lg ${index ? "sm:border-l sm:border-hairline-dark" : ""}`}><p className="font-mono text-3xl font-semibold text-primary">{value}</p><p className="mt-xs text-sm text-muted">{label}</p></div>)}</div>
      </section>

      <section className="mx-auto max-w-[1280px] px-md pb-section sm:px-lg">
        <div className="max-w-2xl"><p className="eyebrow">One infrastructure layer</p><h2 className="mt-sm text-3xl font-bold tracking-tight text-on-dark sm:text-4xl">Trust controls built into every transaction.</h2><p className="mt-md leading-7 text-muted-strong">Designed for trade where identity, custody, money movement, and accountability must work together.</p></div>
        <div className="mt-xl grid gap-lg md:grid-cols-3">{capabilities.map((item) => <article key={item.title} className="panel-dark p-lg transition hover:-translate-y-1 hover:border-muted"><div className="grid h-11 w-11 place-items-center rounded-lg bg-surface-elevated-dark text-primary"><Icon name={item.icon} /></div><p className="mt-lg font-mono text-[11px] uppercase tracking-wider text-muted">{item.meta}</p><h3 className="mt-xs text-xl font-semibold text-on-dark">{item.title}</h3><p className="mt-sm text-sm leading-6 text-muted-strong">{item.copy}</p></article>)}</div>
      </section>

      <section className="bg-white text-ink">
        <div className="mx-auto max-w-[1280px] px-md py-section sm:px-lg"><div className="grid gap-xxl lg:grid-cols-[.75fr_1.25fr]"><div><p className="eyebrow">Simple by design</p><h2 className="mt-sm text-3xl font-bold tracking-tight sm:text-4xl">From wallet to settlement in three clear stages.</h2><p className="mt-md leading-7 text-muted">Each action is explicit, attributable, and protected by idempotent APIs.</p><Link href="/escrow" className="btn-primary mt-lg">Explore escrow <Icon name="arrow-right" className="h-4 w-4" /></Link></div><ol className="divide-y divide-hairline-light border-y border-hairline-light">{steps.map(([number, title, copy]) => <li key={number} className="grid gap-sm py-lg sm:grid-cols-[72px_1fr]"><span className="font-mono text-sm font-semibold text-primary-active">{number}</span><div><h3 className="font-semibold">{title}</h3><p className="mt-xs text-sm leading-6 text-muted">{copy}</p></div></li>)}</ol></div></div>
      </section>

      <section className="mx-auto max-w-[1280px] px-md py-section sm:px-lg"><div className="panel-dark grid items-center gap-xl p-xl sm:p-xxl lg:grid-cols-[1fr_auto]"><div><p className="eyebrow">Ready to begin?</p><h2 className="mt-sm text-3xl font-bold text-on-dark">Move value with verifiable trust.</h2><p className="mt-sm max-w-2xl text-muted-strong">Connect a Stellar wallet, complete identity checks, and create your first protected order.</p></div><Link href="/kyc" className="btn-primary">Get verified <Icon name="arrow-right" className="h-4 w-4" /></Link></div></section>
    </main>
  );
}
