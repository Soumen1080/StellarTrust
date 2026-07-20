"use client";

import { ReviewStatus, type KycReviewItem } from "@stellartrust/shared";
import { type FormEvent, useState } from "react";
import { Icon } from "@/components/Icon";
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
    event.preventDefault(); setLoading(true); setError(null);
    try { const response = await api.listDevKycReviews(password); setReviews(response.reviews); setUnlocked(true); }
    catch (err) { setUnlocked(false); setError(err instanceof Error ? err.message : "Could not unlock approval queue"); }
    finally { setLoading(false); }
  }

  async function approve(review: KycReviewItem) {
    if (approvingId) return;
    const reason = reasons[review.id]?.trim() ?? "";
    if (reason.length < 5) { setError("Enter an approval reason of at least 5 characters."); return; }
    const idempotencyKey = approvalKeys[review.id] ?? window.crypto.randomUUID();
    if (!approvalKeys[review.id]) setApprovalKeys((current) => ({ ...current, [review.id]: idempotencyKey }));
    setApprovingId(review.id); setError(null);
    try {
      const updated = await api.approveDevKycReview(password, review.id, idempotencyKey, reason);
      setReviews((current) => current.map((item) => item.id === updated.id ? updated : item));
      setApprovalKeys((current) => { const next = { ...current }; delete next[review.id]; return next; });
    } catch (err) { setError(err instanceof Error ? err.message : "Could not approve review"); }
    finally { setApprovingId(null); }
  }

  if (!unlocked) return <div className="grid items-start gap-lg lg:grid-cols-[minmax(0,1fr)_340px]"><form onSubmit={unlock} className="panel-dark p-lg sm:p-xl"><span className="grid h-11 w-11 place-items-center rounded-lg bg-surface-elevated-dark text-primary"><Icon name="lock" /></span><h2 className="mt-lg text-xl font-semibold text-on-dark">Unlock sandbox queue</h2><p className="mt-xs max-w-lg text-sm leading-6 text-muted">Enter the local development approval password configured by the backend. Credentials remain in memory for this page session only.</p><label className="mt-lg block text-sm font-medium text-body">Development approval password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} required autoComplete="off" placeholder="Minimum 8 characters" className="input-dark mt-xs"/></label>{error ? <p role="alert" className="mt-md rounded-md bg-status-rejected/10 p-sm text-sm text-status-rejected">{error}</p> : null}<button type="submit" disabled={loading} className="btn-primary mt-lg">{loading ? "Verifying access…" : "Open approval queue"}<Icon name="arrow-right" className="h-4 w-4"/></button></form><aside className="panel-dark p-lg"><p className="text-sm font-semibold text-on-dark">Safety controls</p><ul className="mt-md space-y-md text-sm text-muted-strong"><li className="flex gap-sm"><Icon name="shield" className="h-5 w-5 shrink-0 text-status-verified"/><span>Route returns 404 outside development.</span></li><li className="flex gap-sm"><Icon name="lock" className="h-5 w-5 shrink-0 text-status-verified"/><span>Password is sent only in the development approval header.</span></li><li className="flex gap-sm"><Icon name="document" className="h-5 w-5 shrink-0 text-status-verified"/><span>Every approval requires a written reason and idempotency key.</span></li></ul></aside></div>;

  const queuedReviews = reviews.filter((review) => review.status === ReviewStatus.Queued);
  return <section><div className="mb-lg flex flex-col justify-between gap-md rounded-xl border border-hairline-dark bg-surface-card-dark p-lg sm:flex-row sm:items-center"><div className="flex items-center gap-sm"><span className="grid h-10 w-10 place-items-center rounded-full bg-status-verified/10 text-status-verified"><Icon name="check"/></span><div><p className="font-semibold text-on-dark">Queue unlocked</p><p className="text-xs text-muted">{queuedReviews.length} review{queuedReviews.length === 1 ? "" : "s"} waiting</p></div></div><button type="button" disabled={approvingId !== null} onClick={() => { setPassword(""); setReviews([]); setApprovalKeys({}); setUnlocked(false); setError(null); }} className="btn-secondary-dark"><Icon name="lock" className="h-4 w-4"/>Lock queue</button></div>
  {error ? <p role="alert" className="mb-lg rounded-lg border border-status-rejected/30 bg-status-rejected/10 p-md text-sm text-status-rejected">{error}</p> : null}
  {queuedReviews.length === 0 ? <div className="panel-dark px-lg py-xxl text-center"><span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-status-verified/10 text-status-verified"><Icon name="check"/></span><h2 className="mt-md font-semibold text-on-dark">No KYC reviews are waiting</h2><p className="mt-xs text-sm text-muted">New sandbox review cases will appear here.</p><a href="/kyc" className="mt-md inline-flex items-center gap-xs text-sm font-semibold text-primary">Open KYC application <Icon name="arrow-right" className="h-4 w-4"/></a></div> : <div className="space-y-md">{queuedReviews.map((review) => <article key={review.id} className="panel-dark p-lg"><div className="flex flex-col justify-between gap-md sm:flex-row sm:items-start"><div><span className="rounded-pill border border-status-review/30 bg-status-review/10 px-sm py-xs text-xs font-semibold text-status-review">● Manual approval</span><p className="mt-md break-all font-mono text-xs text-muted">{review.id}</p></div><div className="sm:text-right"><p className={`font-mono text-2xl font-semibold ${review.advisory.riskScore >= 70 ? "text-status-rejected" : "text-status-review"}`}>{review.advisory.riskScore.toFixed(0)}</p><p className="text-[10px] uppercase tracking-wider text-muted">Risk score</p></div></div><div className="mt-lg rounded-lg bg-surface-elevated-dark p-md"><div className="flex items-center gap-xs text-xs font-semibold text-info"><Icon name="sparkles" className="h-4 w-4"/>AI advisory</div><p className="mt-sm text-sm leading-6 text-body">{review.advisory.explanation}</p></div><label className="mt-lg block text-sm font-medium text-body">Approval rationale <span className="text-xs font-normal text-muted">· saved to audit history</span><textarea value={reasons[review.id] ?? ""} onChange={(event) => setReasons((current) => ({ ...current, [review.id]: event.target.value }))} minLength={5} maxLength={1000} rows={3} placeholder="Documents manually verified against sandbox policy" className="input-dark mt-xs resize-y"/></label><div className="mt-md flex flex-col gap-sm sm:flex-row sm:items-center"><button type="button" disabled={approvingId !== null} onClick={() => void approve(review)} className="inline-flex min-h-10 items-center justify-center gap-xs rounded-md bg-status-verified px-lg text-sm font-semibold text-ink disabled:opacity-50"><Icon name="check" className="h-4 w-4"/>{approvingId === review.id ? "Approving…" : "Approve KYC"}</button><p className="text-xs text-muted">Development approval cannot reject a case; use the compliance queue for full decisions.</p></div></article>)}</div>}</section>;
}
