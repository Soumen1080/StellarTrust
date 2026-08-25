"use client";

import type { FeedbackSummaryDTO } from "@stellartrust/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { api } from "@/lib/api";
import { Stars } from "./Stars";

/**
 * Dashboard band pointing at the feedback wall.
 *
 * Same shape as the landing page's closing CTA, with one difference: it reads
 * the live summary. A band that says "3 people rated this 4.67" earns its space
 * at the bottom of a dashboard in a way that a static "leave feedback" prompt
 * does not — and it degrades to plain copy if the request fails, since a
 * broken score is not a reason to hide the link.
 */
export function FeedbackCta() {
  const [summary, setSummary] = useState<FeedbackSummaryDTO | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .listFeedback()
      .then(({ summary: loaded }) => {
        if (active) setSummary(loaded);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const hasScore = Boolean(summary?.total);

  return (
    <section className="mt-xl">
      <div className="panel-dark grid items-center gap-xl p-lg sm:p-xl md:p-xxl lg:grid-cols-[1fr_auto]">
        <div>
          <p className="eyebrow">What people are saying</p>
          <h2 className="mt-sm text-2xl font-bold text-on-dark sm:text-3xl">
            Every order tells a story. Tell yours.
          </h2>
          <p className="mt-sm max-w-2xl text-muted-strong">
            {hasScore
              ? "Read the unfiltered verdicts, then add your own. Your name, rating and message go on the wall — your email and wallet address never do."
              : "Nobody has reviewed StellarTrust yet. Go first — your name, rating and message go on the wall, your email and wallet address never do."}
          </p>

          {hasScore && summary ? (
            <div className="mt-lg flex flex-wrap items-center gap-md">
              <Stars
                value={Math.round(summary.averageRating ?? 0)}
                className="h-5 w-5"
              />
              <span className="font-mono text-sm text-on-dark">
                {summary.averageRating?.toFixed(2)}
              </span>
              <span className="text-sm text-muted">
                from {summary.total}{" "}
                {summary.total === 1 ? "review" : "reviews"}
              </span>
            </div>
          ) : null}
        </div>

        <Link
          href="/feedback"
          className="btn-primary w-full justify-center sm:w-auto"
        >
          {hasScore ? "Give your opinion" : "Write the first review"}
          <Icon name="arrow-right" className="h-4 w-4" />
        </Link>
      </div>
    </section>
  );
}
