"""Loopback-only Studio decision service using the same pooled SDK and planner."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from types import SimpleNamespace
from . import policy as C
from .client import pooled_client
from .driver import JevDriver
from .scene import observation, track_record, set_visibility_coverage
from .safety import generate


def scene_from_request(data):
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


def serve(port=8766):
    with pooled_client() as client:
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass  # No request bodies or credentials in access logs.

            def respond(self, status, data):
                payload = json.dumps(data, allow_nan=False).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self):
                self.respond(200, C.browser_contract()) if self.path == "/contract" else self.respond(404, {"error": "not_found"})

            def do_POST(self):
                if self.path != "/decision":
                    self.respond(404, {"error": "not_found"})
                    return
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 100000:
                    self.respond(413, {"error": "invalid_body_size"})
                    return
                try:
                    data = json.loads(self.rfile.read(length))
                    scene = scene_from_request(data)
                    feasible, rejected = generate(scene, candidate_family=C.COOPERATIVE.candidate_family)
                    driver = JevDriver(data["actor_id"], C.COOPERATIVE,
                                       SimpleNamespace(debug_counts={"visible_objects": len(scene["objects"]),
                                                                    "omitted_occluded_objects": data.get("omitted_occluded_objects", 0)}), client)
                    decision = driver.decide(scene, feasible)
                    points = feasible[decision.chosen_maneuver].points.tolist() if decision.chosen_maneuver in feasible else None
                    self.respond(200, {**decision.record, "rejected": rejected, "points": points})
                except (KeyError, ValueError, TypeError, OverflowError):
                    self.respond(400, {"error": "invalid_scene"})
        server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        print(f"Jev decision service ready on 127.0.0.1:{port}", flush=True)
        server.serve_forever()
