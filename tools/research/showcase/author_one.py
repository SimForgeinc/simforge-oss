#!/usr/bin/env python3
"""Author one free-text brief into the showcase ``20-author`` stage.

Compiler mode reuses the frozen W7 author's decision/compiler/validator functions.
Vista2 mode runs one visual closed-loop episode, seeded from a caller-provided GUIDE.md.
Both modes always leave a template and machine-readable transcript for inspection.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sys
import time


ROOT = Path(__file__).resolve().parents[3]
MODEL = "gpt-5.6-luna"
EFFORT = "medium"
BASE_URL = "http://127.0.0.1:4141/v1"


def _slug(text: str) -> str:
    compact = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:44]
    digest = hashlib.sha256(text.encode()).hexdigest()[:10]
    return f"showcase-{compact or 'brief'}-{digest}"


def _category(brief: str) -> str:
    text = brief.lower()
    groups = (
        ("workzone", ("work zone", "roadwork", "lane closure")),
        ("occlusion", ("occlud", "hidden", "blocked view")),
        ("vru", ("pedestrian", "cyclist", "bicycle", "child", "scooter")),
        ("junction", ("junction", "intersection", "cross traffic", "turn")),
        ("longitudinal", ("lead vehicle", "brake", "stopped vehicle", "rear-end")),
        ("lateral", ("cut in", "cut-in", "swerve", "lane change")),
    )
    return next((name for name, words in groups if any(word in text for word in words)),
                "freeform")


def _stage_dir(out: str) -> Path:
    root = Path(out).resolve()
    stage = root if root.name == "20-author" else root / "20-author"
    stage.mkdir(parents=True, exist_ok=True)
    return stage


def _atomic_json(path: Path, value: object) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    tmp.replace(path)


def _enforce_minimum_clip(path: Path, minimum_seconds: float = 20.0) -> float:
    template = json.loads(path.read_text())
    choreography = template.setdefault("choreography", {})
    authored = float(choreography.get("clipSeconds", minimum_seconds))
    choreography["clipSeconds"] = max(minimum_seconds, authored)
    _atomic_json(path, template)
    return choreography["clipSeconds"]



def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def author_compiler(brief_text: str, stage: Path) -> dict:
    os.environ["VISTA_MODEL"] = MODEL
    os.environ["VISTA_EFFORT"] = EFFORT
    author = _load_module("showcase_author_llm", ROOT / "tools/gates/author_llm.py")
    brief = {"id": _slug(brief_text), "brief": brief_text, "category": _category(brief_text)}
    prompt = author.AUTHOR_PROMPT % (author.TOOLDOC, brief["category"], brief_text)
    started = time.time()
    decision, raw = author.decide(prompt)
    template_path, valid, issues = author.compile_and_validate(brief, decision, "showcase")
    shutil.copy2(template_path, stage / "template.json")
    wall = round(time.time() - started, 3)
    transcript = {
        "engine": "compiler",
        "brief": brief,
        "model": MODEL,
        "effort": EFFORT,
        "endpoint": BASE_URL,
        "decision": decision,
        "rawResponse": raw,
        "validation": {"valid": valid, "issues": issues},
        "cost": {"wallS": wall, "tokens": None,
                 "tokenNote": "tools/gates/author_llm.py decide() does not expose response usage"},
    }
    _atomic_json(stage / "transcript.json", transcript)
    if not valid:
        raise RuntimeError("compiled template failed validation: " + "; ".join(issues))
    return transcript


def author_vista2(brief_text: str, stage: Path, guide: str, budget: int,
                  wall_cap: int, skip_preflight: bool = False) -> dict:
    guide_source = Path(guide).resolve()
    if not guide_source.is_file():
        raise ValueError(f"--guide must name an existing GUIDE.md: {guide_source}")
    vista_dir = ROOT / "tools/research/vista2"
    sys.path.insert(0, str(vista_dir))
    run = _load_module("showcase_run_vista2", vista_dir / "run_vista2.py")
    if not skip_preflight:
        run.preflight(MODEL, EFFORT)

    brief = {"id": _slug(brief_text), "brief": brief_text, "category": _category(brief_text)}
    guide_path = stage / "GUIDE.md"
    shutil.copy2(guide_source, guide_path)
    llm_log = stage / "llm.jsonl"
    llm = run.vagent.LLM(MODEL, EFFORT, str(llm_log))
    episode = run.vagent.Episode(brief, str(stage), llm, str(guide_path), budget=budget,
                                 wall_cap_s=wall_cap)
    started = time.time()
    row = episode.run()
    wall = round(time.time() - started, 3)

    # An episode may hit its deliberately short budget before emit. Its current
    # scene is still a real, validator-checked authoring artifact, not an admission.
    source_template = (Path(episode.emit_result["template"])
                       if episode.emit_result else Path(episode.scene.write_template("final")))
    shutil.copy2(source_template, stage / "template.json")
    valid, issues = episode.scene.validate()
    shutil.copy2(episode.transcript, stage / "transcript.jsonl")
    source_frames = Path(episode.frames.dir)
    if source_frames.is_dir():
        shutil.copytree(source_frames, stage / "frames", dirs_exist_ok=True)
    transcript = {
        "engine": "vista2",
        "brief": brief,
        "model": MODEL,
        "effort": EFFORT,
        "endpoint": BASE_URL,
        "episode": row,
        "admitted": bool(row.get("admitted")),
        "validation": {"valid": valid, "issues": issues},
        "cost": {"wallS": wall, "tokens": dict(llm.usage)},
        "artifacts": {"actions": "transcript.jsonl", "llm": "llm.jsonl",
                      "frames": "frames/", "guide": "GUIDE.md"},
    }
    _atomic_json(stage / "transcript.json", transcript)
    if not valid:
        raise RuntimeError("Vista2 scene template failed validation: " + "; ".join(issues))
    return transcript


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", required=True, choices=("compiler", "vista2"))
    parser.add_argument("--brief", required=True)
    parser.add_argument("--out", required=True, help="job root (20-author/ is created below it)")
    parser.add_argument("--guide", help="required GUIDE.md seed for --engine vista2")
    parser.add_argument("--budget", type=int, default=40, help="Vista2 mutating-action budget")
    parser.add_argument("--wall-cap", type=int, default=2400, help="Vista2 episode wall cap (s)")
    args = parser.parse_args()
    if args.engine == "vista2" and not args.guide:
        parser.error("--guide is required for --engine vista2")

    os.environ.setdefault("OPENAI_BASE_URL", BASE_URL)
    os.environ.setdefault("OPENAI_API_KEY", "x")
    stage = _stage_dir(args.out)
    if args.engine == "compiler":
        result = author_compiler(args.brief, stage)
    else:
        result = author_vista2(args.brief, stage, args.guide, args.budget, args.wall_cap)
    result["clipSeconds"] = _enforce_minimum_clip(stage / "template.json")
    print(json.dumps({"engine": args.engine, "stage": str(stage),
                      "template": str(stage / "template.json"),
                      "valid": result["validation"]["valid"],
                      "admitted": result.get("admitted"), "cost": result["cost"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
