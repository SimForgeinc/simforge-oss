"""QA-gated native render and unscaled decision-sidebar composition."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
REPO = Path(__file__).resolve().parents[3]


def model_pack(name):
    """A CARLA model pack's directory: its content-addressed closure, fetched by
    digest and verified (scripts/actor-assets/closures.mjs). The models are not
    in git; an unavailable pack fails the render."""
    out = subprocess.run(["node", str(REPO / "scripts/actor-assets/closures.mjs"), "dir", name],
                         check=True, capture_output=True, text=True)
    return out.stdout.strip()


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
    cache = Path(os.environ.get("SIMFORGE_MAPS_CACHE_ROOT",
                                str(Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share"))) / "simforge/maps")))
    maps = Path(os.environ.get("MAPS_ROOT", os.environ.get("SCEN_DEV_ASSETS", str(cache / "map-bundles"))))
    if not (maps / doc["mapId"] / "3d/manifest.json").is_file():
        raise FileNotFoundError(f"No real mesh bundle for {doc['mapId']}; refusing synthetic-ground substitution")
    tiles = run / "map-glbs"
    subprocess.run([sys.executable, str(ROOT / "select_tiles.py"), "--scene-state", str(state),
                    "--maps-root", str(maps), "--out", str(tiles), "--texture-tier", "textures-512-bc7"], check=True)
    selection = json.loads((tiles / "selection.json").read_text())
    frames = run / "frames"
    frames.mkdir(exist_ok=True)
    binary = os.environ.get("SCEN_PLAY", str(Path(__file__).resolve().parents[3] / "renderer/target/release/scen-play"))
    command = [binary, "--scene-state", str(state), "--glbs", ",".join(selection["glbs"]), "--quality", "high",
               "--out-dir", str(frames), "--ticks", str(args.ticks or doc["tickCount"]),
               "--camera", "follow", "--chase-dist", "18", "--chase-height", "12", "--fov", "70",
               "--width", "960", "--height", "540", "--vehicle-models", model_pack("vehicles-carla")]
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
