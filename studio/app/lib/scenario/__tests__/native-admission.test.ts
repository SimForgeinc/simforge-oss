import assert from "node:assert/strict";
import { test } from "node:test";

process.env.SIMFORGE_ENV = "dev";

import { loadBuiltinRenderEngine } from "@simforge-oss/render";
import { workerCanRun, type Candidate, type WorkerRow } from "../render-worker-control-store";

const GIB = 1024 ** 3;

const renderSpec = {
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
};

test("a native worker leaves a job whose measured map demand it cannot hold to a larger worker", async () => {
  const engine = await loadBuiltinRenderEngine("native", { engineVersion: "3".repeat(40), binary: "/nonexistent/simforge-render" });
  const worker = (gpuMiB: number, demand: unknown[] | null): WorkerRow => ({
    id: "w", registration_id: "r", worker_version: "3".repeat(40), image_digest: "sha256:" + "a".repeat(64),
    renderer_engine: "native", base_image_digest: null, base_image_platform_digest: null,
    capabilities: JSON.stringify(engine.capabilities), gpu_memory_mib: gpuMiB, hardware_profile: "rtx3080-10gb-v1",
    cache_demand: demand === null ? null : JSON.stringify(demand),
  });
  const candidate = (renderTextures: string): Candidate => ({
    id: "usrj_x", renderer_engine: "native", render_spec: renderSpec, intent_sha256: "0".repeat(64),
    resource_request: { estimatedGpuBytes: 32 * 1024 * 1024 },
    map_version_id: "usmap_belmont", render_textures: renderTextures,
  });
  const belmont = [
    { mapVersionId: "usmap_belmont", renderTextures: "uastc-full", sceneBytes: Math.round(6.4 * GIB), textureBytes: Math.round(5.1 * GIB) },
    { mapVersionId: "usmap_belmont", renderTextures: "bc7-512", sceneBytes: Math.round(0.9 * GIB), textureBytes: Math.round(0.3 * GIB) },
  ];
  assert.equal(workerCanRun(worker(10_240, null), candidate("uastc-full")), true, "unmeasured maps are admitted");
  assert.equal(workerCanRun(worker(10_240, belmont), candidate("bc7-512")), true);
  assert.equal(workerCanRun(worker(10_240, belmont), candidate("uastc-full")), true, "6.4 GB fits a 10 GB card with 1 GB headroom");
  assert.equal(workerCanRun(worker(6_144, belmont), candidate("uastc-full")), false, "a 6 GB card leaves it to a larger worker");
  assert.equal(workerCanRun(worker(6_144, belmont), candidate("bc7-512")), true);
});
