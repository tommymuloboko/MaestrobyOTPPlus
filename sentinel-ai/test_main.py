from fastapi.testclient import TestClient

from main import app, score_event

client = TestClient(app)


def test_health():
    assert client.get("/health").json() == {"status": "ok"}


def test_severity_sets_the_base():
    assert score_event("UNKNOWN_RULE", "MEDIUM", 0).score == 40


def test_prior_events_raise_the_score_but_are_capped():
    assert score_event("UNKNOWN_RULE", "LOW", 1).score == 25
    assert score_event("UNKNOWN_RULE", "LOW", 50).score == 30


def test_score_never_exceeds_100():
    assert score_event("CONTAINER_DIVERSION", "CRITICAL", 9).score == 100


def test_http_contract_matches_what_the_api_expects():
    r = client.post("/score", json={"rule": "TANK_VARIANCE", "severity": "CRITICAL", "priorEvents": 0})
    assert r.status_code == 200
    assert r.json()["score"] == 95
