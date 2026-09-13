#!/usr/bin/env python3
"""Diagnostic ONLY: is the G1 deficit concentrated in the bottom of the frame?

The renders are produced with --hood none (we have no AlpaSim hood overlay assets), while the
recorded frames come from a real vehicle whose bonnet occupies a fixed bottom band. If that is
the deficit's source, per-row error will spike in the bottom rows and the top of the frame will
score far better. This does NOT change G1 and produces no gate verdict.
"""
import io, json, re, sys, zipfile
import numpy as np
from PIL import Image

pkg, render_dir, sensor, ep_start, tick_hz = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), 10.0
z = zipfile.ZipFile(pkg)
frames = {}
for n in z.namelist():
    m = re.match(rf"^frames/{re.escape(sensor)}/(\d+)\.jpe?g$", n)
    if m: frames[int(m.group(1))] = n

best = None
import glob, os
for path in sorted(glob.glob(f"{render_dir}/frames/{sensor}/rgb/tick-*.png")):
    tick = int(os.path.basename(path)[5:11])
    t_us = int(round(ep_start + tick / tick_hz * 1e6))
    near = min(frames, key=lambda k: abs(k - t_us))
    if abs(near - t_us) <= 0.5e6 / tick_hz:
        best = (path, frames[near], abs(near - t_us)); break
if best is None:
    print(json.dumps({"sensor": sensor, "matched": False})); raise SystemExit

rendered = np.asarray(Image.open(best[0]).convert("RGB"), dtype=np.float32) / 255.0
with Image.open(io.BytesIO(z.read(best[1]))) as im:
    truth = np.asarray(im.convert("RGB").resize((rendered.shape[1], rendered.shape[0]), Image.BOX), dtype=np.float32) / 255.0

def psnr(a, b):
    mse = float(np.mean((a - b) ** 2))
    return 99.0 if mse <= 0 else float(10 * np.log10(1.0 / mse))

h = rendered.shape[0]
bands = {f"rows {int(100*lo)}-{int(100*hi)}%": psnr(rendered[int(lo*h):int(hi*h)], truth[int(lo*h):int(hi*h)])
         for lo, hi in [(0,.25),(.25,.5),(.5,.75),(.75,1.0)]}
print(json.dumps({"sensor": sensor, "matched": True, "skewUs": best[2], "full": round(psnr(rendered, truth),2),
                  "excludingBottom25pct": round(psnr(rendered[:int(.75*h)], truth[:int(.75*h)]),2),
                  "bands": {k: round(v,2) for k,v in bands.items()}}))
