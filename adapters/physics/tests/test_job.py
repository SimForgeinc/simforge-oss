import json
import subprocess
import sys
from pathlib import Path

import pytest

pytest.importorskip("mujoco")

PKG_ROOT = Path(__file__).resolve().parents[1]


def run_job(tmp: Path, params: dict, out: str, resume: Path | None = None) -> subprocess.CompletedProcess:
    params_path = tmp / f"{out}.params.json"
    params_path.write_text(json.dumps(params))
    cmd = [sys.executable, "-m", "simforge_oss_physics", "job", "--params", str(params_path), "--out-dir", str(tmp / out)]
    if resume:
        cmd += ["--resume", str(resume)]
    return subprocess.run(cmd, cwd=PKG_ROOT, capture_output=True, text=True)


def events(proc: subprocess.CompletedProcess) -> list[dict]:
    return [json.loads(line) for line in proc.stdout.splitlines()]


PARAMS = {"backend": "mujoco-cpu", "seeds": [3, 4], "start": "approach", "decisions": 120, "torqueNm": 1.0, "checkpointEveryDecisions": 50}


def test_job_writes_episodes_scene_states_and_artifacts(tmp_path):
    proc = run_job(tmp_path, PARAMS, "a")
    assert proc.returncode == 0, proc.stderr
    evs = events(proc)
    assert evs[-1]["event"] == "done"
    rel = sorted(a["relativePath"] for a in evs[-1]["artifacts"])
    glb = [r for r in rel if r.startswith("course/") and r.endswith(".glb")]
    assert len(glb) == 1
    assert rel == sorted(
        [
            "episodes.json",
            "course/manifest.json",
            glb[0],
            "render/scene-spec.json",
            "scene-state.3.json",
            "scene-state.4.json",
            "render/scene-state.3.native.json",
            "render/scene-state.4.native.json",
        ]
    )
    spec = json.loads((tmp_path / "a" / "render" / "scene-spec.json").read_text())
    assert spec["sceneSpec"]["glbs"] == [glb[0]] and (tmp_path / "a" / glb[0]).is_file()
    episodes = json.loads((tmp_path / "a" / "episodes.json").read_text())
    assert [e["seed"] for e in episodes] == [3, 4]
    assert all(e["decisions"] == 120 and e["scene_state_frames"] == 121 for e in episodes)
    checkpoints = [e for e in evs if e["event"] == "checkpoint"]
    assert len(checkpoints) == 4  # decisions 50 and 100 for each seed


def test_resume_from_checkpoint_reproduces_uninterrupted_outputs(tmp_path):
    full = run_job(tmp_path, PARAMS, "full")
    assert full.returncode == 0, full.stderr
    # Checkpoint at decision 50 of the first seed.
    first_ckpt = Path([e for e in events(full) if e["event"] == "checkpoint"][0]["path"])
    resumed = run_job(tmp_path, PARAMS, "resumed", resume=first_ckpt)
    assert resumed.returncode == 0, resumed.stderr
    a = json.loads((tmp_path / "full" / "episodes.json").read_text())
    b = json.loads((tmp_path / "resumed" / "episodes.json").read_text())
    assert a == b
    for seed in (3, 4):
        assert (tmp_path / "full" / f"scene-state.{seed}.json").read_bytes() == (
            tmp_path / "resumed" / f"scene-state.{seed}.json"
        ).read_bytes()


def test_bad_params_exit_1_with_error_event(tmp_path):
    proc = run_job(tmp_path, {**PARAMS, "extra": 1}, "bad")
    assert proc.returncode == 1
    err = json.loads(proc.stderr.strip().splitlines()[-1])
    assert err["event"] == "error" and err["code"] == "bad-params" and "extra" in err["message"]
