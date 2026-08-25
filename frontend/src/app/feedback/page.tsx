import type { Metadata } from "next";
import { FeedbackSection } from "@/features/feedback/FeedbackSection";

export const metadata: Metadata = {
  title: "Feedback",
  description:
    "What people are saying about StellarTrust — and where to add your own verdict.",
};

export default function FeedbackPage() {
  return (
    <main id="main-content" className="min-h-[calc(100dvh-4rem)]">
      <div className="mx-auto max-w-[1440px] px-md py-xl sm:px-lg sm:py-xxl">
        <header className="mb-lg flex flex-col justify-between gap-md border-b border-hairline-dark pb-lg sm:mb-xl sm:gap-lg sm:pb-xl lg:flex-row lg:items-end">
          <div>
            <p className="eyebrow">What people are saying</p>
            <h1 className="mt-sm text-3xl font-bold tracking-tight text-on-dark sm:text-4xl">
              Every order tells a story.
            </h1>
            <p className="mt-sm max-w-2xl leading-7 text-muted-strong">
              Unfiltered verdicts from people who moved real value through
              StellarTrust. Your name, rating and message go on the wall — your
              email and wallet address never do.
            </p>
          </div>
          <div className="flex w-fit items-center gap-sm rounded-lg border border-hairline-dark bg-surface-card-dark px-md py-sm text-xs text-muted-strong">
            <span className="h-2 w-2 rounded-full bg-status-verified" />
            <span>Public — no sign-in needed to read</span>
          </div>
        </header>

        <FeedbackSection />
      </div>
    </main>
  );
}
