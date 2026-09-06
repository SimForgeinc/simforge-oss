"""O2 determinism: same scene-state doc + cameras rendered twice through the service (and across a
service restart with a new --label) must yield byte-identical ring payloads (CRC32 digests)."""
import sys, json, argparse
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "renderer/service/python"))
from simforge_native import NativeRenderClient, BundleRingReader
from splat_client_check import scene_state, cameras_from_rig

ap = argparse.ArgumentParser()
ap.add_argument("--socket", default="/tmp/simforge-splat-gpu3.sock")
ap.add_argument("--scene", default="/data/share7/ubuntu/simforge-fix/scenes-v3/007a5809-8a56-40b5-8af5-7e0f65229496")
ap.add_argument("--out", default="/data/share7/ubuntu/simforge-fix/nurec-backend/runs/o2/determinism.json")
ap.add_argument("--label", default="run")
args = ap.parse_args()
bundle = Path(args.scene)
c = NativeRenderClient(args.socket); r = BundleRingReader(c.hello["shm"]["path"])
cams = cameras_from_rig(bundle, {"width": 552, "height": 348, "format": "rgb8"})
digests = {}
for t_s in [0.5, 2.0, 5.0, 9.0]:
    doc = scene_state(bundle, t_s, 50.0)
    c.load_scene_state([doc])
    for rep in range(2):
        resp = c.render_bundle(int(t_s * 10) * 2 + rep, cams if (t_s == 0.5 and rep == 0) else None, passes=["rgb", "depth", "id"])
        assert resp["ok"], resp
        b = r.bundle_at(resp["bundle_offset"], resp["bundle_len"], verify=True)
        digests[f"{t_s}/{rep}"] = {f"{e.camera_id}/{e.pass_}": e.digest_hex for e in b.entries}
c.close(); r.close()
same_run = all(digests[f"{t}/0"] == digests[f"{t}/1"] for t in [0.5, 2.0, 5.0, 9.0])
out = Path(args.out); prev = json.loads(out.read_text()) if out.exists() else {}
prev[args.label] = {"hello": {k: v for k, v in c.hello.items() if k in ("renderer", "determinism")}, "digests": digests, "repeat_identical": same_run}
labels = [key for key in prev if not key.startswith("_")]
if len(labels) > 1:
    cross = all(prev[labels[0]]["digests"][k] == prev[l]["digests"][k] for l in labels[1:] for k in prev[labels[0]]["digests"])
    prev["_cross_run_identical"] = cross
out.write_text(json.dumps(prev, indent=1))
print(args.label, "repeat_identical", same_run, "cross_run", prev.get("_cross_run_identical"))
