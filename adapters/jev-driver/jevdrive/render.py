"""QA-gated native render and unscaled decision-sidebar composition."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run")
    parser.add_argument("ticks", type=int, nargs="?")
    args = parser.parse_args()
    run = Path(args.run).resolve()
    state = run / "scenestate.json"
    # Hard gate immediately before every render, never swallowed by a pipe.
    subprocess.run([sys.executable, str(ROOT / "qa_scenestate.py"), "--scene-state", str(state)], check=True)
    doc = json.loads(state.read_text())
    map_roots = [Path(os.environ["MAPS_ROOT"])] if "MAPS_ROOT" in os.environ else [
        Path("/home/path/tmp/tier-integration-root/installed-maps/map-bundles"),
        Path("/home/path/tmp/tier-core-daemon/installed-maps/map-bundles")]
    maps = next((p for p in map_roots if (p / doc["mapId"] / "3d/manifest.json").is_file()), None)
    if maps is None:
        raise FileNotFoundError(f"No real mesh bundle for {doc['mapId']}; refusing synthetic-ground substitution")
    tiles = run / "map-glbs"
    subprocess.run([sys.executable, str(ROOT / "select_tiles.py"), "--scene-state", str(state), "--maps-root", str(maps), "--out", str(tiles)], check=True)
    frames = run / "frames"
    frames.mkdir(exist_ok=True)
    binary = os.environ.get("SCEN_PLAY", "/home/path/simforge-oss/renderer/target/release/scen-play")
    command = [binary, "--scene-state", str(state), "--glbs", ",".join(str(p.resolve()) for p in sorted(tiles.glob("*.glb"))),
               "--out-dir", str(frames), "--ticks", str(args.ticks or doc["tickCount"]),
               "--camera", "follow", "--chase-dist", "18", "--chase-height", "12", "--fov", "70",
               "--width", "960", "--height", "540", "--vehicle-models", "/home/path/simforge-oss/catalog/vehicles-carla"]
    (run / "render-command.json").write_text(json.dumps(command, indent=2))
    with (run / "render.log").open("w") as log:
        subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
    count = len(list(frames.glob("*.rgb.png")))
    expected = args.ticks or doc["tickCount"]
    if count != expected:
        raise RuntimeError(f"native renderer wrote {count} frames, expected {expected}")
    if expected == doc["tickCount"]:
        subprocess.run([sys.executable, "-m", "jevdrive.video", "--run", str(run)], check=True)
    print(f"Rendered {count} QA-gated real-map frames")

if __name__ == "__main__":
    main()
