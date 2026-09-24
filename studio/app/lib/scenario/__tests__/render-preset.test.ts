import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SIMFORGE_ENV = "dev";

import { CONTROL_FEATURE_INTENT_RENDER_REQUEST, loadBuiltinRenderEngine } from "@simforge-oss/render";
import { RenderIntentV1Schema } from "@simforge-oss/scenario";
import { workerCanRun, type Candidate, type WorkerRow } from "../render-worker-control-store";
import { RenderRequestInvalidError, resolveRenderRequest } from "../render-preset";
import { SubmitScenarioRenderIntentSchema } from "../render-wire-contracts";

function issuesOf(engine: string, render: Record<string, unknown> | undefined) {
  try {
    resolveRenderRequest(engine, render);
    return [];
  } catch (error) {
    assert.ok(error instanceof RenderRequestInvalidError, String(error));
    return error.issues;
  }
}

test("the submit API accepts render.preset and render.set on the wire; their content is checked by the resolver", () => {
  const submission = SubmitScenarioRenderIntentSchema.innerType().shape.render;
  assert.equal(submission.safeParse({ preset: "training", set: { "shadows.cascades": 2 } }).success, true);
  assert.equal(submission.safeParse(undefined).success, true);
});

test("no render, or an explicit showcase with no overrides, resolves to showcase and leaves the intent unchanged", () => {
  for (const render of [undefined, {}, { preset: "showcase" }, { preset: "showcase", set: {} }]) {
    const resolved = resolveRenderRequest("native", render);
    assert.equal(resolved?.preset, "showcase");
    assert.equal(resolved?.intent, undefined, JSON.stringify(render));
  }
});

test("training and overrides are pinned into the intent", () => {
  assert.deepEqual(resolveRenderRequest("native", { preset: "training" })?.intent, { preset: "training" });
  assert.deepEqual(
    resolveRenderRequest("native", { set: { "shadows.cascades": 2, "aa.mode": "fxaa" } })?.intent,
    { preset: "showcase", set: { "shadows.cascades": 2, "aa.mode": "fxaa" } },
  );
});

test("an unknown key, an invalid value, an unknown preset or a key the platform cannot honor is a clear refusal", () => {
  assert.deepEqual(issuesOf("native", { preset: "cinematic" }).map((issue) => issue.code), ["native_render_preset_unknown"]);
  const unknown = issuesOf("native", { set: { "shadows.cascadez": 2 } });
  assert.equal(unknown[0]?.code, "native_render_config_unknown_key");
  assert.match(unknown[0]!.message, /"shadows\.cascadez" is not a render config key/);
  const invalid = issuesOf("native", { set: { "shadows.cascades": 9 } });
  assert.equal(invalid[0]?.code, "native_render_config_invalid");
  assert.match(invalid[0]!.message, /shadows\.cascades 9 is invalid \(an integer in 1\.\.=4\)/);
  assert.equal(issuesOf("native", { set: { "textures.tier": "bc7-512" } })[0]?.code, "render_request_unsupported");
  assert.equal(issuesOf("native", { set: { "output.video.codec": "hevc" } })[0]?.code, "render_request_unsupported");
  assert.equal(issuesOf("native", { geometryLod: "off" })[0]?.key, "render.geometryLod");
  assert.equal(issuesOf("native", { set: ["shadows.cascades=2"] })[0]?.key, "set");
  assert.equal(issuesOf("carla", { preset: "training" })[0]?.code, "render_request_unsupported");
  assert.equal(resolveRenderRequest("carla", undefined), null);
  // Every issue at once, not just the first.
  assert.equal(issuesOf("native", { preset: "fast", set: { nope: 1, "aa.mode": "msaa" } }).length, 3);
});

test("a pinned request is a valid RenderIntentV1.render (what the worker parses and hashes)", () => {
  const render = resolveRenderRequest("native", { preset: "training", set: { "ssr.enabled": false, "shadows.cascades": 2 } })!.intent!;
  assert.equal(RenderIntentV1Schema.shape.render.safeParse(render).success, true);
});

test("lease screen: an intent that carries render goes only to a worker that announced intent.render-request", async () => {
  const engine = await loadBuiltinRenderEngine("native", { engineVersion: "3".repeat(40), binary: "/nonexistent/simforge-render" });
  const worker = (intentFeatures: string | null): WorkerRow => ({
    id: "w", registration_id: "r", worker_version: "3".repeat(40), image_digest: "sha256:" + "a".repeat(64),
    renderer_engine: "native", base_image_digest: null, base_image_platform_digest: null,
    capabilities: JSON.stringify(engine.capabilities), gpu_memory_mib: 16_384, hardware_profile: "rtx5080-16gb-v1",
    cache_demand: null, intent_features: intentFeatures,
  });
  const candidate = (render: unknown): Candidate => ({
    id: "usrj_x", renderer_engine: "native", intent_sha256: "0".repeat(64),
    resource_request: { estimatedGpuBytes: 32 * 1024 * 1024 },
    render_spec: {
      schema: "simforge.render-spec/v3",
      sources: [{
        actorId: "ego", sensorId: "front", outputName: "ego-front", modality: "rgb",
        transform: { position: { x: 1.6, y: 1.35, z: 0 }, rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 } },
        attributes: { width: 1280, height: 720, fps: 24, horizontalFovDeg: 90, nearM: 0.1, farM: 1000 },
      }],
      clip: { startSeconds: 0, endSeconds: 3 },
      video: { width: 1280, height: 720, fps: 24, container: "mp4", codec: "h264", quality: "standard" },
      artifacts: ["manifest", "video"],
      capabilityIntent: { required: ["sensor.rgb", "artifact.manifest", "artifact.video", "timing.fixed_step"], preferred: [], fidelity: "review" },
      authoredEnvironment: { weather: "clear", timeOfDay: "noon", surfacePatches: [] },
    },
    render_request: render,
  });
  const rc75 = worker(null);
  const current = worker(CONTROL_FEATURE_INTENT_RENDER_REQUEST);
  assert.equal(workerCanRun(rc75, candidate(null)), true, "a default job still runs on an rc.75 worker");
  assert.equal(workerCanRun(rc75, candidate({ preset: "training" })), false, "an rc.75 worker is never leased a training job");
  assert.equal(workerCanRun(rc75, candidate(JSON.stringify({ preset: "training" }))), false, "jsonb as text too");
  assert.equal(workerCanRun(current, candidate({ preset: "training" })), true);
  assert.equal(workerCanRun(current, candidate(null)), true);
});

test("CPU lane: a Studio worker that did not announce intent.render-request is offered only intents without render", async () => {
  const { localNativeRenderCandidateLeg } = await import("../jobs/local-native-render-store");
  assert.match(localNativeRenderCandidateLeg(new Set()), /render_intent->'render' IS NULL/);
  assert.doesNotMatch(localNativeRenderCandidateLeg(new Set([CONTROL_FEATURE_INTENT_RENDER_REQUEST])), /render_intent->'render'/);
});
