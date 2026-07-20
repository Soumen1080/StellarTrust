"use client";

import { HumanKycDecision, ReviewStatus, type KycReviewItem, type ProviderCheckStatus } from "@stellartrust/shared";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { ApiClientError, api } from "@/lib/api";
import { loadSession } from "@/lib/wallet-auth";

const CHECK_CLASS: Record<ProviderCheckStatus, string> = { pass: "text-status-verified", review: "text-status-review", fail: "text-status-rejected" };
type QueueFilter = "all" | "queued" | "resolved";

export function KycReviewQueue() {
  const [reviews, setReviews] = useState<KycReviewItem[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<QueueFilter>("queued");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const session = loadSession();
    if (!session) { setError("Sign in with a compliance-enabled session to view this queue."); setLoading(false); return; }
    void api.listKycReviews(session.accessToken).then(({ reviews: loadedReviews }) => setReviews(loadedReviews)).catch((err: unknown) => setError(accessError(err))).finally(() => setLoading(false));
  }, []);

  async function resolve(review: KycReviewItem, decision: typeof HumanKycDecision.Approve | typeof HumanKycDecision.Reject) {
    const session = loadSession();
    const reason = reasons[review.id]?.trim() ?? "";
    if (!session) { setError("Your session expired. Sign in again before resolving a review."); return; }
    if (reason.length < 5) { setError("Enter a review reason of at least 5 characters."); return; }
    setResolvingId(review.id); setError(null);
    try {
      const updated = await api.resolveKycReview(session.accessToken, review.id, window.crypto.randomUUID(), { decision, reason });
      setReviews((current) => current.map((item) => item.id === updated.id ? updated : item));
      setReasons((current) => { const next = { ...current }; delete next[review.id]; return next; });
    } catch (err) { setError(accessError(err)); }
    finally { setResolvingId(null); }
  }

  const queuedCount = reviews.filter((review) => review.status === ReviewStatus.Queued).length;
  const highRiskCount = reviews.filter((review) => review.advisory.riskScore >= 70 && review.status === ReviewStatus.Queued).length;
  const visible = useMemo(() => reviews.filter((review) => {
    const queued = review.status === ReviewStatus.Queued;
    if (filter === "queued" && !queued) return false;
    if (filter === "resolved" && queued) return false;
    return !query || review.id.toLowerCase().includes(query.toLowerCase()) || review.advisory.explanation.toLowerCase().includes(query.toLowerCase());
  }), [filter, query, reviews]);

  if (loading) return <div className="space-y-md" aria-label="Loading compliance queue"><div className="grid gap-md sm:grid-cols-3">{Array.from({ length: 3 }).map((_, index) => <div key={index} className="panel-dark h-28 animate-pulse" />)}</div><div className="panel-dark h-72 animate-pulse" /></div>;

  return <div>
    <section className="mb-lg grid gap-md sm:grid-cols-3"><QueueMetric label="Waiting for review" value={queuedCount} copy="Requires a human decision" tone={queuedCount ? "attention" : "default"}/><QueueMetric label="High-risk queued" value={highRiskCount} copy="Risk score of 70 or higher" tone={highRiskCount ? "danger" : "default"}/><QueueMetric label="Resolved cases" value={reviews.length - queuedCount} copy="Decision and reason recorded" tone="default"/></section>

    {error ? <div role="alert" className="mb-lg flex items-start justify-between gap-md rounded-lg border border-status-rejected/30 bg-status-rejected/10 p-md text-sm text-status-rejected"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss error"><Icon name="x" className="h-4 w-4"/></button></div> : null}

    <div className="mb-md flex flex-col gap-sm md:flex-row md:items-center md:justify-between"><div className="flex gap-xs">{(["queued", "all", "resolved"] as QueueFilter[]).map((item) => <button key={item} type="button" onClick={() => setFilter(item)} className={`min-h-9 rounded-md px-md text-sm font-medium capitalize ${filter === item ? "bg-primary text-ink" : "bg-surface-card-dark text-muted-strong hover:text-on-dark"}`}>{item}</button>)}</div><label className="block md:w-80"><span className="sr-only">Search reviews</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search review ID or explanation" className="input-dark"/></label></div>

    {visible.length === 0 && !error ? <div className="panel-dark px-lg py-xxl text-center"><span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-surface-elevated-dark text-status-verified"><Icon name="check" /></span><h2 className="mt-md font-semibold text-on-dark">{reviews.length ? "No matching reviews" : "No reviews queued"}</h2><p className="mx-auto mt-xs max-w-lg text-sm text-muted">{reviews.length ? "Adjust the current filter or search term." : "Borderline, conflicting, low-confidence, and provider-failure cases will appear here."}</p></div> : <div className="space-y-md">{visible.map((review) => {
      const queued = review.status === ReviewStatus.Queued;
      const expanded = expandedId === review.id;
      const checks = Object.entries(review.providerChecks) as [string, ProviderCheckStatus][];
      const failedChecks = checks.filter(([, status]) => status !== "pass").length;
      return <article key={review.id} className="panel-dark overflow-hidden"><div className="p-lg"><header className="flex flex-col justify-between gap-md sm:flex-row sm:items-start"><div><div className="flex flex-wrap items-center gap-sm"><span className={`rounded-pill border px-sm py-xs text-xs font-semibold capitalize ${queued ? "border-status-review/30 bg-status-review/10 text-status-review" : "border-status-verified/30 bg-status-verified/10 text-status-verified"}`}>{queued ? "● Awaiting decision" : `● ${review.status}`}</span><span className="rounded-pill border border-info/30 bg-info/10 px-sm py-xs text-xs font-semibold text-info"><Icon name="sparkles" className="mr-xs inline h-3.5 w-3.5"/>AI advisory</span></div><p className="mt-md font-mono text-xs text-muted">Review · {review.id}</p></div><div className="flex items-start gap-lg sm:text-right"><div><p className={`font-mono text-2xl font-semibold ${review.advisory.riskScore >= 70 ? "text-status-rejected" : review.advisory.riskScore >= 40 ? "text-status-review" : "text-status-verified"}`}>{review.advisory.riskScore.toFixed(0)}</p><p className="text-[10px] uppercase tracking-wider text-muted">Risk score</p></div><div><p className="font-mono text-2xl font-semibold text-on-dark">{(review.advisory.confidence * 100).toFixed(0)}%</p><p className="text-[10px] uppercase tracking-wider text-muted">Confidence</p></div></div></header>
      <div className="mt-lg grid gap-md border-t border-hairline-dark pt-md sm:grid-cols-3"><div><p className="text-[10px] uppercase tracking-wider text-muted">Provider checks</p><p className={`mt-xs text-sm font-medium ${failedChecks ? "text-status-review" : "text-status-verified"}`}>{failedChecks ? `${failedChecks} require attention` : "All passed"}</p></div><div><p className="text-[10px] uppercase tracking-wider text-muted">Signals considered</p><p className="mt-xs text-sm text-body">{review.advisory.signals.length} explainability signal{review.advisory.signals.length === 1 ? "" : "s"}</p></div><div className="sm:text-right"><button type="button" onClick={() => setExpandedId(expanded ? null : review.id)} className="text-sm font-semibold text-primary">{expanded ? "Hide case details" : "Review case details"}<Icon name="chevron-down" className={`ml-xs inline h-4 w-4 transition ${expanded ? "rotate-180" : ""}`}/></button></div></div></div>

      {expanded ? <div className="border-t border-hairline-dark bg-canvas-dark/40 p-lg"><div className="grid gap-lg lg:grid-cols-2"><section><h2 className="eyebrow">Provider evidence</h2><dl className="mt-md grid gap-xs sm:grid-cols-2">{checks.map(([name, status]) => <div key={name} className="flex items-center justify-between rounded-md border border-hairline-dark bg-surface-card-dark px-sm py-sm"><dt className="text-xs text-muted-strong">{formatLabel(name)}</dt><dd className={`flex items-center gap-xs text-xs font-semibold capitalize ${CHECK_CLASS[status]}`}><span className="h-1.5 w-1.5 rounded-full bg-current"/>{status}</dd></div>)}</dl></section><section><h2 className="eyebrow">Advisory explanation</h2><p className="mt-md text-sm leading-6 text-body">{review.advisory.explanation}</p><ul className="mt-md space-y-xs text-xs text-muted-strong">{review.advisory.signals.map((signal) => <li key={signal} className="flex gap-xs"><span className="text-info">•</span>{signal}</li>)}</ul></section></div>
      {queued ? <div className="mt-lg border-t border-hairline-dark pt-lg"><label className="block text-sm font-medium text-body">Decision rationale <span className="text-xs font-normal text-muted">· required for the audit log</span><textarea value={reasons[review.id] ?? ""} onChange={(event) => setReasons((current) => ({ ...current, [review.id]: event.target.value }))} minLength={5} maxLength={1000} rows={4} className="input-dark mt-xs resize-y" placeholder="Record the evidence and policy basis for this decision."/></label><div className="mt-md flex flex-col gap-sm sm:flex-row"><button type="button" disabled={resolvingId !== null} onClick={() => void resolve(review, HumanKycDecision.Approve)} className="inline-flex min-h-10 items-center justify-center gap-xs rounded-md bg-status-verified px-lg text-sm font-semibold text-ink disabled:opacity-50"><Icon name="check" className="h-4 w-4"/>{resolvingId === review.id ? "Recording decision…" : "Approve verification"}</button><button type="button" disabled={resolvingId !== null} onClick={() => void resolve(review, HumanKycDecision.Reject)} className="inline-flex min-h-10 items-center justify-center gap-xs rounded-md bg-status-rejected px-lg text-sm font-semibold text-on-dark disabled:opacity-50"><Icon name="x" className="h-4 w-4"/>Reject verification</button><p className="self-center text-xs text-muted sm:ml-auto">This human decision is final and auditable.</p></div></div> : <div className="mt-lg rounded-lg border border-hairline-dark bg-surface-card-dark p-md"><p className="text-[10px] uppercase tracking-wider text-muted">Recorded human decision</p><p className="mt-xs text-sm text-body"><strong className="capitalize text-on-dark">{review.resolution}</strong> · {review.resolutionReason}</p></div>}</div> : null}</article>;
    })}</div>}
  </div>;
}

function QueueMetric({ label, value, copy, tone }: { label: string; value: number; copy: string; tone: "default" | "attention" | "danger" }) { const cls = tone === "danger" ? "text-status-rejected" : tone === "attention" ? "text-status-review" : "text-on-dark"; return <div className="panel-dark p-lg"><p className="text-xs text-muted">{label}</p><p className={`mt-xs font-mono text-3xl font-semibold ${cls}`}>{value}</p><p className="mt-xs text-xs text-muted">{copy}</p></div>; }
function accessError(error: unknown): string { if (error instanceof ApiClientError) { if (error.status === 401) return "Your session is invalid or expired. Sign in again."; if (error.status === 403) return "This session does not have the compliance role required to review KYC cases."; } return error instanceof Error ? error.message : "Could not load the review queue."; }
function formatLabel(value: string): string { return value.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase()); }
