"""Tests for the advisory risk engines and endpoints."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.engines import aggregate_kyc_risk, recommend_dispute
from app.main import app
from app.schemas import (
    DisputeEvidence,
    DisputeRecommendRequest,
    KycDecision,
    KycScoreRequest,
    KycSignal,
    Recommendation,
)

client = TestClient(app)


def test_health() -> None:
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["service"] == "stellartrust-ai"


def test_sanctions_hit_forces_reject() -> None:
    out = aggregate_kyc_risk(
        KycScoreRequest(subject_ref="s1", signals=[], sanctions_hit=True)
    )
    assert out.decision == KycDecision.REJECT
    assert out.risk_score == 1.0


def test_low_risk_approves() -> None:
    out = aggregate_kyc_risk(
        KycScoreRequest(
            subject_ref="s2",
            signals=[KycSignal(name="doc_ocr", value=0.1), KycSignal(name="face", value=0.1)],
        )
    )
    assert out.decision == KycDecision.APPROVE


def test_dispute_recommend_release() -> None:
    out = recommend_dispute(
        DisputeRecommendRequest(
            dispute_ref="d1",
            amount_minor=10000,
            currency="USD",
            evidence=[
                DisputeEvidence(kind="tracking", supports=Recommendation.RELEASE, weight=0.9),
                DisputeEvidence(kind="courier", supports=Recommendation.RELEASE, weight=0.8),
            ],
        )
    )
    assert out.recommendation == Recommendation.RELEASE
    assert out.explanation


def test_no_evidence_requires_human() -> None:
    out = recommend_dispute(
        DisputeRecommendRequest(dispute_ref="d2", amount_minor=0, currency="USD", evidence=[])
    )
    assert out.recommendation == Recommendation.MANUAL_REVIEW
    assert out.requires_human_review is True


def test_endpoint_dispute_recommend() -> None:
    res = client.post(
        "/dispute-recommend",
        json={
            "dispute_ref": "d3",
            "amount_minor": 5000,
            "currency": "USD",
            "evidence": [{"kind": "invoice", "supports": "refund", "weight": 0.95}],
        },
    )
    assert res.status_code == 200
    assert res.json()["recommendation"] == "refund"
