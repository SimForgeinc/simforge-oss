#!/usr/bin/env python3
"""Cached escalation-only multimodel review for showcase scenarios."""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
FOOTAGE = ROOT / "tools" / "research" / "footage"
sys.path.insert(0, str(FOOTAGE))
import futil

SCHEMA = "simforge.showcase-judge-ensemble/v1"
PRIMARY_MODEL = "openrouter/google/gemini-3.7-flash"
ESCALATION_MODELS = (
    PRIMARY_MODEL,
    "openai-codex/gpt-5.6-sol",
    "openrouter/anthropic/claude-sonnet-4.6",
)
CONFIDENCE_MIN = 0.70
QUESTIONS = {
    "physical-plausibility": "Could the recorded actor motion and interaction physically happen in real traffic?",
    "mechanism-match": "Does the evidence implement the brief's exact causal mechanism rather than an incidental near miss?",
    "criticality-visible": "Is the designated hazard's critical interaction visibly apparent in the rendered evidence?",
    "label-answer-consistency": "Are the proposed scenario labels and deterministic evidence mutually consistent?",
}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def select_frames(render_dir, maximum=4):
    paths = sorted(pathlib.Path(render_dir).glob("frames/*.png"))
    if not paths:
        paths = sorted(pathlib.Path(render_dir).glob("*.png"))
    if len(paths) <= maximum:
        return paths
    return [paths[round(index * (len(paths) - 1) / (maximum - 1))] for index in range(maximum)]


def content_hash(brief, instance, provenance, frames):
    digest = hashlib.sha256()
    digest.update(canonical({"schema": SCHEMA, "questions": QUESTIONS, "brief": brief,
                             "instance": instance, "provenance": provenance}).encode())
    for frame in frames:
        digest.update(frame.name.encode())
        digest.update(frame.read_bytes())
    return digest.hexdigest()


def _cache_path(cache_dir, digest, model, question):
    key = hashlib.sha256(f"{digest}\0{model}\0{question}".encode()).hexdigest()
    return pathlib.Path(cache_dir) / f"{key}.json"


def _parse_answer(parsed):
    answer = str(parsed.get("answer", "")).strip().lower()
    rationale = " ".join(str(parsed.get("rationale", "")).split())
    confidence = float(parsed.get("confidence", 0))
    if answer not in ("yes", "no"):
        raise ValueError(f"answer must be yes/no, got {answer!r}")
    if not rationale:
        raise ValueError("rationale is required")
    if not 0 <= confidence <= 1:
        raise ValueError("confidence must be in [0,1]")
    return answer, rationale[:500], confidence


def ask(model, question, prompt_context, frames, digest, cache_dir):
    cache = _cache_path(cache_dir, digest, model, question)
    if cache.is_file():
        record = json.loads(cache.read_text())
        record["cacheHit"] = True
        return record
    futil.assert_vision_session(model)
    prompt = ("You are one member of an autonomous-driving training-data admission review. "
              "Answer exactly one decomposed binary question. Use the render and ground-truth evidence; "
              "do not substitute a general quality score. Return strict JSON only: "
              '{"answer":"yes|no","confidence":0.0,"rationale":"one sentence"}.\n\n'
              f"QUESTION: {QUESTIONS[question]}\n\nEVIDENCE:\n{canonical(prompt_context)}")
    content = [{"type": "input_text", "text": prompt}]
    content.extend({"type": "input_image", "image_url": futil.png_data_url(str(frame))}
                   for frame in frames)
    body = {"model": model, "max_output_tokens": 1200,
            "input": [{"role": "user", "content": content}]}
    response, raw, wall = futil.responses_call(body, timeout=420)
    text = futil.output_text(response)
    answer, rationale, confidence = _parse_answer(futil.parse_json_block(text))
    usage = response.get("usage") or {}
    record = {"model": model, "family": model_family(model), "question": question,
              "answer": answer, "confidence": confidence, "rationale": rationale,
              "cacheHit": False, "latencyS": round(wall, 3),
              "tokens": {"in": usage.get("input_tokens") or usage.get("prompt_tokens") or 0,
                         "out": usage.get("output_tokens") or usage.get("completion_tokens") or 0},
              "responseSha256": hashlib.sha256(raw.encode()).hexdigest()}
    cache.parent.mkdir(parents=True, exist_ok=True)
    temporary = cache.with_suffix(".tmp")
    temporary.write_text(json.dumps(record, sort_keys=True, indent=2) + "\n")
    os.replace(temporary, cache)
    return record


def model_family(model):
    lowered = model.lower()
    if "gemini" in lowered or "/google/" in lowered:
        return "gemini"
    if "gpt" in lowered or "openai" in lowered:
        return "gpt"
    if "claude" in lowered or "anthropic" in lowered:
        return "claude"
    return lowered.split("/", 1)[0]


def majority(records):
    by_family = {}
    for record in records:
        by_family[record["family"]] = record["answer"]
    yes = sum(answer == "yes" for answer in by_family.values())
    no = sum(answer == "no" for answer in by_family.values())
    return "yes" if yes > no else "no"


def review(brief, instance, provenance, render_dir, cache_dir, primary_model=PRIMARY_MODEL,
           escalation_models=ESCALATION_MODELS, admission_boundary=False):
    frames = select_frames(render_dir)
    if not frames:
        raise RuntimeError(f"no PNG review frames in {render_dir}")
    digest = content_hash(brief, instance, provenance, frames)
    context = {"brief": brief, "provenance": provenance,
               "scenario": {"archetype": instance.get("manifest", {}).get("archetype"),
                            "actors": [{"id": actor.get("id"), "kind": actor.get("kind"),
                                        "tags": actor.get("tags", [])}
                                       for actor in instance.get("input", {}).get("actors", [])]}}
    records = [ask(primary_model, question, context, frames, digest, cache_dir)
               for question in QUESTIONS]
    escalation_reasons = []
    if any(record["answer"] == "no" for record in records):
        escalation_reasons.append("primary-no")
    if any(record["confidence"] < CONFIDENCE_MIN for record in records):
        escalation_reasons.append("primary-low-confidence")
    if admission_boundary:
        escalation_reasons.append("admission-boundary")
    escalated = bool(escalation_reasons)
    if escalated:
        existing = {(record["model"], record["question"]) for record in records}
        for model in escalation_models:
            for question in QUESTIONS:
                if (model, question) not in existing:
                    records.append(ask(model, question, context, frames, digest, cache_dir))
    answers = {}
    for question in QUESTIONS:
        rows = [record for record in records if record["question"] == question]
        answers[question] = majority(rows) if escalated else rows[0]["answer"]
    return {"schema": SCHEMA, "contentHash": digest, "primaryModel": primary_model,
            "models": list(dict.fromkeys(record["model"] for record in records)),
            "escalated": escalated, "escalationReasons": escalation_reasons,
            "confidenceBoundary": CONFIDENCE_MIN, "answers": answers,
            "advisoryPass": all(answer == "yes" for answer in answers.values()),
            "records": records, "frames": [str(frame) for frame in frames],
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
