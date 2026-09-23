"""Permanent W0 parity: the real bindings and existing EnvSession run one stream.

Build the PyO3 extension and N-API addon first. SIMFORGE_NATIVE_RUNTIME_ADDON can
point at an isolated addon; SIMFORGE_EPISODE_PARITY_OUT retains the 30s receipts.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess

import numpy as np
import pytest

from simforge_oss_gym import native
from simforge_oss_gym.tools.episode_trace import convert_trace, deterministic_record, verify_trace

ROOT = Path(__file__).resolve().parents[3]


def test_thirty_second_episode_parity(tmp_path: Path) -> None:
    out = Path(os.environ.get("SIMFORGE_EPISODE_PARITY_OUT", str(tmp_path)))
    out.mkdir(parents=True, exist_ok=True)
    fixture = json.loads((Path(__file__).parent / "fixtures/synthetic-episode.json").read_text())["instances"][0]
    scenario = fixture["input"]
    scenario["clipSeconds"] = 30
    scenario["seed"] = 42
    spec = {"scenario": scenario, "seed": 42, "decisionHz": 10,
            "mode": {"kind": "offline-simtime"}, "warmupDecisions": 0,
            "maxDecisions": 300, "observation": {"channels": [{"kind": "state"}]}}
    plan = {"k": "t", "p": [[1.0, 0.0, 0.0, 6.0, 0.1], [600.0, 0.0, 0.0, 6.0, 100.0]]}
    actions = ([{"k": "s", "speedMps": 8.0}] * 50
               + [{"k": "c", "c": [0.0, 0.0, 0.0]}] * 50 + [plan] * 200)
    input_path = out / "recorded-input.json"
    input_path.write_text(json.dumps({"spec": spec, "topology": fixture["topology"], "actions": actions}))
    graph = native.LaneGraph.from_topology(json.dumps(fixture["topology"]).encode())
    episode = native.Episode(json.dumps(spec), graph)
    reset = json.loads(episode.reset())
    results = [json.loads(episode.step(json.dumps(action))) for action in actions]
    core = json.loads(episode.finish())
    trace = episode.trace_json()
    (out / "pyo3.trace.jsonl").write_text(trace)
    (out / "pyo3.result.json").write_text(json.dumps(core))
    records, digest = verify_trace(trace)
    assert core["decisions"] == 300 and core["timing"]["policySimulationS"] == 30.0
    assert core["status"] == "succeeded" and results[-1]["truncated"]
    assert core["modelHealth"] is None
    assert digest == core["episodeDigest"] == episode.trace_digest()

    addon = Path(os.environ.get("SIMFORGE_NATIVE_RUNTIME_ADDON", str(
        ROOT / "packages/native-runtime/native/simforge-native-runtime.linux-x64-gnu.node")))
    assert addon.is_file(), f"build N-API addon first: {addon}"
    completed = subprocess.run(["node", str(Path(__file__).with_name("episode_parity.mjs")),
                                str(addon), str(input_path), str(out)], check=True, capture_output=True, text=True)
    print(completed.stdout.strip())
    node = json.loads((out / "napi.result.json").read_text())
    node_records, node_digest = verify_trace((out / "napi.trace.jsonl").read_text())
    assert node["reset"] == reset and node["results"] == results
    assert node_digest == node["digest"] == digest
    assert [deterministic_record(r) for r in node_records[:-1]] == [deterministic_record(r) for r in records[:-1]]

    # Reconstruct v2 deterministic state/executor rows from the existing env /
    # policy executor, not from an Episode second run. Metadata/action identity
    # is shared; all state, reward, terminal and event fields come from EnvSession.
    env = native.EnvSession(native.ScenarioInput.parse(json.dumps(scenario)), graph,
                            json.dumps({"decisionHz": 10, "maxDecisions": 300}))
    policy = native.PolicySession(env)
    first = policy.reset(42)
    assert first.state_vector.tolist() == reset["stateVector"]
    env_rows = [deterministic_record(records[0])]
    env_rows[0]["reset"]["observation"]["stateVector"] = first.state_vector.tolist()
    for index, action in enumerate(actions):
        executor = None
        if action["k"] == "s":
            row = np.full(native.ACTION_WIDTH, np.nan, dtype=np.float64)
            row[0], row[2] = action["speedMps"], 1.0
            expected = env.step(row)
        elif action["k"] == "c":
            expected = policy.act_control(*action["c"]).step
        else:
            outcome = policy.act_trajectory(np.asarray(action["p"], dtype=np.float64))
            expected = outcome.step
            executor = json.loads(outcome.executor_json())
        actual = results[index]
        assert expected.state_vector.tolist() == actual["obs"]["stateVector"]
        assert (expected.reward, expected.terminated, expected.truncated) == (
            actual["reward"], actual["terminated"], actual["truncated"])
        assert executor == actual["ex"]
        row = deterministic_record(records[index + 1])
        row.update(t=expected.t_s, sv=expected.state_vector.tolist(), rw=expected.reward,
                   term=int(expected.terminated), trunc=int(expected.truncated),
                   terms=expected.reward_terms[:3].tolist(), ex=executor,
                   term_reason=expected.term_reason, events=json.loads(expected.info_json())["events"])
        row["reward_terms"] = json.loads(expected.info_json())["rewardTerms"]
        env_rows.append(row)
    env_digest = ""
    env_lines = []
    for row in env_rows:
        env_digest = hashlib.sha256((env_digest + native.canonical_json(json.dumps(row))).encode()).hexdigest()
        env_lines.append(json.dumps({**row, "digest": env_digest}, sort_keys=True))
    assert env_digest == digest
    (out / "env-session.trace.jsonl").write_text("\n".join(env_lines) + "\n")
    (out / "legacy.trace.jsonl").write_text(convert_trace(trace))
    damaged = copy.deepcopy(records)
    damaged[10]["rw"] += 1.0
    with pytest.raises(ValueError, match="digest mismatch"):
        verify_trace("\n".join(json.dumps(row) for row in damaged))
    print(f"30s PyO3={digest} N-API={node_digest} EnvSession={env_digest}")


@pytest.mark.skipif(not os.environ.get("SIMFORGE_EPISODE_CAMERA_INPUT"),
                    reason="requires a provisioned renderer and SIMFORGE_EPISODE_CAMERA_INPUT")
def test_ten_second_camera_episode_parity(tmp_path: Path) -> None:
    """Real cameras: kernel scene parity, payload/trace identity, measured RGB parity.

    Input is {spec, topology, actions}; spec declares the concrete rig and
    Embedded or dedicated Service backend. Renderer nondeterminism is reported
    as a measured mismatch rate, never normalized out of either trace.
    """
    import zlib
    from PIL import Image
    from simforge_oss_gym.bevy_sensors import BevySensorRig

    source = Path(os.environ["SIMFORGE_EPISODE_CAMERA_INPUT"])
    document = json.loads(source.read_text())
    out = Path(os.environ.get("SIMFORGE_EPISODE_PARITY_OUT", str(tmp_path)))
    out.mkdir(parents=True, exist_ok=True)
    graph = native.LaneGraph.from_topology(json.dumps(document["topology"]).encode())
    episode = native.Episode(json.dumps(document["spec"]), graph)
    evidence = []
    rig = BevySensorRig(episode)

    def consume(observation: dict) -> None:
        rows = observation["cameras"]
        frames = rig.frames(observation)
        receipt = []
        try:
            for row, frame in zip(rows, frames):
                payload = frame.frame.buffer()
                assert not payload.flags.owndata and not payload.flags.writeable
                assert hashlib.sha256(payload).hexdigest() == row["frame"]["sha256"]
                assert f"{zlib.crc32(payload):08x}" == row["frame"]["digest"]
                if not evidence and frame.pass_name == "rgb":
                    Image.fromarray(frame.array).save(out / f"pyo3.{frame.sensor_id}.png")
                receipt.append({"sensorId": frame.sensor_id, "pass": frame.pass_name,
                                "width": row["width"], "height": row["height"],
                                "rowStride": row["frame"]["rowStride"], "digest": frame.digest,
                                "sha256": frame.sha256})
            evidence.append({"tS": observation["tS"], "scene": json.loads(episode.scene_state_json()), "frames": receipt})
        finally:
            rig.close()

    try:
        consume(json.loads(episode.reset()))
        for action in document["actions"]:
            consume(json.loads(episode.step(json.dumps(action)))["obs"])
        core = json.loads(episode.finish())
        assert core["timing"]["policySimulationS"] == 10.0
        assert core["decisions"] == 100 and core["status"] == "succeeded"
        trace = episode.trace_json()
        (out / "pyo3.trace.jsonl").write_text(trace)
        (out / "pyo3.cameras.json").write_text(json.dumps(evidence))
        records, _ = verify_trace(trace)
    finally:
        rig.close()
        episode.close()

    addon = Path(os.environ["SIMFORGE_NATIVE_RUNTIME_ADDON"])
    completed = subprocess.run(["node", str(Path(__file__).with_name("episode_parity.mjs")),
                                str(addon), str(source), str(out)], check=True, capture_output=True, text=True)
    print(completed.stdout.strip())
    node_evidence = json.loads((out / "napi.cameras.json").read_text())
    node_records, node_digest = verify_trace((out / "napi.trace.jsonl").read_text())
    assert [row["scene"] for row in node_evidence] == [row["scene"] for row in evidence]
    assert [row["tS"] for row in node_evidence] == [row["tS"] for row in evidence]
    for receipt, trace_rows in ((evidence, records), (node_evidence, node_records)):
        for row, trace_row in zip(receipt, trace_rows[:-1], strict=True):
            cameras = trace_row["reset"]["observation"]["cameras"] if "reset" in trace_row else trace_row["cameras"]
            assert cameras["sceneStateDigest"] == hashlib.sha256(native.canonical_json(json.dumps(row["scene"])).encode()).hexdigest()
            assert [f["sha256"] for f in cameras["frames"]] == [f["sha256"] for f in row["frames"]]
            assert [f["digest"] for f in cameras["frames"]] == [f["digest"] for f in row["frames"]]
    for frame in node_evidence[0]["frames"]:
        if frame["pass"] != "rgb":
            continue
        raw = (out / f"napi.{frame['sensorId']}.rgb.raw").read_bytes()
        array = np.ndarray((frame["height"], frame["width"], 4), dtype=np.uint8,
                           buffer=raw, strides=(frame["rowStride"], 4, 1))
        Image.fromarray(array).save(out / f"napi.{frame['sensorId']}.png")
    pairs = [(a, b) for py_row, node_row in zip(evidence, node_evidence, strict=True)
             for a, b in zip(py_row["frames"], node_row["frames"], strict=True)]
    mismatches = sum(a["sha256"] != b["sha256"] for a, b in pairs)
    report = {"schema": "simforge.episode-camera-parity/v1", "simulationS": 10,
              "sceneDocuments": len(evidence), "sceneMismatches": 0, "framesCompared": len(pairs),
              "frameMismatches": mismatches, "frameMismatchRate": mismatches / len(pairs),
              "pyo3Digest": core["episodeDigest"], "napiDigest": node_digest,
              "rendererNondeterminism": None if not mismatches else
              "Real GPU RGB differs across renderer camera resets/processes. Both raw frame identities remain in each v2 trace; no cross-run RGB bit-determinism claim."}
    if not mismatches:
        assert core["episodeDigest"] == node_digest
    (out / "camera-parity.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report))
