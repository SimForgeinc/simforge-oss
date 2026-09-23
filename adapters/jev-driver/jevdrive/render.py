"""QA-gated native render and unscaled decision-sidebar composition."""
import argparse
import json
import math
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
CHASE_SENSOR = "chase"


def chase_host(doc):
    """The follow camera's actor: `ego`, else the first actor of frame 0."""
    first = doc["frames"][0]["actors"]
    if not first:
        raise ValueError("scene state has no actor in frame 0 to follow")
    return next((a["id"] for a in first if a["id"] == "ego"), first[0]["id"])


def scene_state_stream(doc):
    """A scene-state.v1 document (header, actor descriptors, frames) as the
    per-tick stream the render service loads. Heights stay as authored: a
    zero height with no `groundY` snaps to the map ground, as before."""
    if doc["version"] != "simforge.scene-state.v1":
        raise ValueError(f"scene-state version {doc['version']!r}")
    descriptors = {a["id"]: a for a in doc["actors"]}
    stream = []
    for frame in doc["frames"]:
        actors = []
        for a in frame["actors"]:
            d = descriptors[a["id"]]
            actors.append({
                "id": a["id"], "kind": a["kind"], "catalogId": d["catalogId"], "actorClass": d["actorClass"],
                "dims": d["dims"], **({"color": d["color"]} if d.get("color") else {}),
                "transform": {"position": a["position"], "rotation": a["rotation"]},
                "velocity": a.get("velocity", [0.0, 0.0, 0.0]),
            })
        tick = {"version": doc["version"], "mapId": doc["mapId"], "tick": frame["tick"], "tickHz": doc["tickHz"],
                "weather": doc.get("weather"), "timeOfDay": doc.get("timeOfDay"), "actors": actors}
        if doc.get("groundY") is not None:
            tick["groundY"] = doc["groundY"]
        stream.append(tick)
    return stream


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
    ticks = args.ticks or doc["tickCount"]
    stream_path = run / "render-scene-state.json"
    stream_path.write_text(json.dumps(scene_state_stream(doc)))
    focus = chase_host(doc)
    repo = ROOT.parents[1]
    binary = os.environ.get("SIMFORGE_RENDER_BIN", str(repo / "renderer/target/release/simforge-render"))
    job = {
        "schema": "simforge.render-job/v2",
        "scene": {
            "glbs": selection["glbs"],
            "lighting": {"sun_elev_deg": 38, "sun_azim_deg": 145, "sun_lux": 28000, "ambient": 0.6},
            # The retired playback `--quality high` look: atmosphere/IBL, soft
            # shadows, AO; the showcase preset is that stack.
            "render": {"preset": "showcase"},
            "vehicleModels": str(repo / "catalog/vehicles-carla"),
        },
        "sceneState": str(stream_path),
        "rig": {"cameras": [{
            "sensorId": CHASE_SENSOR, "width": 960, "height": 540, "fovDeg": 70,
            "eye": [0, 0, 0], "target": [0, 0, 1],
            # Follow camera: 18 m behind, 12 m above the focus actor, aimed
            # at the ground 8 m ahead of it.
            "attach": {"actorId": focus, "offsetM": [-18.0, 0.0, 12.0],
                       "pitchDeg": -math.degrees(math.atan2(12.0, 26.0)), "hostVisible": True},
        }]},
        "ticks": {"start": 0, "count": ticks},
        "passes": ["rgb"],
        "outDir": str(frames),
    }
    job_path = run / "render-job.json"
    job_path.write_text(json.dumps(job, indent=2))
    command = [binary, "job", "--job", str(job_path)]
    (run / "render-command.json").write_text(json.dumps(command, indent=2))
    with (run / "render.log").open("w") as log:
        subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
    frames = frames / CHASE_SENSOR
    count = len(list(frames.glob("*.rgb.png")))
    expected = ticks
    if count != expected:
        raise RuntimeError(f"native renderer wrote {count} frames, expected {expected}")
    if expected == doc["tickCount"]:
        subprocess.run([sys.executable, "-m", "jevdrive.video", "--run", str(run)], check=True)
    print(f"Rendered {count} QA-gated real-map frames")

if __name__ == "__main__":
    main()
