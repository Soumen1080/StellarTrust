"""Advisory risk endpoints. Read-only w.r.t. funds and the ledger (Rules.md §6)."""

from __future__ import annotations

from fastapi import APIRouter

from app.engines import aggregate_kyc_risk, recommend_dispute
from app.schemas import (
    DisputeRecommendRequest,
    DisputeRecommendResponse,
    KycScoreRequest,
    KycScoreResponse,
)

router = APIRouter(tags=["risk"])


@router.post("/kyc-score", response_model=KycScoreResponse)
def kyc_score(req: KycScoreRequest) -> KycScoreResponse:
    """Aggregate KYC provider signals into an advisory risk score + decision."""
    return aggregate_kyc_risk(req)


@router.post("/dispute-recommend", response_model=DisputeRecommendResponse)
def dispute_recommend(req: DisputeRecommendRequest) -> DisputeRecommendResponse:
    """Produce an advisory dispute recommendation. The backend applies the human gate."""
    return recommend_dispute(req)
