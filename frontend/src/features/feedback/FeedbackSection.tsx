"use client";

import {
  FEEDBACK_RATING_MAX,
  type FeedbackDTO,
  type FeedbackSummaryDTO,
} from "@stellartrust/shared";
import { useCallback, useEffect, useId, useState } from "react";
import { Icon } from "@/components/Icon";
import { useIdentity } from "@/components/IdentityProvider";
import { ApiClientError, api } from "@/lib/api";
import { Stars } from "./Stars";

/**
 * Public feedback wall plus the form that writes to it.
 *
 * Two audiences in one section. The form asks for a name, an email, a wallet
 * address, a message and a rating; the wall below shows the name, the rating
 * and the message to everyone. The contact fields are collected and never
 * displayed — the API does not return them at all — so the form labels say so
 * rather than leaving the submitter to guess what becomes public.
 */
export function FeedbackSection() {
  const { session, profile } = useIdentity();
  const [entries, setEntries] = useState<FeedbackDTO[]>([]);
  const [summary, setSummary] = useState<FeedbackSummaryDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mine, setMine] = useState<FeedbackDTO | null>(null);

  const [rating, setRating] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [justSubmitted, setJustSubmitted] = useState(false);

  const load = useCallback(async () => {
    const wall = await api.listFeedback();
    setEntries(wall.feedback);
    setSummary(wall.summary);
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void load()
      .catch((err: unknown) => {
        if (active)
          setLoadError(
            err instanceof Error ? err.message : "Could not load feedback",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load]);

  // Whether this account has already posted. A failure here is not worth
  // surfacing: the wall itself is public, so a stale session should still
  // render it — the form simply stays available and the POST reports the clash.
  useEffect(() => {
    if (!session) return;
    let active = true;
    void api
      .getMyFeedback(session.accessToken)
      .then(({ feedback }) => {
        if (active) setMine(feedback);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [session]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    const form = event.currentTarget;
    const data = new FormData(form);

    // Stars are not a native form control, so `required` cannot cover this one.
    if (rating < 1) {
      setFormError("Choose a star rating.");
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      const { feedback } = await api.submitFeedback(session.accessToken, {
        name: String(data.get("name") ?? "").trim(),
        email: String(data.get("email") ?? "").trim(),
        walletAddress: String(data.get("walletAddress") ?? "").trim(),
        message: String(data.get("message") ?? "").trim(),
        rating,
      });
      setMine(feedback);
      setJustSubmitted(true);
      form.reset();
      setRating(0);
      await load();
    } catch (err) {
      setFormError(
        err instanceof ApiClientError || err instanceof Error
          ? err.message
          : "Could not submit your feedback",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const defaultName = profile?.user.displayName?.trim() ?? "";
  const defaultWallet =
    profile?.wallets[0]?.stellarPublicKey ??
    session?.wallet.stellarPublicKey ??
    "";

  return (
    <section>
      {/* Score board. Hidden until there is something to average, because a
          "0.00 out of 5" on an empty wall reads as a bad product rather than
          a new one. */}
      {summary && summary.total > 0 ? (
        <div className="panel-dark flex flex-wrap items-center gap-lg p-lg">
          <div className="flex items-baseline gap-sm">
            <span className="font-mono text-4xl font-bold text-on-dark">
              {summary.averageRating?.toFixed(2)}
            </span>
            <span className="text-sm text-muted">/ {FEEDBACK_RATING_MAX}</span>
          </div>
          <div>
            <Stars
              value={Math.round(summary.averageRating ?? 0)}
              className="h-5 w-5"
            />
            <p className="mt-xs text-xs text-muted">
              from {summary.total} {summary.total === 1 ? "review" : "reviews"}
            </p>
          </div>
          <div className="ml-auto hidden min-w-[220px] flex-col gap-[3px] sm:flex">
            {[5, 4, 3, 2, 1].map((star) => {
              const count = summary.distribution[String(star)] ?? 0;
              const share = summary.total ? (count / summary.total) * 100 : 0;
              return (
                <div key={star} className="flex items-center gap-sm">
                  <span className="w-3 text-right font-mono text-[11px] text-muted">
                    {star}
                  </span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-pill bg-surface-elevated-dark">
                    <span
                      className="block h-full rounded-pill bg-status-review"
                      style={{ width: `${share}%` }}
                    />
                  </span>
                  <span className="w-5 font-mono text-[11px] text-muted">
                    {count}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="mt-lg grid items-start gap-lg xl:grid-cols-[360px_minmax(0,1fr)]">
        {mine ? (
          <section className="panel-light p-lg text-ink">
            <div className="flex items-center gap-sm">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-status-verified/10 text-status-verified">
                <Icon name="check" />
              </span>
              <div>
                <h3 className="font-semibold">
                  {justSubmitted ? "Thanks — it is live" : "You left feedback"}
                </h3>
                <p className="text-xs text-muted">One review per account</p>
              </div>
            </div>
            <blockquote className="mt-md rounded-lg bg-surface-strong-light p-md text-sm leading-6">
              {mine.message}
            </blockquote>
            <div className="mt-md">
              <Stars value={mine.rating} />
            </div>
          </section>
        ) : (
          <form onSubmit={handleSubmit} className="panel-light p-lg text-ink">
            <h3 className="font-semibold">Leave feedback</h3>
            <p className="mt-xs text-sm text-muted">
              Your name, rating and message appear on the wall. Your email and
              wallet address stay private.
            </p>

            <div className="mt-lg space-y-md">
              <Field label="Name" hint="Shown publicly">
                <input
                  name="name"
                  required
                  minLength={2}
                  maxLength={80}
                  defaultValue={defaultName}
                  autoComplete="name"
                  placeholder="How you want to be credited"
                  className="input"
                />
              </Field>
              <Field label="Email" hint="Never shown">
                <input
                  name="email"
                  type="email"
                  required
                  maxLength={254}
                  autoComplete="email"
                  placeholder="name@example.com"
                  className="input"
                />
              </Field>
              <Field label="Wallet address" hint="Never shown">
                <input
                  name="walletAddress"
                  required
                  pattern="G[A-Z2-7]{55}"
                  defaultValue={defaultWallet}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="G…"
                  className="input font-mono text-xs"
                />
              </Field>
              <RatingInput value={rating} onChange={setRating} />
              <Field label="Feedback" hint="Shown publicly">
                <textarea
                  name="message"
                  required
                  minLength={10}
                  maxLength={1000}
                  rows={4}
                  placeholder="What worked well, and what did not?"
                  className="input resize-y"
                />
              </Field>
            </div>

            {formError ? (
              <p
                role="alert"
                className="mt-md rounded-lg border border-status-rejected/30 bg-status-rejected/10 p-sm text-sm text-status-rejected"
              >
                {formError}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={submitting || !session}
              className="btn-primary mt-lg w-full"
            >
              {submitting ? "Posting…" : "Post feedback"}
            </button>
          </form>
        )}

        <div className="panel-dark overflow-hidden">
          <div className="border-b border-hairline-dark p-lg">
            <h3 className="font-semibold text-on-dark">
              What people are saying
            </h3>
            <p className="mt-xs text-xs text-muted">
              Visible to everyone, signed in or not
            </p>
          </div>

          {loadError ? (
            <p role="alert" className="p-lg text-sm text-status-rejected">
              {loadError}
            </p>
          ) : loading ? (
            <div className="space-y-md p-lg" aria-label="Loading feedback">
              {Array.from({ length: 3 }).map((_, index) => (
                <div
                  key={index}
                  className="h-24 animate-pulse rounded-lg bg-surface-elevated-dark"
                />
              ))}
            </div>
          ) : entries.length ? (
            <ul className="divide-y divide-hairline-dark">
              {entries.map((entry) => (
                <li key={entry.id} className="p-md sm:p-lg">
                  <div className="flex flex-wrap items-center justify-between gap-sm">
                    <div className="flex items-center gap-sm">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-elevated-dark text-sm font-semibold text-primary">
                        {initial(entry.name)}
                      </span>
                      <p className="font-semibold text-on-dark">{entry.name}</p>
                    </div>
                    <Stars value={entry.rating} />
                  </div>
                  <p className="mt-sm whitespace-pre-line break-words text-sm leading-6 text-muted-strong">
                    {entry.message}
                  </p>
                  <p className="mt-sm text-xs text-muted">
                    {new Date(entry.createdAt).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-lg py-xxl text-center">
              <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-surface-elevated-dark text-muted">
                <Icon name="star" />
              </span>
              <h4 className="mt-md font-semibold text-on-dark">
                No feedback yet
              </h4>
              <p className="mx-auto mt-xs max-w-md text-sm text-muted">
                Be the first to review StellarTrust.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Star picker.
 *
 * A radio group rather than buttons: a rating is one choice among five, so
 * native radios give arrow-key selection, form semantics, and a screen-reader
 * announcement of "3 stars, 3 of 5" for free. The drawn stars are the labels.
 */
function RatingInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (next: number) => void;
}) {
  const name = useId();
  const [hovered, setHovered] = useState(0);
  const shown = hovered || value;

  return (
    <fieldset>
      <legend className="text-sm font-medium text-ink">
        Rating
        <span className="ml-xs text-xs font-normal text-muted">
          · Shown publicly
        </span>
      </legend>
      <div
        className="mt-xs flex items-center gap-xs"
        onMouseLeave={() => setHovered(0)}
      >
        {Array.from(
          { length: FEEDBACK_RATING_MAX },
          (_, index) => index + 1,
        ).map((star) => (
          <label
            key={star}
            onMouseEnter={() => setHovered(star)}
            className="cursor-pointer rounded p-[2px] leading-none focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-info"
          >
            <input
              type="radio"
              name={name}
              value={star}
              checked={value === star}
              onChange={() => onChange(star)}
              className="sr-only"
            />
            <Icon
              name="star"
              className={`h-7 w-7 transition ${
                star <= shown ? "text-status-review" : "text-muted"
              }`}
              fill={star <= shown ? "currentColor" : "none"}
            />
            <span className="sr-only">
              {star} {star === 1 ? "star" : "stars"}
            </span>
          </label>
        ))}
        <span className="ml-sm text-sm text-muted">
          {value ? `${value} / ${FEEDBACK_RATING_MAX}` : "Not rated"}
        </span>
      </div>
    </fieldset>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm font-medium text-ink">
      {label}
      {hint ? (
        <span className="ml-xs text-xs font-normal text-muted">· {hint}</span>
      ) : null}
      <span className="mt-xs block">{children}</span>
    </label>
  );
}

function initial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}
