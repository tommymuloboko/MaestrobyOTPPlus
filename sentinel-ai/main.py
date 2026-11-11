"""Maestro Sentinel scoring service.

Contract with the API (RiskScorer): POST /score {rule, severity, priorEvents} -> {score: 0-100, ...}.
The API falls back to its own heuristic when this service is down, so keep responses fast and stateless.

This is a rules-and-weights scorer, not a trained model. Replace `score_event` with a model once there is
labelled case data; the request/response contract stays the same.
"""
from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(title="Maestro Sentinel AI", version="0.1.0")

SEVERITY_BASE = {"CRITICAL": 90, "HIGH": 70, "MEDIUM": 40, "LOW": 20}

# Extra weight for rules that are strong indicators of fuel diversion or collusion.
RULE_WEIGHT = {
    "CONTAINER_DIVERSION": 10,
    "COLLUSION_PATTERN": 8,
    "TANK_VARIANCE": 5,
    "DELIVERY_SHORTAGE": 4,
    "CONTROLLER_OFFLINE": 3,
}


class ScoreRequest(BaseModel):
    rule: str
    severity: str
    priorEvents: int = Field(default=0, ge=0)


class ScoreResponse(BaseModel):
    score: int
    model: str
    factors: dict[str, int]


def score_event(rule: str, severity: str, prior_events: int) -> ScoreResponse:
    base = SEVERITY_BASE.get(severity.upper(), 20)
    rule_bonus = RULE_WEIGHT.get(rule.upper(), 0)
    history = min(10, prior_events * 5)
    total = min(100, base + rule_bonus + history)
    return ScoreResponse(
        score=total,
        model="rules-v1",
        factors={"severity": base, "rule": rule_bonus, "history": history},
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/score", response_model=ScoreResponse)
def score(req: ScoreRequest) -> ScoreResponse:
    return score_event(req.rule, req.severity, req.priorEvents)
