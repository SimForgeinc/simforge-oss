"""Pooled live TypeSafe request and finite-choice validation; never actuation."""
from datetime import datetime, timezone
import json
import math
import time
from typesafe_sdk import TypeSafeClient, RetryPolicy
from . import policy as C


def pooled_client():
    return TypeSafeClient(model=C.MODEL, retry=RetryPolicy(max_retries=0), timeout=C.HTTP_TIMEOUT_S)


def valid_choice(answer, keys):
    if not isinstance(answer, dict) or answer.get("type") != "choice":
        return False
    probabilities = answer.get("probabilities", {})
    confidence = answer.get("confidence")
    if set(probabilities) != set(keys) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
        return False
    if any(not isinstance(p, (int, float)) or not math.isfinite(p) or not 0 <= p <= 1 for p in probabilities.values()):
        return False
    choice = answer.get("choice")
    return (choice in probabilities and abs(sum(probabilities.values()) - 1) <= C.PROBABILITY_SUM_TOLERANCE
            and probabilities[choice] + C.NUMERIC_EPS >= max(probabilities.values()))


def ask(client, state, persona):
    start = time.perf_counter()
    requested = datetime.now(timezone.utc).isoformat()
    raw_text, raw, error, received = None, {}, None, None
    try:
        result = client.system_one(state=state, questions=C.questions_for(state["candidates"], persona.question_set), model=C.MODEL)
        raw_text = result.raw_http_response.content.decode("utf-8")
        received = datetime.now(timezone.utc).isoformat()
        raw = json.loads(raw_text)
    except Exception as exc:
        error = type(exc).__name__  # Never log credentials, headers or exception text.
    latency = round((time.perf_counter() - start) * 1000, 3)
    answer = raw.get("answers", {}).get("maneuver", {})
    choice = answer.get("choice")
    probabilities = answer.get("probabilities", {})
    confidence = answer.get("confidence")
    offered = [c["id"] for c in state["candidates"]]
    reason = error
    if reason is None and not valid_choice(answer, offered):
        reason = "invalid_or_inconsistent_choice"
    if reason is None and (confidence < C.MIN_CONFIDENCE or probabilities[choice] < 1 / len(offered) + C.PROBABILITY_ABOVE_UNIFORM):
        reason = "low_confidence"
    if latency > C.DEADLINE_MS:
        reason = "deadline_miss"
    return {"jev_choice": choice, "probabilities": probabilities, "confidence": confidence,
            "api_latency_ms": latency, "fallback_reason": reason, "raw_response": raw,
            "raw_response_text": raw_text, "requested_at_utc": requested, "received_at_utc": received}
