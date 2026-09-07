"""Blocking client for the simforge-alpamayo socket endpoint, plus a CLI.

Importable without torch: the closed-loop policy in ``adapters/gym`` uses
this class from a process that never loads a model.

    python -m simforge_alpamayo.client --socket /tmp/simforge-alpamayo.sock \
        --cams 4 --seed 42

The CLI runs a synthetic observation, which exists to prove the wire and
measure latency. Its trajectory is not an evaluation of anything and the
output says so.
"""

from __future__ import annotations

import argparse
import json
import socket
import time
from typing import Any

from simforge_alpamayo.protocol import recv_msg, send_msg


class PolicyEndpointError(RuntimeError):
    """A typed refusal from the endpoint (``ok: false``).

    ``code`` is one of ``camera_set_invalid``, ``missing_fields``,
    ``unsupported_op``, ``input_error``, ``engine_not_loaded``. Callers that
    want to record a refusal per item rather than abort should catch this and
    read ``code``/``detail``.
    """

    def __init__(self, code: str, message: str, detail: dict[str, Any] | None = None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.detail = detail or {}


class AlpamayoClient:
    def __init__(
        self,
        socket_path: str = "/tmp/simforge-alpamayo.sock",
        timeout: float = 600.0,
    ):
        self.socket_path = socket_path
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(timeout)
        self.sock.connect(socket_path)

    def call(self, req: dict[str, Any]) -> dict[str, Any]:
        """One request/response round trip; returns the raw response map."""
        send_msg(self.sock, req)
        resp = recv_msg(self.sock)
        if resp is None:
            raise ConnectionError("server closed connection")
        return resp

    def _result(self, resp: dict[str, Any]) -> dict[str, Any]:
        if resp.get("ok"):
            return resp.get("result", resp)
        error = resp.get("error")
        if isinstance(error, dict):
            raise PolicyEndpointError(
                error.get("code", "input_error"),
                error.get("message", "endpoint refused the request"),
                {
                    key: value
                    for key, value in error.items()
                    if key not in ("code", "message")
                },
            )
        raise PolicyEndpointError("input_error", str(error))

    def hello(self) -> dict:
        """Engine identity and capabilities.

        Includes ``capabilities.cameras.{required,variable,default,max}`` and
        ``camera_profile`` so a caller can reject a rig mismatch before an
        episode starts rather than at step 0.
        """
        return self.call({"op": "hello"})

    def health(self) -> dict:
        return self.call({"op": "health"})

    def capabilities(self) -> dict:
        return self.hello().get("capabilities", {})

    def warmup(self, cams: int | None = None) -> dict:
        req: dict[str, Any] = {"op": "warmup"}
        if cams is not None:
            req["cams"] = cams
        return self.call(req)

    def act(self, obs: dict, seed: int = 0, **params) -> dict:
        """One trajectory step. Raises :class:`PolicyEndpointError` on refusal."""
        return self._result(
            self.call({"op": "act", "obs": obs, "seed": seed, "params": params})
        )

    def text(
        self,
        obs: dict,
        prompt: str | None = None,
        task: str = "vqa",
        seed: int = 0,
        **params,
    ) -> dict:
        """One text task. Families without one raise ``unsupported_op``."""
        return self._result(
            self.call(
                {
                    "op": "text",
                    "obs": obs,
                    "prompt": prompt,
                    "task": task,
                    "seed": seed,
                    "params": params,
                }
            )
        )

    def reset(self) -> dict:
        return self.call({"op": "reset"})

    def close(self) -> None:
        try:
            self.call({"op": "close"})
        except (OSError, ConnectionError):
            pass
        finally:
            self.sock.close()

    def __enter__(self) -> "AlpamayoClient":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()


def main() -> None:
    from simforge_alpamayo.obs import PROFILE_CAMERAS, synthetic_observation

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", default="/tmp/simforge-alpamayo.sock")
    parser.add_argument("--cams", type=int, default=None,
                        choices=sorted(PROFILE_CAMERAS),
                        help="synthetic camera count (default: the family's own set)")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--samples", type=int, default=1)
    parser.add_argument("--prompt", default=None,
                        help="run the text op with this question instead of act")
    parser.add_argument("--task", default="vqa")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    client = AlpamayoClient(args.socket)
    hello = client.hello()
    caps = hello.get("capabilities", {})
    cams = args.cams or len(caps.get("cameras", {}).get("default") or [2])
    camera_ids = None if args.cams else caps.get("cameras", {}).get("default")

    print(
        f"family={hello.get('family')} quant={hello.get('quant')} "
        f"revision={hello.get('revision')} digest={hello.get('checkpoint_digest')}"
    )
    print(f"supports={hello.get('supports')} cameras={caps.get('cameras')}")

    obs = synthetic_observation(num_cameras=cams, camera_ids=camera_ids, seed=args.seed)
    t0 = time.monotonic()
    try:
        if args.prompt:
            result = client.text(obs, prompt=args.prompt, task=args.task, seed=args.seed)
        else:
            result = client.act(obs, seed=args.seed, num_traj_samples=args.samples)
    except PolicyEndpointError as exc:
        print(json.dumps({"ok": False, "code": exc.code, "message": exc.message,
                          "detail": exc.detail}))
        raise SystemExit(2) from None
    wall_ms = (time.monotonic() - t0) * 1e3

    if args.json:
        print(json.dumps(result))
    elif args.prompt:
        print(f"text[{args.task}] wall={wall_ms:.0f}ms")
        print("answer:", (result.get("text") or "")[:800])
        print("fields:", json.dumps(result.get("fields")))
    else:
        traj = result["trajectories"][0]
        print(f"act[{cams}cam] wall={wall_ms:.0f}ms server={result['timings']}")
        print(f"trajectory: {len(result['trajectories'])} sample(s) x {len(traj)} waypoints")
        print("  first 3 wp:", [[round(v, 3) for v in wp] for wp in traj[:3]])
        print("  last  wp  :", [round(v, 3) for v in traj[-1]])
        reasoning = result.get("reasoning") or [None]
        print("reasoning[0]:", (reasoning[0] or "")[:400])
        print("vram:", json.dumps(result.get("vram")))
        print("rng_provenance:", json.dumps(result.get("rng_provenance")))
    print(
        "NOTE: the input was synthetic; this measures the wire and latency, "
        "not model accuracy."
    )
    client.close()


if __name__ == "__main__":
    main()
