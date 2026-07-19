"""Advisory scoring engines. Pure functions — no I/O, no fund/ledger access."""

from __future__ import annotations

from app.schemas import (
    DisputeRecommendRequest,
    DisputeRecommendResponse,
    KycDecision,
    KycScoreRequest,
    KycScoreResponse,
    Recommendation,
)


def aggregate_kyc_risk(req: KycScoreRequest) -> KycScoreResponse:
    """Aggregate provider signals into a risk score + advisory decision.

    Placeholder heuristic for Phase 0 (real models arrive in Phase 1). It is
    explainable and reproducible for a given input (Rules.md §6). It must not use
    protected attributes as features.
    """
    signal_values = [s.value for s in req.signals]
    base = sum(signal_values) / len(signal_values) if signal_values else 0.5

    # Hard risk escalators route to review/reject regardless of the base score.
    if req.sanctions_hit:
        return KycScoreResponse(
            subject_ref=req.subject_ref,
            risk_score=1.0,
            decision=KycDecision.REJECT,
            confidence=0.99,
            explanation="Sanctions/AML hit — automatic reject, escalate to compliance.",
            signals_used=[s.name for s in req.signals] + ["sanctions_hit"],
        )

    risk = min(1.0, base + (0.15 if req.new_party else 0.0))

    if risk < 0.35:
        decision = KycDecision.APPROVE
    elif risk < 0.7:
        decision = KycDecision.REVIEW
    else:
        decision = KycDecision.REJECT

    return KycScoreResponse(
        subject_ref=req.subject_ref,
        risk_score=round(risk, 4),
        decision=decision,
        confidence=round(1.0 - abs(0.5 - risk), 4),
        explanation=(
            f"Aggregated {len(signal_values)} provider signal(s) into risk={risk:.2f}; "
            f"advisory decision={decision.value}."
        ),
        signals_used=[s.name for s in req.signals] + (["new_party"] if req.new_party else []),
    )


def recommend_dispute(req: DisputeRecommendRequest) -> DisputeRecommendResponse:
    """Produce an advisory dispute recommendation with confidence + explanation.

    The backend — not this service — enforces the human-gate thresholds and moves
    money. This function is read-only advisory support (Rules.md §6).
    """
    if not req.evidence:
        return DisputeRecommendResponse(
            dispute_ref=req.dispute_ref,
            recommendation=Recommendation.MANUAL_REVIEW,
            confidence=0.0,
            explanation="No evidence submitted; cannot form an advisory view.",
            signals=[],
            requires_human_review=True,
        )

    release_weight = sum(e.weight for e in req.evidence if e.supports == Recommendation.RELEASE)
    refund_weight = sum(e.weight for e in req.evidence if e.supports == Recommendation.REFUND)

    # Reputation nudges (bounded, explainable).
    release_weight += req.seller_reputation * 0.25
    refund_weight += (1.0 - req.buyer_reputation) * 0.25

    total = release_weight + refund_weight
    if total == 0:
        return DisputeRecommendResponse(
            dispute_ref=req.dispute_ref,
            recommendation=Recommendation.MANUAL_REVIEW,
            confidence=0.0,
            explanation="No evidence submitted; cannot form an advisory view.",
            signals=[],
            requires_human_review=True,
        )

    if release_weight >= refund_weight:
        rec = Recommendation.RELEASE
        confidence = release_weight / total
    else:
        rec = Recommendation.REFUND
        confidence = refund_weight / total

    conflicting = release_weight > 0 and refund_weight > 0
    signals = [f"{e.kind}->{e.supports.value}({e.weight:.2f})" for e in req.evidence]
    signals.append(f"buyer_rep={req.buyer_reputation:.2f}")
    signals.append(f"seller_rep={req.seller_reputation:.2f}")

    return DisputeRecommendResponse(
        dispute_ref=req.dispute_ref,
        recommendation=rec,
        confidence=round(confidence, 4),
        explanation=(
            f"Weighted evidence favours {rec.value} "
            f"(release={release_weight:.2f} vs refund={refund_weight:.2f})."
            + (" Conflicting evidence present." if conflicting else "")
        ),
        signals=signals,
        # Advisory flag; final gate is applied by the backend using its thresholds.
        requires_human_review=conflicting or confidence < 0.9,
    )
