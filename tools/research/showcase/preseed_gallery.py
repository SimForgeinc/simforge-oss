#!/usr/bin/env python3
"""Build a durable, video-backed showcase gallery seed from measured cell roots.

Candidates need a contract cell pair and a vision-asserted sol verdict. Ranking is
lexicographic by frozen-gate pass, realism+dynamism, realism, then dynamism. The
default selection reserves an equal top-ranked share for each surviving corpus root
before filling remaining slots globally, so one measured arm cannot erase the others.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import time


ROOT = Path(__file__).resolve().parents[3]
DEFAULT_ROOTS = (
    "/tmp/tgr-freeform-base1/cells",
    "/tmp/tgr-emergent-pair1/cells",
    "/tmp/tgr-emergent-h2/cells",
    "/tmp/tgr-vista-main1/cells",
)


def _json(path: Path) -> dict:
    return json.loads(path.read_text())


def _story_key(meta: dict) -> str:
    return str(meta.get("briefId") or meta.get("harvestId") or meta.get("cellId"))


def score(candidate: dict) -> tuple:
    meta, verdict = candidate["meta"], candidate["verdict"]
    return (bool((meta.get("gate") or {}).get("pass")),
            float(verdict.get("realism", 0)) + float(verdict.get("dynamism", 0)),
            float(verdict.get("realism", 0)), float(verdict.get("dynamism", 0)),
            float(verdict.get("confidence", 0)))


def discover(root: Path) -> list[dict]:
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        if Path(dirpath).name == "render":
            dirnames[:] = []
            continue
        needed = {"instance.json", "trace.json.gz", "meta.json",
                  "review-gpt-5.6-sol.json"}
        if not needed.issubset(filenames):
            continue
        cell = Path(dirpath)
        try:
            meta = _json(cell / "meta.json")
            verdict = _json(cell / "review-gpt-5.6-sol.json")
        except (OSError, ValueError, TypeError):
            continue
        if not verdict.get("visionAsserted") or verdict.get("model") != "gpt-5.6-sol":
            continue
        found.append({"cell": cell, "root": root, "meta": meta, "verdict": verdict})
    return sorted(found, key=lambda item: (score(item), item["meta"].get("cellId", "")),
                  reverse=True)


def select(candidates_by_root: dict[Path, list[dict]], count: int) -> list[dict]:
    live = {root: rows for root, rows in candidates_by_root.items() if rows}
    if not live:
        return []
    selected, seen_cells, seen_stories = [], set(), set()

    def add(row: dict, unique_story: bool = True) -> bool:
        cell_id = row["meta"].get("cellId")
        story = _story_key(row["meta"])
        if cell_id in seen_cells or (unique_story and story in seen_stories):
            return False
        selected.append(row)
        seen_cells.add(cell_id)
        seen_stories.add(story)
        return True

    quota = count // len(live)
    for root in sorted(live, key=str):
        for row in live[root]:
            if sum(1 for item in selected if item["root"] == root) >= quota:
                break
            add(row)
    ranked = sorted((row for rows in live.values() for row in rows),
                    key=lambda item: (score(item), item["meta"].get("cellId", "")),
                    reverse=True)
    for unique_story in (True, False):
        for row in ranked:
            if len(selected) >= count:
                return selected
            add(row, unique_story=unique_story)
    return selected


def _brief(meta: dict, verdict: dict) -> str:
    notes = str(meta.get("notes") or "")
    if notes.lower().startswith("brief:"):
        return notes.split(":", 1)[1].strip()
    key = meta.get("briefId") or meta.get("harvestId")
    if key and not str(key).startswith("emergent-h2-"):
        return str(key).replace("-", " ").replace("_", " ")
    return str(verdict.get("mechanismObserved") or meta.get("cellId"))


def _map_id(instance: dict, meta: dict) -> str | None:
    return ((instance.get("manifest") or {}).get("replayKey") or {}).get("mapId") \
        or meta.get("map")


def _render(instance: Path, trace: Path, out: Path, dev_assets: Path) -> float:
    started = time.time()
    cmd = ["node", str(ROOT / "scripts/render-trace.mjs"),
           "--instance", str(instance), "--trace", str(trace), "--out", str(out),
           "--size", "960x600", "--scale", "8", "--fps", "12",
           "--camera", "follow-ego"]
    if dev_assets.is_dir():
        cmd.extend(["--dev-assets", str(dev_assets)])
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=300)
    if proc.returncode:
        raise RuntimeError(f"renderer failed: {proc.stderr[-1000:]}")
    (out / "trace-render.mp4").replace(out / "rollout.mp4")
    return round(time.time() - started, 3)


def materialize(selected: list[dict], out: Path, dev_assets: Path, force: bool) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for index, row in enumerate(selected, 1):
        seed = out / f"{index:03d}"
        if seed.exists():
            if not force:
                raise FileExistsError(f"{seed} exists (use --force to replace gallery seeds)")
            shutil.rmtree(seed)
        cell_id = row["meta"]["cellId"]
        cell_dir = seed / "40-cells" / cell_id
        render_dir = seed / "60-render2d" / cell_id
        cell_dir.mkdir(parents=True)
        render_dir.mkdir(parents=True)
        for name in ("instance.json", "trace.json.gz", "meta.json",
                     "review-gpt-5.6-sol.json"):
            shutil.copy2(row["cell"] / name, cell_dir / name)
        wall = _render(cell_dir / "instance.json", cell_dir / "trace.json.gz",
                       render_dir, dev_assets)
        meta, verdict = row["meta"], row["verdict"]
        instance = _json(cell_dir / "instance.json")
        map_id = _map_id(instance, meta)
        # The server's /artifacts route is rooted at showcase-data, which is the
        # parent of the default gallery-seed directory.
        data_root = out.parent
        relative = lambda path: path.relative_to(data_root).as_posix()  # noqa: E731
        video = relative(render_dir / "rollout.mp4")
        media_url = "/artifacts/" + video
        card = {
            "id": f"seed-{index:03d}", "jobId": f"seed-{index:03d}",
            "cellId": cell_id, "source": "gallery-seed",
            "sourceCorpus": row["root"].parent.name, "brief": _brief(meta, verdict),
            "engine": meta.get("stream", "unknown"),
            "map": map_id, "maps": [map_id] if map_id else [],
            "admitted": bool((meta.get("gate") or {}).get("pass")),
            "gate": meta.get("gate"),
            "scores": {"realism": verdict.get("realism"),
                       "dynamism": verdict.get("dynamism"),
                       "plausible": verdict.get("plausible"),
                       "confidence": verdict.get("confidence")},
            "judge": verdict,
            "headline": media_url, "headlineVideo": media_url, "media": media_url,
            "headlineArtifact": media_url, "video": media_url,
            "realism": verdict.get("realism"), "dynamism": verdict.get("dynamism"),
            "admittedCells": 1 if (meta.get("gate") or {}).get("pass") else 0,
            "totalCells": 1,
            "artifacts": {
                "instance": relative(cell_dir / "instance.json"),
                "trace": relative(cell_dir / "trace.json.gz"),
                "render2d": relative(render_dir), "video": video,
                "judge": relative(cell_dir / "review-gpt-5.6-sol.json"),
            },
            "timings": {"render2dWallS": wall},
        }
        (seed / "90-gallery.json").write_text(json.dumps(card, indent=2, sort_keys=True) + "\n")
        print(f"[{index:02d}/{len(selected)}] {cell_id} gate={card['admitted']} "
              f"score={score(row)[1]} render={wall}s", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--roots", nargs="+", default=list(DEFAULT_ROOTS))
    parser.add_argument("--out", default=str(ROOT / "showcase-data/gallery-seed"))
    parser.add_argument("--count", type=int, default=24)
    parser.add_argument("--dev-assets", default=str(ROOT / "dev-assets"))
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    if args.count < 1:
        parser.error("--count must be positive")
    roots = [Path(path).resolve() for path in args.roots if Path(path).is_dir()]
    missing = [path for path in args.roots if not Path(path).is_dir()]
    for path in missing:
        print(f"SKIP missing root: {path}")
    rows = {root: discover(root) for root in roots}
    for root, candidates in rows.items():
        print(f"{root}: {len(candidates)} eligible cells")
    selected = select(rows, args.count)
    if len(selected) < args.count:
        raise RuntimeError(f"only {len(selected)} eligible cells; requested {args.count}")
    materialize(selected, Path(args.out).resolve(), Path(args.dev_assets).resolve(), args.force)
    print(f"populated {len(selected)} cards under {Path(args.out).resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
