"""splat-render-service: the native render-service wire (protocol 5) over a NuRec splat background.

Separate-process host path. Requests/responses are the shapes of `renderer/service/src/proto.rs`
(u32-LE length-prefixed msgpack, `{i, op, ...}`); frames go into the shm bundle ring exactly as
`renderer/service/src/shm.rs` writes it, so every existing ring reader works unchanged. This is
a DECLARED HOST COPY: each pass is packed on the GPU and copied device->shm once per frame
(`hello.transport == "host-shm"`). Same-process consumers that want device tensors use
`simforge_splat.tensor.NuRecTensorSensor` instead; the device-stream ops of the wire are refused
here because the socket cannot carry that ownership.

Ops served: hello, load_scene_state, reset_cameras, render_bundle, close. Every other V5 op
(load, render, encode_jpeg, set_lighting, get_state, open/export/close_device_stream) is answered
with `ok: false` and the capability the splat backend lacks - never with a fabricated success.

  hello            -> {..., protocol: 5, profile: "splat", transport, capabilities, renderer, determinism}
                      optional {shm: name} opens a per-connection ring `<shm>-<name>`
  load_scene_state {states: [scene-state.v1...]} : one mapId per stream; frame 0 becomes resident
  render_bundle    {sim_tick, cameras?, tick_index?, passes?}; cameras[].projection (f-theta),
                   cameras[].output {width, height, format: rgb8 | rgba8}
                   -> {sim_tick, frame: FrameIdentity, bundle_offset, bundle_len, frames, device: {},
                       visibility?, sourceEvidence, server_ms}
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import socket
import struct
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import msgpack
import torch

from . import __version__
from .backend import CapabilityError, HoodProfile, SplatBackend, SplatSession, TickRender, parse_passes, ring_planes
from .protocol import PASSES, PROTOCOL_VERSION, RGB_OUTPUT_FORMATS, UNSUPPORTED_OPS
from .protocol import SERVICE_TRANSPORT as TRANSPORT
from .ring import FORMAT_TAGS, RingWriter

log = logging.getLogger("simforge_splat")


def _source_package(value: str) -> tuple[str, Path]:
    digest, separator, location = value.partition("=")
    if not separator or not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise argparse.ArgumentTypeError("expected SHA256=ABSOLUTE_PATH with lowercase SHA256")
    path = Path(location)
    if not path.is_absolute() or not path.is_file():
        raise argparse.ArgumentTypeError(f"source package must be an absolute file path: {location}")
    return digest, path


# ----------------------------------------------------------------------------------
@dataclass
class Connection:
    ring: RingWriter
    ring_owned: bool
    session: SplatSession = field(default_factory=SplatSession)
    last_visibility: dict[str, list[dict]] | None = None  # per-camera visible set of the last render (id pass)
    last_source_evidence: dict[str, Any] | None = None


class SplatService:
    def __init__(self, args):
        self.args = args
        self.backend = SplatBackend(
            args.scenes_root, args.catalog, hood=HoodProfile.parse(args.hood_dir), device="cuda",
            verify_digest=not args.skip_digest, source_packages=args.source_packages, max_scenes=args.max_scenes,
            determinism=args.determinism,
        )
        self.shared_ring = RingWriter(args.shm, int(args.shm_size_mb) * 1024 * 1024)

    def capabilities(self) -> dict[str, Any]:
        return {
            "transport": TRANSPORT,
            "hostCopy": "one GPU->shm copy per published pass; no intermediate host buffers",
            "passes": list(PASSES),
            "rgbOutputFormats": list(RGB_OUTPUT_FORMATS),
            "deviceStreams": False,
            "inProcessTensorPath": "simforge_splat.tensor.NuRecTensorSensor",
            "unsupported": dict(UNSUPPORTED_OPS),
            "sensors": "cameras calibrated in the package only; no lidar/radar",
        }

    # -- wire ---------------------------------------------------------------------
    def serve(self) -> None:
        path = self.args.socket
        if os.path.exists(path):
            os.unlink(path)
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(path)
        srv.listen(64)
        print(f"splat-render-service v{__version__} listening on {path} (protocol {PROTOCOL_VERSION}, transport {TRANSPORT}, build {self.backend.build}, 3dgut {self.backend.config_sha})", flush=True)
        while True:
            conn, _ = srv.accept()
            threading.Thread(target=self._connection, args=(conn,), daemon=True).start()

    def _connection(self, sock: socket.socket) -> None:
        state = Connection(ring=self.shared_ring, ring_owned=False)
        try:
            while True:
                head = self._recv(sock, 4)
                if head is None:
                    return
                (n,) = struct.unpack("<I", head)
                body = self._recv(sock, n)
                if body is None:
                    return
                req = msgpack.unpackb(body, raw=False)
                try:
                    resp = self.dispatch(state, req)
                except Exception as e:  # noqa: BLE001 - every error must reach the client
                    if not isinstance(e, (CapabilityError, ValueError)):
                        log.exception("op %s failed", req.get("op"))
                    resp = {"i": req.get("i"), "op": "error", "ok": False, "error": f"{type(e).__name__}: {e}"}
                payload = msgpack.packb(resp, use_bin_type=True)
                sock.sendall(struct.pack("<I", len(payload)) + payload)
                if req.get("op") == "close":
                    return
        finally:
            if state.ring_owned:
                state.ring.close()
            sock.close()

    @staticmethod
    def _recv(sock: socket.socket, n: int) -> bytes | None:
        chunks = []
        while n > 0:
            chunk = sock.recv(min(n, 1 << 20))
            if not chunk:
                return None
            chunks.append(chunk)
            n -= len(chunk)
        return b"".join(chunks)

    def dispatch(self, st: Connection, req: dict[str, Any]) -> dict[str, Any]:
        op = req.get("op")
        i = req.get("i")
        if op == "hello":
            name = req.get("shm")
            if name:
                path = f"{self.args.shm}-{name}"
                if st.ring_owned:
                    st.ring.close()
                st.ring = RingWriter(path, int(self.args.shm_size_mb) * 1024 * 1024)
                st.ring_owned = True
            return {
                "i": i, "op": "hello", "ok": True, "protocol": PROTOCOL_VERSION, "profile": "splat",
                "legend_entries": 0,
                "shm": {"path": str(st.ring.path), "size_bytes": st.ring.capacity, "meta_bytes": 4096},
                "transport": TRANSPORT,
                "capabilities": self.capabilities(),
                "renderer": self.backend.renderer_info(),
                "determinism": self.backend.determinism,
            }
        if op == "load_scene_state":
            states = req.get("states") or []
            map_id = st.session.load_scene_state(states)
            self.backend.scene_for(map_id)
            return {"i": i, "op": "load_scene_state", "ok": True, "ticks": len(states), "map_id": map_id}
        if op == "reset_cameras":
            st.session.reset_cameras()
            return {"i": i, "op": "reset_cameras", "ok": True}
        if op == "render_bundle":
            if req.get("lidars") or req.get("radars"):
                raise CapabilityError("render_bundle: lidar/radar sensors are not served by the splat backend (camera-only)")
            if req.get("device_sensors"):
                raise CapabilityError(f"render_bundle: device_sensors {UNSUPPORTED_OPS['open_device_stream']}")
            if req.get("cameras") is not None:
                st.session.set_cameras(list(req["cameras"]))
            if req.get("tick_index") is not None:
                st.session.apply_tick(int(req["tick_index"]))
            passes = parse_passes(req.get("passes"))
            sim_tick = int(req["sim_tick"])
            t0 = time.perf_counter()
            tick = self.backend.render_tick(st.session, sim_tick, passes)
            frames, offset, length = self.publish(st.ring, tick)
            st.last_visibility = tick.visibility
            st.last_source_evidence = tick.source_evidence
            return {"i": i, "op": "render_bundle", "ok": True, "sim_tick": sim_tick,
                    "frame": tick.identity.wire(),
                    "bundle_offset": offset, "bundle_len": length, "frames": frames,
                    "device": {},
                    **({"visibility": tick.visibility} if tick.visibility else {}),
                    "sourceEvidence": tick.source_evidence,
                    "server_ms": (time.perf_counter() - t0) * 1000.0}
        if op == "close":
            return {"i": i, "op": "close", "ok": True}
        if op in UNSUPPORTED_OPS:
            raise CapabilityError(f"{op}: {UNSUPPORTED_OPS[op]}")
        raise ValueError(f"unknown op {op!r}")

    # -- host publication -----------------------------------------------------------
    def publish(self, ring: RingWriter, tick: TickRender) -> tuple[list[dict[str, Any]], int, int]:
        """Pack every pass on the GPU into its ring layout and copy device->shm once per frame."""
        sim_tick = tick.identity.sim_tick
        start_cursor = ring.cursor_total
        entries = [self._publish_tensor(ring, p.sensor_id, p.pass_, p.width, p.height, p.format, sim_tick, p.data)
                   for cam in tick.cameras for p in ring_planes(cam, tick.passes)]
        if ring.cursor_total - start_cursor > ring.usable:
            raise ValueError(f"render_bundle: bundle ({ring.cursor_total - start_cursor} bytes) exceeds ring capacity ({ring.usable} usable); raise --shm-size-mb")
        frames = [{"sensorId": e.sensor_id, "pass": e.pass_, "offset": e.record_offset, "len": e.payload_len,
                   "width": e.width, "height": e.height, "format": e.fmt, "tickId": sim_tick, "digest": f"{e.digest:08x}"}
                  for e in entries]
        offset, length = ring.publish_bundle(sim_tick, start_cursor, entries)
        return frames, offset, length

    @staticmethod
    def _publish_tensor(ring: RingWriter, sensor_id: str, pass_: str, width: int, height: int, fmt: str, tick: int, t: torch.Tensor):
        """One device->shm copy per frame (no intermediate host buffers); CRC over the ring bytes."""
        t = t.contiguous()
        n = t.numel() * t.element_size()
        off = ring.reserve(sensor_id, pass_, width, height, FORMAT_TAGS[fmt], tick, n)
        host = torch.frombuffer(ring.payload_view(off, n), dtype=t.dtype, count=t.numel())
        host.copy_(t.reshape(-1))
        return ring.entry_for(sensor_id, pass_, off, n, width, height, fmt)


def main() -> None:
    ap = argparse.ArgumentParser(description=f"SimForge splat render service (native lane, protocol {PROTOCOL_VERSION}, host shm transport)", allow_abbrev=False)
    ap.add_argument("--socket", required=True)
    ap.add_argument("--shm", required=True, help="ring path; per-connection rings are '<shm>-<name>'")
    ap.add_argument("--shm-size-mb", type=int, default=256)
    ap.add_argument("--scenes-root", required=True, help="directory of imported scene bundles (<mapId>/background.json)")
    ap.add_argument("--source-package", action="append", type=_source_package, default=[], metavar="SHA256=ABSOLUTE_PATH", help="explicit local package location bound to its pinned SHA256 (repeatable; bytes always verified)")
    ap.add_argument("--catalog", action="append", required=True, metavar="ROOT", help="catalog root with GLB models (repeatable, e.g. <repo>/catalog/vehicles-carla); injected actors need an explicit catalogId found here")
    ap.add_argument("--max-scenes", type=int, default=12)
    ap.add_argument("--hood-dir", required=True, metavar="DIR|none", help="ego-hood overlay profile: a directory of <cameraId>.png (its name is stamped into every frame's evidence) or the literal 'none'; there is no default")
    ap.add_argument("--skip-digest", action="store_true", help="skip the volume.nurec digest check at load (dev only)")
    ap.add_argument("--determinism", default="schedule-and-structure", choices=["schedule-and-structure", "byte-identical-pixels"])
    args = ap.parse_args()
    args.source_packages = {}
    for digest, path in args.source_package:
        if digest in args.source_packages:
            ap.error(f"duplicate source package SHA256: {digest}")
        args.source_packages[digest] = path
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    SplatService(args).serve()


if __name__ == "__main__":
    main()
