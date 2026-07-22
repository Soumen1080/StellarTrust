"use client";

import {
  DisputeResolution,
  EvidenceKind,
  type AuthSessionResponse,
  type DisputeDTO,
} from "@stellartrust/shared";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { loadSession } from "@/lib/wallet-auth";

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The dispute operation failed";
}

const EVIDENCE_KINDS = Object.values(EvidenceKind);

export function DisputeConsole() {
  const [session, setSession] = useState<AuthSessionResponse | null>(null);
  const [disputes, setDisputes] = useState<DisputeDTO[]>([]);
  const [queue, setQueue] = useState<DisputeDTO[]>([]);
  const [isCompliance, setIsCompliance] = useState(false);
  const [orderId, setOrderId] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const refresh = useCallback(async (active: AuthSessionResponse) => {
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
    const active = loadSession();
    setSession(active);
    if (!active) {
      setLoading(false);
      return;
    }
    void refresh(active)
      .catch((err: unknown) => setError(message(err)))
      .finally(() => setLoading(false));
  }, [refresh]);

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
        <div className="p-xl sm:p-xxl">
          <span className="grid h-12 w-12 place-items-center rounded-lg bg-primary/10 text-primary">
            <Icon name="shield" className="h-6 w-6" />
          </span>
          <h2 className="mt-lg text-2xl font-bold text-on-dark">Connect your wallet to manage disputes</h2>
          <p className="mt-sm max-w-xl leading-7 text-muted-strong">
            Open a dispute on an order, submit evidence within the review window, and see an explainable AI recommendation. High-value or low-confidence disputes are escalated to a human decision.
          </p>
          <Link href="/" className="btn-primary mt-lg">Connect wallet <Icon name="arrow-right" className="h-4 w-4" /></Link>
        </div>
      </section>
    );
  }

  const shown = isCompliance ? mergeById(disputes, queue) : disputes;

  return (
    <div className="grid items-start gap-lg xl:grid-cols-[minmax(0,1fr)_360px]">
      <section>
        {error ? (
          <div role="alert" className="mb-lg flex items-start justify-between gap-md rounded-lg border border-status-rejected/30 bg-status-rejected/10 p-md text-sm text-status-rejected">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss error"><Icon name="x" className="h-4 w-4" /></button>
          </div>
        ) : null}

        <h2 className="mb-md text-sm font-semibold text-on-dark">
          {isCompliance ? "Disputes (yours + compliance queue)" : "Your disputes"}
        </h2>

        {loading ? (
          <div className="space-y-md">{Array.from({ length: 2 }).map((_, index) => <div key={index} className="panel-dark h-40 animate-pulse" />)}</div>
        ) : shown.length === 0 ? (
          <div className="panel-dark px-lg py-xxl text-center">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-surface-elevated-dark text-muted"><Icon name="shield" /></span>
            <h3 className="mt-md font-semibold text-on-dark">No disputes</h3>
            <p className="mx-auto mt-xs max-w-md text-sm text-muted">Open a dispute against an order using the form.</p>
          </div>
        ) : (
          <div className="space-y-md">
            {shown.map((dispute) => (
              <DisputeCard
                key={dispute.id}
                dispute={dispute}
                isCompliance={isCompliance}
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
        <form onSubmit={openDispute} className="p-lg">
          <label className="block text-sm font-medium">Order ID
            <input required value={orderId} onChange={(event) => setOrderId(event.target.value)} placeholder="Order UUID" className="input mt-xs font-mono text-sm" />
          </label>
          <label className="mt-md block text-sm font-medium">Reason
            <textarea required value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Describe the problem (min 5 characters)" rows={4} className="input mt-xs text-sm" />
          </label>
          <button disabled={pending !== null} className="btn-primary mt-lg w-full">
            {pending === "open" ? "Opening…" : "Open dispute"}<Icon name="arrow-right" className="h-4 w-4" />
          </button>
          <p className="mt-md flex items-start gap-xs text-xs leading-5 text-muted">
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
  isCompliance,
  busy,
  expanded,
  onToggle,
  onEvidence,
  onAutoResolve,
  onHumanResolve,
}: {
  dispute: DisputeDTO;
  isCompliance: boolean;
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
  const resolved = dispute.resolution !== null;

  return (
    <article className="panel-dark overflow-hidden">
      <div className="p-lg">
        <div className="flex flex-col justify-between gap-md sm:flex-row sm:items-start">
          <div>
            <div className="flex flex-wrap items-center gap-sm">
              <StatusPill status={dispute.status} />
              {dispute.advisory ? (
                <span className="rounded-pill border border-hairline-dark px-sm py-xs text-xs font-medium capitalize text-muted-strong">
                  AI: {dispute.advisory.recommendation.replace(/_/g, " ")} · {Math.round(dispute.advisory.confidence * 100)}%
                </span>
              ) : null}
              {dispute.autoResolvable && !resolved ? (
                <span className="rounded-pill border border-status-verified/30 bg-status-verified/10 px-sm py-xs text-xs font-semibold text-status-verified">Auto-resolvable</span>
              ) : null}
            </div>
            <p className="mt-md font-mono text-lg font-semibold text-on-dark">
              {dispute.amount.amount} <span className="text-sm text-muted">{dispute.amount.currency} (minor)</span>
            </p>
            <p className="mt-xs font-mono text-[11px] text-muted" title={dispute.id}>Dispute · {dispute.id.slice(0, 10)}…{dispute.id.slice(-8)}</p>
            <p className="mt-xs font-mono text-[11px] text-muted" title={dispute.orderId}>Order · {dispute.orderId.slice(0, 10)}…</p>
          </div>
          <button type="button" aria-expanded={expanded} onClick={onToggle} className="btn-secondary-dark">
            {expanded ? "Hide" : "Manage"}<Icon name="chevron-down" className={`h-4 w-4 transition ${expanded ? "rotate-180" : ""}`} />
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="border-t border-hairline-dark bg-canvas-dark/40 p-lg">
          {dispute.advisory ? (
            <div className="mb-lg rounded-lg border border-hairline-dark bg-surface-card-dark p-md">
              <p className="eyebrow">AI advisory (read-only)</p>
              <p className="mt-xs text-sm text-body">{dispute.advisory.explanation}</p>
              <div className="mt-sm flex flex-wrap gap-xs">
                {dispute.advisory.signals.map((signal) => (
                  <span key={signal} className="rounded-pill bg-surface-elevated-dark px-sm py-xs font-mono text-[10px] text-muted-strong">{signal}</span>
                ))}
              </div>
            </div>
          ) : (
            <p className="mb-lg text-sm text-muted">No evidence submitted yet — submit evidence to generate an advisory.</p>
          )}

          {resolved ? (
            <div className="rounded-lg border border-status-verified/30 bg-status-verified/10 p-md text-sm">
              <p className="font-semibold capitalize text-status-verified">
                Resolved: {dispute.resolution?.outcome} ({dispute.resolution?.decidedBy.replace(/_/g, " ")})
              </p>
              <p className="mt-xs text-muted-strong">{dispute.resolution?.reason}</p>
            </div>
          ) : (
            <div className="space-y-lg">
              <div>
                <p className="eyebrow">Submit evidence</p>
                <div className="mt-sm grid gap-sm sm:grid-cols-4">
                  <select value={evidenceKind} onChange={(e) => setEvidenceKind(e.target.value as EvidenceKind)} className="input-dark capitalize">
                    {EVIDENCE_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                  </select>
                  <select value={evidenceSupports} onChange={(e) => setEvidenceSupports(e.target.value as DisputeResolution)} className="input-dark capitalize">
                    <option value={DisputeResolution.Release}>supports release</option>
                    <option value={DisputeResolution.Refund}>supports refund</option>
                  </select>
                  <input value={evidenceWeight} onChange={(e) => setEvidenceWeight(e.target.value)} inputMode="decimal" placeholder="weight 0–1" className="input-dark font-mono" />
                  <button type="button" disabled={busy} onClick={() => onEvidence(dispute.id, evidenceSupports, evidenceKind, clampWeight(evidenceWeight))} className="btn-secondary-dark justify-center">
                    {busy ? "…" : "Add evidence"}
                  </button>
                </div>
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
                  <div className="mt-md grid gap-sm rounded-lg border border-hairline-dark bg-surface-card-dark p-md sm:grid-cols-[160px_1fr_auto]">
                    <select value={decision} onChange={(e) => setDecision(e.target.value as DisputeResolution)} className="input-dark capitalize">
                      <option value={DisputeResolution.Refund}>refund buyer</option>
                      <option value={DisputeResolution.Release}>release to seller</option>
                    </select>
                    <input value={decisionReason} onChange={(e) => setDecisionReason(e.target.value)} placeholder="Decision reason (min 5 chars)" className="input-dark text-sm" />
                    <button type="button" disabled={busy || decisionReason.trim().length < 5} onClick={() => onHumanResolve(dispute.id, decision, decisionReason.trim())} className="btn-primary justify-center">
                      {busy ? "…" : "Sign off"}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </article>
  );
}

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
