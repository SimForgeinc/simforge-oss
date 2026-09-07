"""HTTP facade over the same loaded engine as the socket endpoint.

Why a facade instead of a second engine: the model-run worker in
``studio/worker/model-run.ts`` speaks ``http-json`` and the registry's
endpoint descriptors model that transport. Teaching it MessagePack, or
running a second process that loads another 22-72 GB of weights, would both
be worse than exposing three JSON routes on the engine that is already
resident. Closed loop keeps the socket: raw multi-camera frames are tens of
megabytes per step and shared-memory bundles never cross HTTP.

Routes:

    GET  /healthz        engine identity + capabilities (also /capabilities)
    POST /invoke         one act/text item  (``simforge.policy-endpoint/v2``)
    POST /text           one text item (sugar for /invoke with task=text)

The server is single-threaded on purpose. One GPU serves one inference at a
time; accepting concurrent requests would only queue them inside CUDA while
making latency attribution impossible.
"""

from __future__ import annotations

import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

from simforge_alpamayo.invoke import error_response, handle_item

logger = logging.getLogger("simforge_alpamayo.http")

#: Frames arrive base64-encoded over HTTP; a 6-camera raw window is ~5 MB
#: before encoding. The cap is generous but finite so a malformed
#: content-length cannot exhaust memory.
MAX_BODY_BYTES = 256 * 1024 * 1024


class _Handler(BaseHTTPRequestHandler):
    server_version = "simforge-alpamayo/2"
    protocol_version = "HTTP/1.1"

    # -- plumbing -----------------------------------------------------------

    @property
    def engine(self):
        return self.server.engine  # type: ignore[attr-defined]

    @property
    def lock(self) -> threading.Lock:
        return self.server.inference_lock  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        logger.debug("%s - %s", self.address_string(), fmt % args)

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any] | None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._send(400, error_response("input_error", "invalid Content-Length"))
            return None
        if length <= 0:
            self._send(400, error_response("input_error", "empty request body"))
            return None
        if length > MAX_BODY_BYTES:
            self._send(
                413,
                error_response(
                    "input_error",
                    f"request body {length} exceeds {MAX_BODY_BYTES} bytes",
                ),
            )
            return None
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw)
        except json.JSONDecodeError as exc:
            self._send(400, error_response("input_error", f"invalid JSON: {exc}"))
            return None
        if not isinstance(body, dict):
            self._send(
                400, error_response("input_error", "request body must be a JSON object")
            )
            return None
        return body

    # -- routes -------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path in ("/healthz", "/capabilities", "/"):
            self._send(200, {"ok": True, **self.engine.info()})
            return
        self._send(404, error_response("input_error", f"no route {path}"))

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path not in ("/invoke", "/text"):
            self._send(404, error_response("input_error", f"no route {path}"))
            return
        body = self._read_json()
        if body is None:
            return
        if path == "/text":
            body = {**body, "task": "text"}
        # One GPU, one inference: serialize rather than letting CUDA queue
        # requests behind each other with unattributable latency.
        with self.lock:
            response = handle_item(self.engine, body)
        # A refusal is a 200 with ok:false — the caller records it per item.
        self._send(200, response)


class EngineHttpServer(HTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address: tuple[str, int], engine, lock: threading.Lock):
        super().__init__(address, _Handler)
        self.engine = engine
        self.inference_lock = lock


def parse_bind(spec: str) -> tuple[str, int]:
    """``"127.0.0.1:9000"`` or ``"9000"`` -> ``("127.0.0.1", 9000)``."""
    if ":" in spec:
        host, _, port = spec.rpartition(":")
        return (host or "127.0.0.1"), int(port)
    return "127.0.0.1", int(spec)


def serve_http(
    engine, bind: str, lock: threading.Lock | None = None
) -> tuple[EngineHttpServer, threading.Thread, int]:
    """Start the facade on a background thread.

    Returns ``(server, thread, port)``; ``port`` is resolved when the caller
    passed port 0, so a supervisor can read the real port from the READY line
    instead of guessing.
    """
    host, port = parse_bind(bind)
    server = EngineHttpServer((host, port), engine, lock or threading.Lock())
    bound_port = server.server_address[1]
    thread = threading.Thread(
        target=server.serve_forever,
        name="simforge-alpamayo-http",
        daemon=True,
        kwargs={"poll_interval": 0.2},
    )
    thread.start()
    logger.info("http facade listening on %s:%d", host, bound_port)
    return server, thread, bound_port
