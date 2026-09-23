"""Loopback-only Jev decision service for Studio and the native drive bench.

The service owns the pooled TypeSafe SDK client and deterministic candidate/safety
logic. Clients send a scene-observation/v2 JSON document; no image or raw pedal
wire is accepted here.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
import json
from pathlib import Path
import math
from threading import Lock
from types import SimpleNamespace
from . import policy as C
from .client import pooled_client
from .driver import JevDriver
from .scene import observation, track_record, set_visibility_coverage
from .safety import generate
from simforge_policy_endpoint import capabilities, receipt
import socketserver
import struct
import msgpack

_REQUIRED_V2 = (
    "schema_version", "seq", "state_time_s", "last_observed_time_s", "frame",
    "provider", "capabilities", "uncertainty_layout", "calibration", "ego",
    "route", "coverage", "objects",
)
_REQUIRED_OBJECT = (
    "track_id", "x_m", "y_m", "range_m", "bearing_rad", "range_rate_mps",
    "existence_probability", "position_cov_m2", "velocity_cov_m2ps2", "source",
    "uncertainty_source", "measurement_age_s", "state_time_s", "last_observed_time_s",
)
_REQUIRED_ROUTE = ("centerline_m", "width_m", "speed_limit_mps", "required_stop_m", "source", "complete")
_REQUIRED_COVERAGE = (
    "radius_m", "complete", "omitted_objects", "measurement_age_s", "unknown_regions_m",
    "untracked_occupied_regions_m", "observed_free_regions_m", "frame", "vertical_bounds_m",
    "state_time_s", "source", "geometry",
)


def load_typesafe_env():
    """Load only KEY=value pairs from the supported credential file."""
    if os.environ.get("TYPESAFE_API_KEY"):
        return
    path = Path.home() / ".config" / "typesafe" / "env"
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return
    for line in lines:
        text = line.strip()
        if text.startswith("export "):
            text = text[7:].lstrip()
        key, separator, value = text.partition("=")
        if separator and key.strip() == "TYPESAFE_API_KEY":
            value = value.strip().strip("\"'")
            if value:
                os.environ["TYPESAFE_API_KEY"] = value
            return


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _vec2(value):
    return isinstance(value, list) and len(value) == 2 and all(_finite(v) for v in value)


def _regions(value):
    return value is None or (isinstance(value, list) and len(value) <= C.MAX_UNKNOWN_REGIONS
                             and all(isinstance(r, list) and len(r) == 4 and all(_finite(v) for v in r) for r in value))


def _covariance(value):
    return value is None or (isinstance(value, list) and len(value) == 3 and all(_finite(v) for v in value))


def validate_scene_v2(scene):
    """Reject malformed v2 at the service boundary before candidate generation."""
    if not isinstance(scene, dict) or any(key not in scene for key in _REQUIRED_V2):
        raise ValueError("scene_observation_v2_missing_field")
    if scene["schema_version"] != C.CURVED_SCHEMA_VERSION or scene["frame"] != "ego-flu":
        raise ValueError("scene_observation_v2_version_or_frame")
    if not isinstance(scene["seq"], int) or isinstance(scene["seq"], bool) or scene["seq"] < 0:
        raise ValueError("scene_observation_v2_seq")
    if not _finite(scene["state_time_s"]) or not _finite(scene["last_observed_time_s"]):
        raise ValueError("scene_observation_v2_time")
    for key in ("provider", "capabilities", "uncertainty_layout", "calibration", "ego", "route", "coverage"):
        if not isinstance(scene[key], dict):
            raise ValueError("scene_observation_v2_object:" + key)
    ego = scene["ego"]
    for key in ("speed_mps", "accel_mps2", "length_m", "width_m", "longitudinal_velocity_mps", "longitudinal_velocity_source"):
        if key not in ego:
            raise ValueError("scene_observation_v2_ego_missing:" + key)
    if not all(_finite(ego[key]) for key in ("speed_mps", "accel_mps2", "length_m", "width_m")):
        raise ValueError("scene_observation_v2_ego_numeric")
    if ego["longitudinal_velocity_mps"] is not None and not _finite(ego["longitudinal_velocity_mps"]):
        raise ValueError("scene_observation_v2_ego_direction")
    route = scene["route"]
    if any(key not in route for key in _REQUIRED_ROUTE) or not isinstance(route["centerline_m"], list) or len(route["centerline_m"]) < 2:
        raise ValueError("scene_observation_v2_route_missing")
    if not all(_vec2(point) for point in route["centerline_m"]):
        raise ValueError("scene_observation_v2_route_points")
    if not _finite(route["width_m"]) or (route["speed_limit_mps"] is not None and not _finite(route["speed_limit_mps"])):
        raise ValueError("scene_observation_v2_route_numeric")
    coverage = scene["coverage"]
    if any(key not in coverage for key in _REQUIRED_COVERAGE):
        raise ValueError("scene_observation_v2_coverage_missing")
    if not _finite(coverage["radius_m"]) or not isinstance(coverage["omitted_objects"], int) or coverage["omitted_objects"] < 0:
        raise ValueError("scene_observation_v2_coverage_numeric")
    if not _regions(coverage["unknown_regions_m"]) or not _regions(coverage["untracked_occupied_regions_m"]):
        raise ValueError("scene_observation_v2_coverage_regions")
    objects = scene["objects"]
    if not isinstance(objects, list) or len(objects) > C.MAX_OBJECTS:
        raise ValueError("scene_observation_v2_objects_count")
    for obj in objects:
        if not isinstance(obj, dict) or any(key not in obj for key in _REQUIRED_OBJECT):
            raise ValueError("scene_observation_v2_object_missing")
        if not isinstance(obj["track_id"], str) or len(obj["track_id"]) > C.MAX_TRACK_ID_CHARS:
            raise ValueError("scene_observation_v2_track_id")
        numeric = ("x_m", "y_m", "range_m", "bearing_rad", "measurement_age_s", "state_time_s", "last_observed_time_s")
        if not all(_finite(obj[key]) for key in numeric) or not _covariance(obj["position_cov_m2"]) or not _covariance(obj["velocity_cov_m2ps2"]):
            raise ValueError("scene_observation_v2_object_numeric")
        for key in ("range_rate_mps", "rel_vx_mps", "rel_vy_mps", "heading_rad", "length_m", "width_m"):
            if obj.get(key) is not None and not _finite(obj[key]):
                raise ValueError("scene_observation_v2_object_optional_numeric")
    return scene


def scene_from_request(data):
    """Keep the Studio's established request shape as a compatibility path."""
    ego, route = data["ego"], data["route"]
    objects = [track_record(o["track_id"], o.get("class"), o["x_m"], o["y_m"], o["rel_vx_mps"], o["rel_vy_mps"],
                            o["heading_rad"], o["length_m"], o["width_m"], "studio-visible-box-sensor", 0.0)
               for o in data["objects"]]
    scene = observation(data["seq"], data["time_s"], {"name": "studio-visible-boxes", "version": "1", "kind": "ground_truth"},
                        ego["speed_mps"], ego["accel_mps2"], [ego["length_m"], ego["width_m"]], route, objects)
    scene["schema_version"] = C.CURVED_SCHEMA_VERSION
    scene["ego"].update(longitudinal_velocity_mps=ego["speed_mps"], longitudinal_velocity_source="native-forward-drive",
                        cruise_speed_mps=ego["cruise_speed_mps"])
    set_visibility_coverage(scene, data.get("static_obbs_m_rad", []))
    C.validate_capabilities(scene["capabilities"])
    return scene


def scene_from_payload(data):
    if not isinstance(data, dict):
        raise ValueError("invalid_scene_payload")
    candidate = data.get("scene", data)
    if isinstance(candidate, dict) and candidate.get("schema_version") == C.CURVED_SCHEMA_VERSION:
        scene = validate_scene_v2(candidate)
        # Visible actors are already gated by the native adapter. Recompute the
        # conservative shadows from only those visible boxes and supplied static
        # map OBBs; hidden truth never crosses this boundary.
        set_visibility_coverage(scene, data.get("static_obbs_m_rad", []))
        C.validate_capabilities(scene["capabilities"])
        return scene
    return scene_from_request(data)


def serve(port=8766, socket_path=None):
    load_typesafe_env()
    with pooled_client() as client:
        stats = {"requests": 0, "api_calls": 0, "schema_v2": 0, "schema_violations": 0}
        stats_lock = Lock()
        contract = {**C.browser_contract(), **capabilities(cameras=False, ego_steps=1, camera_frames=0,
                    horizon_s=C.PLAN_HORIZON_S, hz=1 / C.PLAN_SAMPLE_S), "schemaVersion": C.CURVED_SCHEMA_VERSION,
                    "family": "jev", "transport": "unix-msgpack" if socket_path else "http-loopback"}

        def decide(data):
            with stats_lock:
                stats["requests"] += 1
            scene = scene_from_payload(data)
            if scene.get("schema_version") == C.CURVED_SCHEMA_VERSION:
                with stats_lock:
                    stats["schema_v2"] += 1
            feasible, rejected = generate(scene, candidate_family=C.COOPERATIVE.candidate_family)
            driver = JevDriver(data.get("actor_id", "ego"), C.COOPERATIVE,
                               SimpleNamespace(debug_counts={"visible_objects": len(scene["objects"]),
                                                            "omitted_occluded_objects": data.get("omitted_occluded_objects", 0)}), client)
            decision = driver.decide(scene, feasible)
            api_call = decision.record["api_latency_ms"] is not None
            with stats_lock:
                if api_call:
                    stats["api_calls"] += 1
                api_call_count = stats["api_calls"]
            points = feasible[decision.chosen_maneuver].points.tolist() if decision.chosen_maneuver in feasible else None
            return {**decision.record,
                    **receipt(data.get("observation", data), points, horizon_s=C.PLAN_HORIZON_S, fallback=decision.record.get("fallback_reason")),
                    "rejected": rejected, "points": points, "feasible": list(feasible), "api_call": api_call,
                    "api_call_count": api_call_count, "scene_validated": True, "schema_version": scene["schema_version"]}

        if socket_path:
            class SocketHandler(socketserver.StreamRequestHandler):
                def handle(self):
                    while True:
                        header = self.rfile.read(4)
                        if len(header) != 4:
                            return
                        length = struct.unpack("<I", header)[0]
                        if not 0 < length <= 200000:
                            return
                        payload = self.rfile.read(length)
                        if len(payload) != length:
                            return
                        try:
                            request = msgpack.unpackb(payload, raw=False)
                            op = request.get("op")
                            if op == "hello":
                                result = contract
                            elif op == "act":
                                result = decide({**request["obs"], "seed": request.get("seed", 0)})
                            else:
                                raise ValueError("supported operations: hello, act")
                            response = {"ok": True, "result": result}
                        except (KeyError, ValueError, TypeError, OverflowError) as error:
                            with stats_lock:
                                stats["schema_violations"] += 1
                            response = {"ok": False, "error": str(error)}
                        encoded = msgpack.packb(response, use_bin_type=True)
                        self.wfile.write(struct.pack("<I", len(encoded)) + encoded)
                        self.wfile.flush()

            class SocketServer(socketserver.ThreadingUnixStreamServer):
                daemon_threads = True

            target = Path(socket_path)
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                raise FileExistsError(f"refusing to replace existing socket {target}")
            try:
                with SocketServer(str(target), SocketHandler) as server:
                    print(f"READY socket={target} family=jev", flush=True)
                    server.serve_forever()
            finally:
                target.unlink(missing_ok=True)
            return

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def respond(self, status, data):
                payload = json.dumps(data, allow_nan=False).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self):
                if self.path == "/contract":
                    self.respond(200, contract)
                elif self.path == "/stats":
                    with stats_lock:
                        self.respond(200, dict(stats))
                else:
                    self.respond(404, {"error": "not_found"})

            def do_POST(self):
                if self.path != "/decision":
                    self.respond(404, {"error": "not_found"})
                    return
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 200000:
                    self.respond(413, {"error": "invalid_body_size"})
                    return
                try:
                    self.respond(200, decide(json.loads(self.rfile.read(length))))
                except (KeyError, ValueError, TypeError, OverflowError, json.JSONDecodeError):
                    with stats_lock:
                        stats["schema_violations"] += 1
                    self.respond(400, {"error": "invalid_scene"})

        server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        actual_port = server.server_address[1]
        print(f"Jev decision service ready on 127.0.0.1:{actual_port}", flush=True)
        print(f"READY http=127.0.0.1:{actual_port} family=jev", flush=True)
        server.serve_forever()
