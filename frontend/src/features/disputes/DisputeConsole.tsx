"use client";

import {
  DisputeResolution,
  DisputeSettlementStatus,
  EvidenceKind,
  type AuthSessionResponse,
  type DisputeDTO,
  type DisputeLogEntryDTO,
  type DisputeSettlementOutcomeDTO,
} from "@stellartrust/shared";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { useIdentity } from "@/components/IdentityProvider";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The dispute operation failed";
}

const EVIDENCE_KINDS = Object.values(EvidenceKind);

/** Relative time for a log line — an audit trail is read as "when", not "at". */
function timeAgo(iso: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function hoursUntil(iso: string, now: number): number {
  return Math.ceil((new Date(iso).getTime() - now) / 3_600_000);
}

export function DisputeConsole() {
  const { session } = useIdentity();
  const searchParams = useSearchParams();
  // Deep link from an escrow order card: /disputes?order=<uuid>.
  const linkedOrderId = searchParams.get("order") ?? "";

  const [disputes, setDisputes] = useState<DisputeDTO[]>([]);
  const [queue, setQueue] = useState<DisputeDTO[]>([]);
  const [isCompliance, setIsCompliance] = useState(false);
  const [orderId, setOrderId] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const refresh = useCallback(async (active: AuthSessionResponse) => {
    // Party-scoped: this returns claims filed BY the user and claims filed
    // AGAINST them, which is the only way a respondent can answer one.
    const mine = await api.listDisputes(active.accessToken);
    setDisputes(mine.disputes);
    // The queue is compliance-gated; probe it and hide the panel on 403.
    try {
      const q = await api.listDisputeQueue(active.accessToken);
      setQueue(q.disputes);
      setIsCompliance(true);
    } catch {
      setIsCompliance(false);
    }
  }, []);

  useEffect(() => {
    if (!session) {
      setDisputes([]);
      setQueue([]);
      setIsCompliance(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void refresh(session)
      .catch((err: unknown) => setError(message(err)))
      .finally(() => setLoading(false));
  }, [refresh, session]);

  // Arriving from an escrow card: if a dispute already exists on that order,
  // open it; otherwise prefill the form so the id never has to be retyped.
  useEffect(() => {
    if (!linkedOrderId || loading) return;
    const existing = disputes.find((item) => item.orderId === linkedOrderId);
    if (existing) {
      setExpandedId(existing.id);
    } else {
      setOrderId(linkedOrderId);
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [disputes, linkedOrderId, loading]);

  async function openDispute(event: FormEvent) {
    event.preventDefault();
    if (!session) return;
    setPending("open");
    setError(null);
    try {
      await api.openDispute(session.accessToken, crypto.randomUUID(), {
        orderId: orderId.trim(),
        reason: reason.trim(),
      });
      setOrderId("");
      setReason("");
      await refresh(session);
    } catch (err) {
      setError(message(err));
    } finally {
      setPending(null);
    }
  }

  async function addEvidence(
    disputeId: string,
    supports: DisputeResolution,
    kind: (typeof EVIDENCE_KINDS)[number],
    weight: number,
  ) {
    if (!session) return;
    setPending(disputeId);
    setError(null);
    try {
      await api.submitDisputeEvidence(
        session.accessToken,
        disputeId,
        crypto.randomUUID(),
        {
          kind,
          supports,
          weight,
          reference: `storage://evidence/${crypto.randomUUID()}`,
        },
      );
      await refresh(session);
    } catch (err) {
      setError(message(err));
    } finally {
      setPending(null);
    }
  }

  async function autoResolve(disputeId: string) {
    if (!session) return;
    setPending(disputeId);
    setError(null);
    try {
      await api.resolveDispute(session.accessToken, disputeId, crypto.randomUUID());
      await refresh(session);
    } catch (err) {
      setError(message(err));
    } finally {
      setPending(null);
    }
  }

  async function humanResolve(
    disputeId: string,
    decision: DisputeResolution,
    decisionReason: string,
  ) {
    if (!session) return;
    setPending(disputeId);
    setError(null);
    try {
      await api.resolveDispute(session.accessToken, disputeId, crypto.randomUUID(), {
        decision,
        reason: decisionReason,
      });
      await refresh(session);
    } catch (err) {
      setError(message(err));
    } finally {
      setPending(null);
    }
  }

  if (!session) {
    return (
      <section className="panel-dark overflow-hidden">
        <div className="p-lg sm:p-xl md:p-xxl">
          <span className="grid h-12 w-12 place-items-center rounded-lg bg-primary/10 text-primary">
            <Icon name="shield" className="h-6 w-6" />
          </span>
          <h2 className="mt-lg text-xl font-bold text-on-dark sm:text-2xl">Connect your wallet to manage disputes</h2>
          <p className="mt-sm max-w-xl leading-7 text-muted-strong">
            Open a dispute on an order, submit evidence within the review window, and see an explainable AI recommendation. High-value or low-confidence disputes are escalated to a human decision.
          </p>
          <Link href="/" className="btn-primary mt-lg">Connect wallet <Icon name="arrow-right" className="h-4 w-4" /></Link>
        </div>
      </section>
    );
  }

  const shown = isCompliance ? mergeById(disputes, queue) : disputes;
  const linkedDispute = linkedOrderId
    ? shown.find((item) => item.orderId === linkedOrderId)
    : undefined;

  return (
    <div className="grid items-start gap-lg xl:grid-cols-[minmax(0,1fr)_360px]">
      <section>
        {error ? (
          <div role="alert" className="mb-lg flex items-start justify-between gap-md rounded-lg border border-status-rejected/30 bg-status-rejected/10 p-md text-sm text-status-rejected">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss error" className="icon-button"><Icon name="x" className="h-4 w-4" /></button>
          </div>
        ) : null}

        {linkedOrderId ? (
          <div className="mb-lg flex flex-wrap items-center justify-between gap-sm rounded-lg border border-hairline-dark bg-surface-card-dark p-md text-sm">
            <span className="text-muted-strong">
              {linkedDispute ? "Showing the dispute on order" : "Filing a dispute on order"}{" "}
              <code className="select-all break-all font-mono text-xs text-body">{linkedOrderId}</code>
            </span>
            <Link href="/escrow" className="text-xs font-semibold text-primary hover:underline">Back to escrow</Link>
          </div>
        ) : null}

        <h2 className="mb-md text-sm font-semibold text-on-dark">
          {isCompliance ? "Disputes (yours + compliance queue)" : "Disputes you are party to"}
        </h2>

        {loading ? (
          <div className="space-y-md">{Array.from({ length: 2 }).map((_, index) => <div key={index} className="panel-dark h-40 animate-pulse" />)}</div>
        ) : shown.length === 0 ? (
          <div className="panel-dark px-lg py-xxl text-center">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-surface-elevated-dark text-muted"><Icon name="shield" /></span>
            <h3 className="mt-md font-semibold text-on-dark">No disputes</h3>
            <p className="mx-auto mt-xs max-w-md text-sm text-muted">
              Open one from an escrow order — its card carries the order ID this form needs.
            </p>
            <Link href="/escrow" className="mt-md inline-flex text-sm font-semibold text-primary">Go to escrow</Link>
          </div>
        ) : (
          <div className="space-y-md">
            {shown.map((dispute) => (
              <DisputeCard
                key={dispute.id}
                dispute={dispute}
                userId={session.user.id}
                accessToken={session.accessToken}
                isCompliance={isCompliance}
                highlighted={dispute.orderId === linkedOrderId}
                busy={pending === dispute.id}
                expanded={expandedId === dispute.id}
                onToggle={() => setExpandedId(expandedId === dispute.id ? null : dispute.id)}
                onEvidence={addEvidence}
                onAutoResolve={autoResolve}
                onHumanResolve={humanResolve}
              />
            ))}
          </div>
        )}
      </section>

      <aside className="panel-light overflow-hidden text-ink xl:sticky xl:top-24">
        <div className="border-b border-hairline-light p-lg">
          <div className="flex items-center gap-sm">
            <span className="grid h-10 w-10 place-items-center rounded-lg bg-primary/20 text-primary-active"><Icon name="shield" /></span>
            <div><h2 className="font-semibold">Open a dispute</h2><p className="text-xs text-muted">Against an order you are party to</p></div>
          </div>
        </div>
        <form ref={formRef} onSubmit={openDispute} className="p-lg">
          <label className="block text-sm font-medium">Order ID
            <input required value={orderId} onChange={(event) => setOrderId(event.target.value)} placeholder="Order UUID" className="input mt-xs font-mono text-sm" />
            <span className="mt-xs block text-xs leading-5 text-muted">
              Copy it from the order&apos;s card in <Link href="/escrow" className="font-medium text-primary-active hover:underline">escrow</Link>.
              A dispute needs funds deposited and not yet released.
            </span>
          </label>
          <label className="mt-md block text-sm font-medium">Reason
            <textarea required value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Describe the problem (min 5 characters)" rows={4} className="input mt-xs text-sm" />
          </label>
          <button disabled={pending !== null} className="btn-primary mt-lg w-full">
            {pending === "open" ? "Opening…" : "Open dispute"}<Icon name="arrow-right" className="h-4 w-4" />
          </button>
          <p className="mt-md flex items-start gap-xs text-xs leading-5 text-muted">
            <Icon name="lock" className="mt-0.5 h-4 w-4 shrink-0" />
            Opening a dispute freezes the escrow custody, so neither side can move the funds while it is reviewed.
          </p>
          <p className="mt-sm flex items-start gap-xs text-xs leading-5 text-muted">
            <Icon name="shield" className="mt-0.5 h-4 w-4 shrink-0" />
            The AI recommendation is advisory only. High-value or low-confidence disputes require a human compliance decision.
          </p>
        </form>
      </aside>
    </div>
  );
}

function DisputeCard({
  dispute,
  userId,
  accessToken,
  isCompliance,
  highlighted,
  busy,
  expanded,
  onToggle,
  onEvidence,
  onAutoResolve,
  onHumanResolve,
}: {
  dispute: DisputeDTO;
  userId: string;
  accessToken: string;
  isCompliance: boolean;
  highlighted: boolean;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onEvidence: (id: string, supports: DisputeResolution, kind: EvidenceKind, weight: number) => void;
  onAutoResolve: (id: string) => void;
  onHumanResolve: (id: string, decision: DisputeResolution, reason: string) => void;
}) {
  const [decision, setDecision] = useState<DisputeResolution>(DisputeResolution.Refund);
  const [decisionReason, setDecisionReason] = useState("");
  const [evidenceKind, setEvidenceKind] = useState<EvidenceKind>(EvidenceKind.Tracking);
  const [evidenceSupports, setEvidenceSupports] = useState<DisputeResolution>(DisputeResolution.Release);
  const [evidenceWeight, setEvidenceWeight] = useState("0.8");
  const [now, setNow] = useState(() => Date.now());

  const resolved = dispute.resolution !== null;
  const role =
    userId === dispute.buyerId ? "buyer" : userId === dispute.sellerId ? "seller" : "reviewer";
  const isRespondent = role !== "reviewer" && dispute.openedBy !== userId;
  const windowHours = hoursUntil(dispute.evidenceWindowClosesAt, now);
  const windowOpen = !resolved && windowHours > 0;

  // The evidence window is a countdown the respondent is being judged against;
  // it has to keep ticking while they look at it.
  useEffect(() => {
    if (resolved) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [resolved]);

  return (
    <article className={`panel-dark overflow-hidden ${highlighted ? "ring-1 ring-primary" : ""}`}>
      <div className="p-md sm:p-lg">
        <div className="flex flex-col justify-between gap-md sm:flex-row sm:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-sm">
              <StatusPill status={dispute.status} />
              <span className="rounded-pill border border-hairline-dark px-sm py-xs text-xs font-medium capitalize text-muted-strong">
                You are the {role}
              </span>
              {isRespondent && !resolved ? (
                <span className="rounded-pill border border-primary/30 bg-primary/10 px-sm py-xs text-xs font-semibold text-primary">
                  Filed against you
                </span>
              ) : null}
              {dispute.advisory ? (
                <span className="rounded-pill border border-hairline-dark px-sm py-xs text-xs font-medium capitalize text-muted-strong">
                  AI: {dispute.advisory.recommendation.replace(/_/g, " ")} · {Math.round(dispute.advisory.confidence * 100)}%
                </span>
              ) : null}
              {dispute.autoResolvable && !resolved ? (
                <span className="rounded-pill border border-status-verified/30 bg-status-verified/10 px-sm py-xs text-xs font-semibold text-status-verified">Auto-resolvable</span>
              ) : null}
            </div>
            <p className="mt-md break-words font-mono text-lg font-semibold text-on-dark">
              {dispute.amount.amount} <span className="text-sm text-muted">{dispute.amount.currency} (minor)</span>
            </p>
            <p className="mt-sm max-w-2xl text-sm leading-6 text-muted-strong">{dispute.reason}</p>
            <p className="mt-md font-mono text-[11px] text-muted" title={dispute.id}>Dispute · {dispute.id.slice(0, 10)}…{dispute.id.slice(-8)}</p>
            <p className="mt-xxs flex flex-wrap items-center gap-x-sm gap-y-xxs text-[11px] text-muted">
              <span>Order</span>
              <code className="select-all break-all font-mono text-body">{dispute.orderId}</code>
              <Link href={`/escrow?order=${dispute.orderId}`} className="font-medium text-primary hover:underline">Open in escrow</Link>
            </p>
            {!resolved ? (
              <p className={`mt-sm flex items-center gap-xs text-xs ${windowOpen ? "text-muted" : "text-status-disputed"}`}>
                <Icon name="clock" className="h-3.5 w-3.5" />
                {windowOpen
                  ? `Evidence window closes in ${windowHours}h`
                  : "Evidence window closed — awaiting a compliance decision"}
              </p>
            ) : null}
          </div>
          <button type="button" aria-expanded={expanded} onClick={onToggle} className="btn-secondary-dark w-full shrink-0 sm:w-auto">
            {expanded ? "Hide" : "Manage"}<Icon name="chevron-down" className={`h-4 w-4 transition ${expanded ? "rotate-180" : ""}`} />
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="border-t border-hairline-dark bg-canvas-dark/40 p-md sm:p-lg">
          {dispute.advisory ? (
            <div className="mb-lg rounded-lg border border-hairline-dark bg-surface-card-dark p-md">
              <p className="eyebrow">AI advisory (read-only)</p>
              <p className="mt-xs text-sm text-body">{dispute.advisory.explanation}</p>
              <div className="mt-sm flex flex-wrap gap-xs">
                {dispute.advisory.signals.map((signal) => (
                  <span key={signal} className="rounded-pill bg-surface-elevated-dark px-sm py-xs font-mono text-[11px] text-muted-strong">{signal}</span>
                ))}
              </div>
            </div>
          ) : (
            <p className="mb-lg text-sm text-muted">No evidence submitted yet — submit evidence to generate an advisory.</p>
          )}

          <EvidenceList dispute={dispute} userId={userId} />

          {resolved && dispute.resolution ? (
            <div className="mt-lg rounded-lg border border-status-verified/30 bg-status-verified/10 p-md text-sm">
              <p className="font-semibold capitalize text-status-verified">
                Resolved: {dispute.resolution.outcome} ({dispute.resolution.decidedBy.replace(/_/g, " ")})
              </p>
              <p className="mt-xs text-muted-strong">{dispute.resolution.reason}</p>
              <SettlementLine settlement={dispute.resolution.settlement} outcome={dispute.resolution.outcome} />
            </div>
          ) : (
            <div className="mt-lg space-y-lg">
              <div>
                <p className="eyebrow">Submit evidence</p>
                {!windowOpen ? (
                  <p className="mt-xs text-sm text-status-disputed">
                    The evidence window has closed. Compliance decides on what was submitted.
                  </p>
                ) : (
                  <>
                    <p className="mt-xxs text-xs text-muted">
                      {isRespondent
                        ? "Answer this claim before the window closes — after that only what is on the record counts."
                        : "Add what supports your side. Every item is weighed by the advisory and visible to the other party."}
                    </p>
                    <div className="mt-sm grid gap-sm sm:grid-cols-2 xl:grid-cols-4">
                      <select value={evidenceKind} onChange={(e) => setEvidenceKind(e.target.value as EvidenceKind)} className="input-dark capitalize">
                        {EVIDENCE_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                      </select>
                      <select value={evidenceSupports} onChange={(e) => setEvidenceSupports(e.target.value as DisputeResolution)} className="input-dark capitalize">
                        <option value={DisputeResolution.Release}>supports release</option>
                        <option value={DisputeResolution.Refund}>supports refund</option>
                      </select>
                      <input value={evidenceWeight} onChange={(e) => setEvidenceWeight(e.target.value)} inputMode="decimal" placeholder="weight 0–1" className="input-dark font-mono" />
                      <button type="button" disabled={busy} onClick={() => onEvidence(dispute.id, evidenceSupports, evidenceKind, clampWeight(evidenceWeight))} className="btn-secondary-dark justify-center sm:col-span-2 xl:col-span-1">
                        {busy ? "…" : "Add evidence"}
                      </button>
                    </div>
                  </>
                )}
              </div>

              <div className="border-t border-hairline-dark pt-lg">
                <p className="eyebrow">Resolution</p>
                {dispute.autoResolvable ? (
                  <button type="button" disabled={busy} onClick={() => onAutoResolve(dispute.id)} className="btn-primary mt-sm">
                    {busy ? "Resolving…" : `Auto-resolve (${dispute.advisory?.recommendation})`}<Icon name="arrow-right" className="h-4 w-4" />
                  </button>
                ) : (
                  <p className="mt-sm text-sm text-muted">Exceeds auto-resolve thresholds — a human compliance decision is required.</p>
                )}

                {isCompliance ? (
                  <div className="mt-md grid gap-sm rounded-lg border border-hairline-dark bg-surface-card-dark p-md sm:grid-cols-[160px_1fr] xl:grid-cols-[160px_1fr_auto]">
                    <select value={decision} onChange={(e) => setDecision(e.target.value as DisputeResolution)} className="input-dark capitalize">
                      <option value={DisputeResolution.Refund}>refund buyer</option>
                      <option value={DisputeResolution.Release}>release to seller</option>
                    </select>
                    <input value={decisionReason} onChange={(e) => setDecisionReason(e.target.value)} placeholder="Decision reason (min 5 chars)" className="input-dark text-sm" />
                    <button type="button" disabled={busy || decisionReason.trim().length < 5} onClick={() => onHumanResolve(dispute.id, decision, decisionReason.trim())} className="btn-primary justify-center sm:col-span-2 xl:col-span-1">
                      {busy ? "…" : "Sign off"}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          )}

          <DisputeLog
            disputeId={dispute.id}
            accessToken={accessToken}
            // Refetch whenever the dispute moves, so the log never trails the
            // card it sits under.
            revision={dispute.updatedAt}
            now={now}
          />
        </div>
      ) : null}
    </article>
  );
}

/** Did the money actually move? Shown next to the decision, never instead of it. */
function SettlementLine({
  settlement,
  outcome,
}: {
  settlement: DisputeSettlementOutcomeDTO;
  outcome: DisputeResolution;
}) {
  const style =
    settlement.status === DisputeSettlementStatus.Executed
      ? "text-status-verified"
      : settlement.status === DisputeSettlementStatus.Failed
        ? "text-status-rejected"
        : "text-muted-strong";
  const label =
    settlement.status === DisputeSettlementStatus.Executed
      ? `Funds ${outcome === DisputeResolution.Refund ? "refunded to the buyer" : "released to the seller"}`
      : settlement.status === DisputeSettlementStatus.Failed
        ? "Decision recorded, but the transfer failed — compliance will retry"
        : settlement.status === DisputeSettlementStatus.NotApplicable
          ? "No custody to move for this order"
          : "Transfer pending";
  return (
    <p className={`mt-sm flex items-start gap-xs border-t border-status-verified/20 pt-sm text-xs ${style}`}>
      <Icon name={settlement.status === DisputeSettlementStatus.Executed ? "check" : "clock"} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        {label}
        {settlement.detail ? <span className="block text-muted">{settlement.detail}</span> : null}
      </span>
    </p>
  );
}

function EvidenceList({ dispute, userId }: { dispute: DisputeDTO; userId: string }) {
  if (dispute.evidence.length === 0) return null;
  return (
    <div className="mb-lg">
      <p className="eyebrow">Evidence on the record ({dispute.evidence.length})</p>
      <ul className="mt-sm space-y-xs">
        {dispute.evidence.map((item) => {
          const side =
            item.submittedBy === dispute.buyerId
              ? "Buyer"
              : item.submittedBy === dispute.sellerId
                ? "Seller"
                : "Compliance";
          return (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-sm rounded-md border border-hairline-dark bg-surface-card-dark px-md py-sm text-xs">
              <span className="flex flex-wrap items-center gap-sm">
                <span className="rounded-pill bg-surface-elevated-dark px-sm py-xxs font-medium capitalize text-muted-strong">{item.kind}</span>
                <span className="text-body">
                  {side}
                  {item.submittedBy === userId ? " (you)" : ""}
                </span>
                <span className="capitalize text-muted">supports {item.supports}</span>
              </span>
              <span className="font-mono text-[11px] text-muted">weight {item.weight.toFixed(2)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The dispute's append-only history.
 *
 * Projected from the audit log the backend already writes, so what the parties
 * read and what compliance can defend are the same record — not a summary
 * assembled in the browser from whatever happens to be on screen.
 */
function DisputeLog({
  disputeId,
  accessToken,
  revision,
  now,
}: {
  disputeId: string;
  accessToken: string;
  revision: string;
  now: number;
}) {
  const [entries, setEntries] = useState<DisputeLogEntryDTO[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void api
      .getDisputeLog(accessToken, disputeId)
      .then((response) => {
        if (!cancelled) setEntries(response.entries);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, disputeId, revision]);

  return (
    <div className="mt-lg border-t border-hairline-dark pt-lg">
      <p className="eyebrow">Dispute log</p>
      {failed ? (
        <p className="mt-sm text-sm text-muted">The dispute log could not be loaded.</p>
      ) : entries === null ? (
        <div className="mt-sm space-y-xs">{Array.from({ length: 3 }).map((_, index) => <div key={index} className="h-8 animate-pulse rounded-md bg-surface-card-dark" />)}</div>
      ) : entries.length === 0 ? (
        <p className="mt-sm text-sm text-muted">Nothing recorded yet.</p>
      ) : (
        <ol className="mt-sm space-y-0">
          {entries.map((entry, index) => (
            <li key={entry.id} className="flex gap-sm">
              <div className="flex flex-col items-center">
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${ACTOR_DOT[entry.actor] ?? "bg-muted"}`} />
                {index < entries.length - 1 ? <span className="w-px flex-1 bg-hairline-dark" /> : null}
              </div>
              <div className="min-w-0 pb-md">
                <p className="text-sm leading-5 text-body">{entry.summary}</p>
                <p className="mt-xxs text-[11px] text-muted">
                  <span className="capitalize">{ACTOR_LABEL[entry.actor] ?? entry.actor}</span>
                  {" · "}
                  <time dateTime={entry.at} title={new Date(entry.at).toLocaleString()}>{timeAgo(entry.at, now)}</time>
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const ACTOR_DOT: Record<string, string> = {
  buyer: "bg-info",
  seller: "bg-status-locked",
  compliance: "bg-primary",
  ai: "bg-status-review",
  system: "bg-muted",
};

const ACTOR_LABEL: Record<string, string> = {
  buyer: "Buyer",
  seller: "Seller",
  compliance: "Compliance",
  ai: "AI advisory",
  system: "Platform",
};

function clampWeight(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0.5;
  return Math.min(1, Math.max(0, parsed));
}

function mergeById(a: DisputeDTO[], b: DisputeDTO[]): DisputeDTO[] {
  const map = new Map<string, DisputeDTO>();
  for (const dispute of [...a, ...b]) map.set(dispute.id, dispute);
  return [...map.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
