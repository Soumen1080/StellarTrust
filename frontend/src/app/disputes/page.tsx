import type { Metadata } from "next";
import { DisputeConsole } from "@/features/disputes/DisputeConsole";

export const metadata: Metadata = {
  title: "Disputes",
  description:
    "Open and resolve escrow disputes with an explainable, human-gated AI recommendation and a full decision audit trail.",
};

export default function DisputesPage() {
  return (
    <main id="main-content" className="min-h-[calc(100vh-4rem)]">
      <div className="mx-auto max-w-[1440px] px-md py-xl sm:px-lg sm:py-xxl">
        <header className="mb-xl flex flex-col justify-between gap-lg border-b border-hairline-dark pb-xl lg:flex-row lg:items-end">
          <div>
            <p className="eyebrow">Trust &amp; safety</p>
            <h1 className="mt-sm text-3xl font-bold tracking-tight text-on-dark sm:text-4xl">Disputes</h1>
            <p className="mt-sm max-w-2xl leading-7 text-muted-strong">
              Raise a dispute on an order, submit evidence within the review window, and receive an explainable AI recommendation. The AI is advisory only — high-value or low-confidence disputes require a human compliance decision, and every decision is audit-logged.
            </p>
          </div>
          <div className="flex items-center gap-sm rounded-lg border border-hairline-dark bg-surface-card-dark px-md py-sm text-xs text-muted-strong">
            <span className="h-2 w-2 rounded-full bg-status-verified" />
            <span>AI advisory · Human-gated</span>
          </div>
        </header>
        <DisputeConsole />
      </div>
    </main>
  );
}
