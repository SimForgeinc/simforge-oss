// Stub model engine for model_run worker tests and demos: an HTTP process
// speaking the `simforge.policy-endpoint/v2` facade the open-loop executor
// invokes — `GET /healthz` (identity + capabilities) and `POST /invoke`
// (trajectories, reasoning, RNG provenance). Speaks exactly the `process` +
// `http-json` descriptor contract in app/lib/models/contracts.ts.
//
// It computes nothing: waypoints are a straight line at a fixed speed, so a
// test can assert wiring, refusals and metric plumbing without a GPU. It is a
// stub for OUR harness, never a substitute for a model in a product path —
// identity comes from the env so a run's registry identity check is exercised
// rather than bypassed.
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 0);
const family = process.env.SIMFORGE_STUB_FAMILY ?? "stub";
const revision = process.env.SIMFORGE_STUB_REVISION ?? "stub-revision";
const quant = process.env.SIMFORGE_STUB_QUANT ?? "none";
const checkpointDigest = process.env.SIMFORGE_STUB_DIGEST ?? "";
const requiredCameras = (process.env.SIMFORGE_STUB_CAMERAS ?? "0,1,2,6")
  .split(",")
  .filter((entry) => entry.trim())
  .map((entry) => Number(entry));
const variableCameras = process.env.SIMFORGE_STUB_CAMERAS_VARIABLE === "1";
const waypoints = Number(process.env.SIMFORGE_STUB_WAYPOINTS ?? 64);
const speedMps = Number(process.env.SIMFORGE_STUB_SPEED ?? 8);

const capabilities = {
  cameras: { required: requiredCameras, variable: variableCameras, default: requiredCameras, max: 7 },
  nav: false,
  vqa: process.env.SIMFORGE_STUB_VQA === "1",
  meta_actions: false,
  autolabel: false,
  grounding: false,
};

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function invoke(body) {
  const cameras = Array.isArray(body?.obs?.cameras) ? body.obs.cameras : [];
  const got = cameras.map((camera) => Number(camera.camera_id)).sort((a, b) => a - b);
  if (!variableCameras && requiredCameras.length > 0) {
    const wanted = [...requiredCameras].sort((a, b) => a - b);
    const same = got.length === wanted.length && wanted.every((id, index) => id === got[index]);
    if (!same) {
      return {
        status: 400,
        body: {
          ok: false,
          error: {
            code: "camera_set_violation",
            message: `requires cameras [${wanted.join(", ")}], got [${got.join(", ")}]`,
            detail: { required: wanted, got },
          },
        },
      };
    }
  }
  if (body?.task === "text") {
    if (!capabilities.vqa) {
      return { status: 400, body: { ok: false, error: { code: "unsupported_op", message: "this family has no text tasks" } } };
    }
    return {
      status: 200,
      body: {
        ok: true,
        result: {
          text: `stub answer for ${String(body?.params?.text_task ?? "vqa")}`,
          fields: null,
          timings: { total_ms: 1 },
          rng_provenance: { seed: body?.seed ?? 0, torch: "stub", quant },
        },
      },
    };
  }
  const points = [];
  for (let index = 1; index <= waypoints; index += 1) {
    points.push([speedMps * index * 0.1, 0, 0]);
  }
  return {
    status: 200,
    body: {
      ok: true,
      result: {
        trajectories: [points],
        rotations: null,
        horizon_s: waypoints * 0.1,
        dt_s: 0.1,
        frame: "ego@t0",
        reasoning: ["stub: constant-speed straight line"],
        timings: { total_ms: 1, inference_ms: 1 },
        vram: { peak_mib: 0 },
        rng_provenance: {
          seed: body?.seed ?? 0,
          torch: "stub",
          cuda: null,
          attn: "stub",
          quant,
          deterministic_algorithms: true,
        },
        model: { family, revision, quant, checkpoint_digest: checkpointDigest },
        echo: { index: body?.index ?? null, runId: body?.runId ?? null, cameras: got },
      },
    },
  };
}

const server = createServer((request, response) => {
  if (request.method === "GET" && (request.url === "/healthz" || request.url === "/capabilities")) {
    json(response, 200, {
      ok: true,
      status: "ok",
      loaded: true,
      warmed: true,
      family,
      revision,
      quant,
      checkpoint_digest: checkpointDigest,
      camera_profile: process.env.SIMFORGE_STUB_PROFILE ?? "alpamayo-4cam",
      capabilities,
      supports: capabilities.vqa ? ["act", "text"] : ["act"],
      horizon_s: waypoints * 0.1,
      dt_s: 0.1,
      num_history_steps: 16,
      num_frames_per_camera: 4,
    });
    return;
  }
  if (request.method === "POST" && (request.url === "/invoke" || request.url === "/text")) {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        json(response, 400, { ok: false, error: { code: "input_error", message: "invalid json" } });
        return;
      }
      const { status, body: payload } = invoke(body);
      json(response, status, payload);
    });
    return;
  }
  json(response, 404, { ok: false, error: { code: "input_error", message: "not_found" } });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`READY 127.0.0.1:${server.address().port}\n`);
});
