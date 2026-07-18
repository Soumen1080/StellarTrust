"use client";

import {
  HumanKycDecision,
  ReviewStatus,
  type KycReviewItem,
  type ProviderCheckStatus,
} from "@stellartrust/shared";
import { useEffect, useState } from "react";
import { ApiClientError, api } from "@/lib/api";
import { loadSession } from "@/lib/wallet-auth";

const CHECK_CLASS: Record<ProviderCheckStatus, string> = {
  pass: "text-status-verified",
  review: "text-status-review",
  fail: "text-status-rejected",
};

export function KycReviewQueue() {
  const [reviews, setReviews] = useState<KycReviewItem[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const session = loadSession();
    if (!session) {
      setError("Sign in with a compliance-enabled session to view this queue.");
      setLoading(false);
      return;
    }

    void api
      .listKycReviews(session.accessToken)
      .then(({ reviews: loadedReviews }) => setReviews(loadedReviews))
      .catch((err: unknown) => setError(accessError(err)))
      .finally(() => setLoading(false));
  }, []);

  async function resolve(
    review: KycReviewItem,
    decision: typeof HumanKycDecision.Approve | typeof HumanKycDecision.Reject,
  ) {
    const session = loadSession();
    const reason = reasons[review.id]?.trim() ?? "";
    if (!session) {
      setError("Your session expired. Sign in again before resolving a review.");
      return;
    }
    if (reason.length < 5) {
      setError("Enter a review reason of at least 5 characters.");
      return;
    }

    setResolvingId(review.id);
    setError(null);
    try {
      const updated = await api.resolveKycReview(
        session.accessToken,
        review.id,
        window.crypto.randomUUID(),
        { decision, reason },
      );
      setReviews((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
    } catch (err) {
      setError(accessError(err));
    } finally {
      setResolvingId(null);
    }
  }

  if (loading) {
    return <p className="text-sm text-muted">Loading compliance queue…</p>;
  }

  return (
    <div>
      {error ? (
        <p
          role="alert"
          className="mb-lg rounded-lg border border-status-rejected/40 bg-status-rejected/10 p-md text-sm text-status-rejected"
        >
          {error}
        </p>
      ) : null}

      {reviews.length === 0 && !error ? (
        <div className="rounded-xl border border-hairline-dark bg-surface-card-dark p-xl text-center">
          <p className="font-medium text-on-dark">No reviews queued</p>
          <p className="mt-xs text-sm text-muted">
            Borderline, conflicting, low-confidence, and provider-failure cases
            appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-lg">
          {reviews.map((review) => {
            const queued = review.status === ReviewStatus.Queued;
            return (
              <article
                key={review.id}
                className="rounded-xl border border-hairline-dark bg-surface-card-dark p-lg"
              >
                <header className="flex flex-wrap items-start justify-between gap-md">
                  <div>
                    <div className="flex flex-wrap items-center gap-sm">
                      <span className="rounded-pill border border-status-review px-sm py-xxs text-xs font-medium text-status-review">
                        AI advisory · not a final decision
                      </span>
                      <span className="text-xs uppercase tracking-wide text-muted">
                        {review.status}
                      </span>
                    </div>
                    <p className="mt-sm break-all font-mono text-xs text-muted">
                      Review {review.id}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-xl text-on-dark">
                      Risk {review.advisory.riskScore.toFixed(0)}
                    </p>
                    <p className="text-xs text-muted">
                      {(review.advisory.confidence * 100).toFixed(0)}% confidence
                    </p>
                  </div>
                </header>

                <div className="mt-lg grid gap-lg lg:grid-cols-2">
                  <section>
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
                      Provider checks
                    </h2>
                    <dl className="mt-sm grid grid-cols-2 gap-xs">
                      {(Object.entries(review.providerChecks) as [
                        string,
                        ProviderCheckStatus,
                      ][]).map(([name, status]) => (
                          <div
                            key={name}
                            className="flex items-center justify-between rounded-md bg-surface-elevated-dark px-sm py-xs"
                          >
                            <dt className="text-xs text-muted-strong">
                              {formatLabel(name)}
                            </dt>
                            <dd
                              className={`text-xs font-semibold ${CHECK_CLASS[status]}`}
                            >
                              {status}
                            </dd>
                          </div>
                        ),
                      )}
                    </dl>
                  </section>

                  <section>
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
                      Explainability
                    </h2>
                    <p className="mt-sm text-sm text-body">
                      {review.advisory.explanation}
                    </p>
                    <ul className="mt-sm space-y-xs text-xs text-muted-strong">
                      {review.advisory.signals.map((signal) => (
                        <li key={signal}>• {signal}</li>
                      ))}
                    </ul>
                  </section>
                </div>

                {queued ? (
                  <div className="mt-lg border-t border-hairline-dark pt-lg">
                    <label className="block text-xs font-semibold uppercase tracking-wide text-muted">
                      Human decision reason
                      <textarea
                        value={reasons[review.id] ?? ""}
                        onChange={(event) =>
                          setReasons((current) => ({
                            ...current,
                            [review.id]: event.target.value,
                          }))
                        }
                        minLength={5}
                        maxLength={1000}
                        rows={3}
                        className="mt-xs w-full rounded-md border border-hairline-dark bg-canvas-dark px-sm py-xs text-sm normal-case tracking-normal text-body outline-none focus:border-primary"
                        placeholder="Record the evidence and policy basis for this decision."
                      />
                    </label>
                    <div className="mt-sm flex flex-wrap gap-sm">
                      <button
                        type="button"
                        disabled={resolvingId === review.id}
                        onClick={() =>
                          void resolve(review, HumanKycDecision.Approve)
                        }
                        className="rounded-md bg-status-verified px-md py-sm text-sm font-semibold text-ink disabled:opacity-50"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={resolvingId === review.id}
                        onClick={() =>
                          void resolve(review, HumanKycDecision.Reject)
                        }
                        className="rounded-md bg-status-rejected px-md py-sm text-sm font-semibold text-on-dark disabled:opacity-50"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-lg border-t border-hairline-dark pt-md text-sm text-muted-strong">
                    Human decision: <strong>{review.resolution}</strong> · {review.resolutionReason}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function accessError(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 401) return "Your session is invalid or expired. Sign in again.";
    if (error.status === 403) {
      return "This session does not have the compliance role required to review KYC cases.";
    }
  }
  return error instanceof Error ? error.message : "Could not load the review queue.";
}

function formatLabel(value: string): string {
  return value.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase());
}
