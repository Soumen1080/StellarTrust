"use client";

import { useState, type FormEvent } from "react";
import { ReviewStatus, type KycReviewItem } from "@stellartrust/shared";
import { api } from "@/lib/api";

export function DevKycApproval() {
  const [password, setPassword] = useState("");
  const [reviews, setReviews] = useState<KycReviewItem[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [approvalKeys, setApprovalKeys] = useState<Record<string, string>>({});
  const [unlocked, setUnlocked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const response = await api.listDevKycReviews(password);
      setReviews(response.reviews);
      setUnlocked(true);
    } catch (err) {
      setUnlocked(false);
      setError(err instanceof Error ? err.message : "Could not unlock approval queue");
    } finally {
      setLoading(false);
    }
  }

  async function approve(review: KycReviewItem) {
    if (approvingId) return;
    const reason = reasons[review.id]?.trim() ?? "";
    if (reason.length < 5) {
      setError("Enter an approval reason of at least 5 characters.");
      return;
    }

    const idempotencyKey =
      approvalKeys[review.id] ?? window.crypto.randomUUID();
    if (!approvalKeys[review.id]) {
      setApprovalKeys((current) => ({
        ...current,
        [review.id]: idempotencyKey,
      }));
    }

    setApprovingId(review.id);
    setError(null);
    try {
      const updated = await api.approveDevKycReview(
        password,
        review.id,
        idempotencyKey,
        reason,
      );
      setReviews((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setApprovalKeys((current) => {
        const next = { ...current };
        delete next[review.id];
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not approve review");
    } finally {
      setApprovingId(null);
    }
  }

  if (!unlocked) {
    return (
      <form
        onSubmit={unlock}
        className="max-w-md rounded-xl border border-hairline-dark bg-surface-card-dark p-xl"
      >
        <label className="block text-sm font-medium text-body">
          Development approval password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={8}
            required
            autoComplete="off"
            className="mt-sm w-full rounded-md border border-hairline-dark bg-canvas-dark px-md py-sm text-on-dark outline-none focus:border-primary"
          />
        </label>
        {error ? (
          <p role="alert" className="mt-md text-sm text-status-rejected">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={loading}
          className="mt-lg rounded-md bg-primary px-lg py-sm text-sm font-semibold text-on-primary disabled:opacity-50"
        >
          {loading ? "Checking…" : "Open approval queue"}
        </button>
      </form>
    );
  }

  const queuedReviews = reviews.filter(
    (review) => review.status === ReviewStatus.Queued,
  );

  return (
    <section>
      <div className="mb-lg flex flex-wrap items-center justify-between gap-md">
        <p className="text-sm text-muted">
          {queuedReviews.length} queued review{queuedReviews.length === 1 ? "" : "s"}
        </p>
        <button
          type="button"
          disabled={approvingId !== null}
          onClick={() => {
            setPassword("");
            setReviews([]);
            setApprovalKeys({});
            setUnlocked(false);
            setError(null);
          }}
          className="rounded-md border border-hairline-dark px-md py-xs text-sm text-body disabled:opacity-50"
        >
          Lock
        </button>
      </div>

      {error ? (
        <p
          role="alert"
          className="mb-lg rounded-md border border-status-rejected/40 bg-status-rejected/10 p-md text-sm text-status-rejected"
        >
          {error}
        </p>
      ) : null}

      {queuedReviews.length === 0 ? (
        <div className="rounded-xl border border-hairline-dark bg-surface-card-dark p-xl text-center">
          <p className="font-medium text-on-dark">No KYC reviews are waiting</p>
          <a href="/kyc" className="mt-md inline-block text-sm text-primary">
            Open KYC application
          </a>
        </div>
      ) : (
        <div className="space-y-lg">
          {queuedReviews.map((review) => (
            <article
              key={review.id}
              className="rounded-xl border border-hairline-dark bg-surface-card-dark p-lg"
            >
              <div className="flex flex-wrap justify-between gap-md">
                <div>
                  <p className="text-xs uppercase tracking-wide text-status-review">
                    Queued for manual approval
                  </p>
                  <p className="mt-xs break-all font-mono text-xs text-muted">
                    {review.id}
                  </p>
                </div>
                <p className="font-mono text-lg text-on-dark">
                  Risk {review.advisory.riskScore.toFixed(2)}
                </p>
              </div>
              <p className="mt-md text-sm text-body">
                {review.advisory.explanation}
              </p>
              <label className="mt-lg block text-sm text-muted-strong">
                Approval reason
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
                  placeholder="Documents manually verified"
                  className="mt-xs w-full rounded-md border border-hairline-dark bg-canvas-dark px-md py-sm text-body outline-none focus:border-primary"
                />
              </label>
              <button
                type="button"
                disabled={approvingId !== null}
                onClick={() => void approve(review)}
                className="mt-md rounded-md bg-status-verified px-lg py-sm text-sm font-semibold text-ink disabled:opacity-50"
              >
                {approvingId === review.id ? "Approving…" : "Approve KYC"}
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
