import type { Metadata } from "next";
import { Icon } from "@/components/Icon";
import { KycReviewQueue } from "@/features/kyc/KycReviewQueue";

export const metadata: Metadata = { title: "KYC compliance queue" };

export default function KycReviewPage() {
  return <main id="main-content" className="min-h-[calc(100vh-4rem)]"><div className="mx-auto max-w-[1280px] px-md py-xl sm:px-lg sm:py-xxl"><header className="mb-xl flex flex-col justify-between gap-lg border-b border-hairline-dark pb-xl lg:flex-row lg:items-end"><div><p className="eyebrow">Operations · Compliance</p><h1 className="mt-sm text-3xl font-bold tracking-tight text-on-dark sm:text-4xl">KYC review queue</h1><p className="mt-sm max-w-2xl leading-7 text-muted-strong">Review provider evidence and AI risk signals, then record an accountable human decision and policy basis.</p></div><span className="inline-flex w-fit items-center gap-xs rounded-pill border border-hairline-dark px-md py-sm text-xs font-medium text-muted-strong"><Icon name="shield" className="h-4 w-4 text-status-review"/>Compliance role required</span></header><KycReviewQueue /></div></main>;
}
