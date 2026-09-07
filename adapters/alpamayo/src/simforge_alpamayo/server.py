"""Unix-socket MessagePack policy endpoint, plus the optional HTTP facade.

Ops (request ``{"op": ..., ...}`` -> response ``{"ok": bool, ...}``):

    hello    -> engine identity, capabilities, camera profile, supports[]
    health   -> {"status": "ok"|"loading", "vram": {...}, "warmed": bool}
    warmup   {"cams": 4}  -> one synthetic act, returns timings/VRAM
    act      {"obs": {...}, "seed": int, "params": {...}} -> trajectory
    text     {"obs": {...}, "prompt": str, "task": ..., "params": {...}}
    reset    -> ack (stateless engine; provided for policy_step parity)
    close    -> closes this connection
    shutdown -> stops the server process

Run:

    python -m simforge_alpamayo.server --family alpamayo-1.5 --quant nf4 \
        --socket /tmp/simforge-alpamayo.sock --http 127.0.0.1:9310

The process prints one ``READY`` line on stdout once the engine is loaded and
every requested transport is bound; the model registry's endpoint descriptor
matches it with ``health: {kind: stdout, pattern: "^READY "}``.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import socket
import sys
import threading
import time
import traceback
from typing import Any

from simforge_alpamayo.families import FAMILY_IDS
from simforge_alpamayo.invoke import error_response, handle_item
from simforge_alpamayo.obs import ObservationError, synthetic_observation
from simforge_alpamayo.protocol import recv_msg, send_msg

logger = logging.getLogger("simforge_alpamayo.server")


class Server:
    def __init__(self, socket_path: str, engine, lock: threading.Lock | None = None):
        self.socket_path = socket_path
        self.engine = engine
        self.lock = lock or threading.Lock()
        self._running = True

    def warmup(self, cams: int | None = None, seed: int = 0) -> dict:
        """One synthetic act, to pay CUDA/compile costs before the episode.

        The synthetic input exists to measure latency and prove the wire; the
        trajectory it produces is discarded and is never an evaluation.
        """
        default = list(self.engine.spec.cameras.default)
        camera_ids = default if cams is None else None
        t0 = time.monotonic()
        obs = synthetic_observation(
            num_cameras=cams or len(default), camera_ids=camera_ids, seed=seed
        )
        with self.lock:
            result = self.engine.act(obs, seed=seed, num_traj_samples=1)
        self.engine.warmed = True
        return {
            "warmup_ms": (time.monotonic() - t0) * 1e3,
            "timings": result["timings"],
            "vram": result["vram"],
            "cameras": result["cameras"],
            "synthetic": True,
        }

    def handle(self, req: dict) -> tuple[dict, str]:
        """Returns ``(response, action)``; action in {"", "close", "shutdown"}."""
        op = req.get("op")
        if op == "hello":
            return {"ok": True, **self.engine.info()}, ""
        if op == "health":
            return {
                "ok": True,
                "status": "ok" if self.engine.model is not None else "loading",
                "warmed": self.engine.warmed,
                "family": self.engine.family,
                "revision": self.engine.spec.weights_revision,
                "quant": self.engine.quant,
                "checkpoint_digest": self.engine.checkpoint_digest,
                "vram": self.engine.vram(),
            }, ""
        if op == "warmup":
            cams = req.get("cams")
            return {
                "ok": True,
                **self.warmup(int(cams) if cams is not None else None),
            }, ""
        if op in ("act", "text"):
            item = {
                "task": op,
                "obs": req.get("obs"),
                "seed": req.get("seed", 0),
                "params": req.get("params") or {},
            }
            if op == "text":
                item["prompt"] = req.get("prompt")
                item["text_task"] = req.get("task") or "vqa"
            with self.lock:
                return handle_item(self.engine, item), ""
        if op == "capabilities":
            return {"ok": True, "capabilities": self.engine.capabilities()}, ""
        if op == "reset":
            return {"ok": True}, ""
        if op == "close":
            return {"ok": True}, "close"
        if op == "shutdown":
            return {"ok": True}, "shutdown"
        return error_response("unsupported_op", f"unknown op: {op}"), ""

    def serve(self) -> None:
        if os.path.exists(self.socket_path):
            os.unlink(self.socket_path)
        parent = os.path.dirname(os.path.abspath(self.socket_path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(self.socket_path)
        # The socket is a local control surface for this user's own engine.
        os.chmod(self.socket_path, 0o600)
        srv.listen(1)
        logger.info("listening on %s", self.socket_path)

        while self._running:
            conn, _ = srv.accept()
            try:
                while True:
                    req = recv_msg(conn)
                    if req is None:
                        break
                    try:
                        resp, action = self.handle(req)
                    except ObservationError as exc:
                        resp, action = {"ok": False, "error": exc.as_wire()}, ""
                    except Exception as exc:  # keep the service alive
                        logger.error("op failed: %s", exc)
                        traceback.print_exc()
                        resp, action = error_response("input_error", str(exc)), ""
                    send_msg(conn, resp)
                    if action == "close":
                        break
                    if action == "shutdown":
                        self._running = False
                        break
            finally:
                conn.close()
        srv.close()
        if os.path.exists(self.socket_path):
            os.unlink(self.socket_path)
        logger.info("server stopped")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--family", required=True, choices=list(FAMILY_IDS))
    parser.add_argument("--quant", default="bf16", choices=["bf16", "nf4", "fp8"])
    parser.add_argument("--socket", default=None,
                        help="unix socket path (default: skip the socket transport)")
    parser.add_argument("--http", default=None,
                        help="bind the HTTP facade, e.g. 127.0.0.1:9310 or 0.0.0.0:8000")
    parser.add_argument("--weights-dir", default=None,
                        help="local install directory (model store layout)")
    parser.add_argument("--sidecar-dir", default=None,
                        help="read-only directory holding sidecar config/tokenizer files")
    parser.add_argument("--checkpoint-digest", default=None,
                        help="expected checkpoint digest; refuses to start on mismatch")
    parser.add_argument("--diffusion-steps", type=int, default=None)
    parser.add_argument("--warmup-cams", type=int, default=0,
                        help="run a synthetic warmup act with N cameras after load (0=skip)")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()

    logging.basicConfig(
        level=args.log_level,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        stream=sys.stderr,
    )
    if not args.socket and not args.http:
        parser.error("at least one of --socket / --http is required")

    from simforge_alpamayo.engine import load_engine
    from simforge_alpamayo.preflight import verify_revision

    # Identity before weights: a digest mismatch must fail before the process
    # spends minutes loading the wrong checkpoint.
    identity = verify_revision(
        args.family,
        revision=None,
        expect_digest=args.checkpoint_digest,
        weights_dir=args.weights_dir,
    )

    engine = load_engine(
        args.family,
        quant=args.quant,
        device=args.device,
        weights_dir=args.weights_dir,
        sidecar_dir=args.sidecar_dir,
        checkpoint_digest=identity.get("digest_resolved") or args.checkpoint_digest,
        num_diffusion_steps=args.diffusion_steps,
        load=False,
    )

    def _stop(*_a):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    engine.load()
    logger.info("post-load VRAM: %s", engine.vram())

    lock = threading.Lock()
    http_port = None
    if args.http:
        from simforge_alpamayo.http_facade import serve_http

        _server, _thread, http_port = serve_http(engine, args.http, lock)

    server = Server(args.socket, engine, lock) if args.socket else None
    if args.warmup_cams:
        info = server.warmup(cams=args.warmup_cams) if server else None
        if info:
            logger.info("warmup: %.0f ms, VRAM %s", info["warmup_ms"], info["vram"])

    ready = {
        "family": engine.family,
        "quant": engine.quant,
        "revision": engine.spec.weights_revision,
        "checkpoint_digest": engine.checkpoint_digest,
        "socket": args.socket,
        "http": f"http://127.0.0.1:{http_port}" if http_port else None,
        "load_seconds": engine.load_seconds,
    }
    # The supervisor matches ^READY ; the JSON tail carries the resolved port.
    print(f"READY {args.socket or ''} {json.dumps(ready)}", flush=True)

    if server:
        server.serve()
    else:
        # HTTP-only: the facade runs on a daemon thread, so park here.
        try:
            while True:
                time.sleep(3600)
        except (KeyboardInterrupt, SystemExit):
            pass


if __name__ == "__main__":
    main()
