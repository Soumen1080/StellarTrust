"""Pydantic schemas — validate all input at the boundary (Rules.md §2)."""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class Recommendation(str, Enum):
    """Advisory recommendations. Mirrors @stellartrust/shared AiRecommendation."""

    RELEASE = "release"
    REFUND = "refund"
    MANUAL_REVIEW = "manual_review"


class KycDecision(str, Enum):
    APPROVE = "approve"
    REVIEW = "review"
    REJECT = "reject"


# ── KYC risk aggregation ─────────────────────────────────────────────────────
class KycSignal(BaseModel):
    """A single provider signal. Minimize PII (Rules.md §6): send scores, not raw docs."""

    name: str
    # 0..1 where higher = higher risk.
    value: float = Field(ge=0.0, le=1.0)


class KycScoreRequest(BaseModel):
    subject_ref: str = Field(min_length=1, description="Opaque subject reference, not PII")
    signals: list[KycSignal] = Field(default_factory=list)
    sanctions_hit: bool = False
    new_party: bool = False


class KycScoreResponse(BaseModel):
    subject_ref: str
    risk_score: float = Field(ge=0.0, le=1.0)
    decision: KycDecision
    confidence: float = Field(ge=0.0, le=1.0)
    explanation: str
    signals_used: list[str]


# ── Dispute recommendation ────────────────────────────────────────────────────
class DisputeEvidence(BaseModel):
    kind: str  # invoice | tracking | otp | courier | image
    # Advisory strength this evidence lends to release (buyer received) vs refund.
    supports: Recommendation
    weight: float = Field(ge=0.0, le=1.0)


class DisputeRecommendRequest(BaseModel):
    dispute_ref: str = Field(min_length=1)
    amount_minor: int = Field(ge=0, description="Order amount in minor units")
    currency: str
    evidence: list[DisputeEvidence] = Field(default_factory=list)
    buyer_reputation: float = Field(default=0.5, ge=0.0, le=1.0)
    seller_reputation: float = Field(default=0.5, ge=0.0, le=1.0)


class DisputeRecommendResponse(BaseModel):
    dispute_ref: str
    recommendation: Recommendation
    confidence: float = Field(ge=0.0, le=1.0)
    explanation: str
    signals: list[str]
    # Advisory only. The backend applies the human-gate thresholds (Rules.md #3).
    requires_human_review: bool
