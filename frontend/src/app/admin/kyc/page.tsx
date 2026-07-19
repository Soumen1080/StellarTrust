import Link from "next/link";
import { KycReviewQueue } from "@/features/kyc/KycReviewQueue";

export default function KycReviewPage() {
  return (
    <main className="mx-auto min-h-screen max-w-[1280px] px-lg py-xl">
      <header className="mb-xl flex flex-wrap items-end justify-between gap-md border-b border-hairline-dark pb-lg">
        <div>
          <Link href="/" className="text-lg font-bold text-primary">
            StellarTrust
          </Link>
          <h1 className="mt-sm text-3xl font-semibold text-on-dark">
            KYC compliance queue
          </h1>
          <p className="mt-xs max-w-2xl text-sm text-muted">
            Provider results and AI risk output are advisory. Every queued case
            requires an authenticated human decision with an audit reason.
          </p>
        </div>
        <span className="rounded-pill border border-hairline-dark px-sm py-xs text-xs uppercase tracking-wide text-muted">
          Compliance role required
        </span>
      </header>
      <KycReviewQueue />
    </main>
  );
}
