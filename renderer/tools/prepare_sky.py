#!/usr/bin/env python3
"""Materialise the NASA sky plates the renderer needs, from the pins in
renderer/render-core/assets/sky/SOURCES.json.

    python3 renderer/tools/prepare_sky.py

The plates (*.skytex) are derivatives and are not committed. For each pinned
source: reuse the product when it already matches its pinned sha256 and length;
otherwise download the original (cached under $XDG_CACHE_HOME/simforge/sky-src,
refused the moment it exceeds its pinned length, verified by sha256), convert
it with prepare_sky_assets.py, and verify every product against its pin.
SOURCES.json is restored byte for byte afterwards (the converter rewrites it).
Any mismatch is an error; nothing is substituted.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

RENDERER = Path(__file__).resolve().parents[1]
SKY = RENDERER / "render-core" / "assets" / "sky"
SOURCES = SKY / "SOURCES.json"
SRC = RENDERER / "assets-src"
CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "simforge" / "sky-src"
PRODUCTS = CACHE.parent / "sky-products"  # verified products, shared by every checkout


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def matches(path: Path, digest: str, size: int) -> bool:
    return path.is_file() and path.stat().st_size == size and sha256(path) == digest


def fetch(source: dict) -> None:
    cached = CACHE / source["download"]
    if not matches(cached, source["download_sha256"], source["download_bytes"]):
        CACHE.mkdir(parents=True, exist_ok=True)
        partial = cached.with_suffix(cached.suffix + ".part")
        with urllib.request.urlopen(source["file_url"]) as response, partial.open("wb") as out:
            total = 0
            while chunk := response.read(1 << 20):
                total += len(chunk)
                if total > source["download_bytes"]:
                    raise SystemExit(f"prepare_sky: {source['file_url']} exceeds its pinned length {source['download_bytes']}")
                out.write(chunk)
        if not matches(partial, source["download_sha256"], source["download_bytes"]):
            raise SystemExit(f"prepare_sky: {source['file_url']} does not match its pinned sha256/length")
        partial.replace(cached)
    SRC.mkdir(exist_ok=True)
    target = SRC / source["download"]
    if not matches(target, source["download_sha256"], source["download_bytes"]):
        shutil.copyfile(cached, target)


def main() -> int:
    pins = SOURCES.read_bytes()
    sources = json.loads(pins)["sources"]
    for s in sources:  # a verified product from an earlier conversion (same pin, any checkout)
        cached = PRODUCTS / s["product"]
        if not matches(SKY / s["product"], s["product_sha256"], s["product_bytes"]) and matches(cached, s["product_sha256"], s["product_bytes"]):
            shutil.copyfile(cached, SKY / s["product"])
    todo = [s for s in sources if not matches(SKY / s["product"], s["product_sha256"], s["product_bytes"])]
    if todo:
        for source in sources:
            fetch(source)
        try:
            subprocess.run([sys.executable, str(RENDERER / "tools" / "prepare_sky_assets.py")], check=True)
        finally:
            SOURCES.write_bytes(pins)
        for s in sources:
            if not matches(SKY / s["product"], s["product_sha256"], s["product_bytes"]):
                raise SystemExit(f"prepare_sky: {s['product']} does not match its pinned sha256/length")
            PRODUCTS.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(SKY / s["product"], PRODUCTS / s["product"])
    print(json.dumps({"schema": "simforge.sky-prepare/v1", "converted": len(todo),
                      "products": [{"product": s["product"], "sha256": s["product_sha256"]} for s in sources]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
