import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Icon } from "@/components/Icon";
import { DevKycApproval } from "@/features/kyc/DevKycApproval";

export const metadata: Metadata = { title: "Development approval" };

export default function DevKycApprovalPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <main id="main-content" className="min-h-[calc(100vh-4rem)]"><div className="mx-auto max-w-[1080px] px-md py-xl sm:px-lg sm:py-xxl"><header className="mb-xl border-b border-hairline-dark pb-xl"><div className="mb-md inline-flex items-center gap-xs rounded-pill border border-status-review/40 bg-status-review/10 px-sm py-xs text-xs font-semibold text-status-review"><Icon name="lock" className="h-3.5 w-3.5"/>Development only</div><h1 className="text-3xl font-bold tracking-tight text-on-dark">Temporary KYC approval</h1><p className="mt-sm max-w-2xl leading-7 text-muted-strong">Password-gated sandbox tooling for local review workflows. This route is automatically unavailable outside development.</p></header><DevKycApproval /></div></main>;
}
