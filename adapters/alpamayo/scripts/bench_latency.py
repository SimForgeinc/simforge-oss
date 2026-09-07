"""Latency + VRAM benchmark against a running simforge-alpamayo server.

Measures p50/p95 wall latency through the wire at 2-cam and 7-cam synthetic
profiles, plus server-side breakdown and VRAM at rest / peak.

    python scripts/bench_latency.py --socket /tmp/simforge-alpamayo.sock \
        --iters 12 --out out/bench_nf4.json
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from simforge_alpamayo.client import AlpamayoClient  # noqa: E402
from simforge_alpamayo.obs import synthetic_observation  # noqa: E402


def pct(values: list[float], q: float) -> float:
    values = sorted(values)
    idx = min(len(values) - 1, max(0, round(q * (len(values) - 1))))
    return values[idx]


def bench_profile(client: AlpamayoClient, cams: int, iters: int, samples: int) -> dict:
    wall, infer, prep = [], [], []
    vram_peak = 0.0
    for i in range(iters):
        obs = synthetic_observation(num_cameras=cams, seed=1000 + i)
        t0 = time.monotonic()
        resp = client.act(obs, seed=1000 + i, num_traj_samples=samples)
        dt = (time.monotonic() - t0) * 1e3
        if not resp.get("ok"):
            raise RuntimeError(f"act failed: {resp.get('error')}")
        r = resp["result"]
        wall.append(dt)
        infer.append(r["timings"]["inference_ms"])
        prep.append(r["timings"]["preprocess_ms"])
        vram_peak = max(vram_peak, r["vram"].get("peak_allocated_mb", 0.0))
        print(f"  [{cams}cam iter {i}] wall={dt:.0f}ms infer={infer[-1]:.0f}ms", flush=True)
    return {
        "cams": cams,
        "iters": iters,
        "num_traj_samples": samples,
        "wall_ms": {
            "p50": pct(wall, 0.5),
            "p95": pct(wall, 0.95),
            "mean": statistics.mean(wall),
            "min": min(wall),
            "max": max(wall),
        },
        "inference_ms": {"p50": pct(infer, 0.5), "p95": pct(infer, 0.95)},
        "preprocess_ms": {"p50": pct(prep, 0.5), "p95": pct(prep, 0.95)},
        "achievable_hz_p50": 1000.0 / pct(wall, 0.5),
        "vram_peak_allocated_mb": vram_peak,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", default="/tmp/simforge-alpamayo.sock")
    parser.add_argument("--iters", type=int, default=12)
    parser.add_argument("--samples", type=int, default=1)
    parser.add_argument("--profiles", type=int, nargs="+", default=None,
                        help="synthetic camera counts; default: the family's own set")
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    client = AlpamayoClient(args.socket)
    hello = client.hello()
    print("server:", hello.get("family"), hello.get("quant"), hello.get("gpu"))
    if hello.get("quant_status") not in (None, "supported"):
        # A benchmark of an unmeasured mode is how a guess becomes a number.
        print(f"NOTE: quant {hello.get('quant')} is "
              f"{hello.get('quant_status')} for {hello.get('family')}; this run "
              f"is what establishes its envelope, not a confirmation of one.")
    cameras = (hello.get("capabilities") or {}).get("cameras") or {}
    profiles = args.profiles or [len(cameras.get("default") or [2])]

    rest = client.health()["vram"]
    print("VRAM at rest:", json.dumps(rest))

    # one warmup per profile so cudnn autotune/allocator noise stays out of stats
    results = {"quant": hello.get("quant"), "vram_at_rest": rest, "profiles": []}
    for cams in profiles:
        print(f"profile {cams}-cam: warmup...", flush=True)
        client.warmup(cams=cams)
        results["profiles"].append(bench_profile(client, cams, args.iters, args.samples))

    results["vram_after"] = client.health()["vram"]
    client.close()

    print(json.dumps(results, indent=2))
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(results, indent=2))
        print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
