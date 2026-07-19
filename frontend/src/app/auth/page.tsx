import Link from "next/link";
import { notFound } from "next/navigation";
import { DevKycApproval } from "@/features/kyc/DevKycApproval";

export default function DevKycApprovalPage() {
  if (process.env.NODE_ENV !== "development") notFound();

  return (
    <main className="mx-auto min-h-screen max-w-[960px] px-lg py-xl">
      <header className="mb-xl border-b border-hairline-dark pb-lg">
        <Link href="/" className="text-lg font-bold text-primary">
          StellarTrust
        </Link>
        <h1 className="mt-sm text-3xl font-semibold text-on-dark">
          Temporary KYC approval
        </h1>
        <p className="mt-xs max-w-2xl text-sm text-muted">
          Development only. This password-gated route is unavailable in staging
          and production and must be removed after the development phase.
        </p>
      </header>
      <DevKycApproval />
    </main>
  );
}
