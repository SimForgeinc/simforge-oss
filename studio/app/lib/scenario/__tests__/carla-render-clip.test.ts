import "../../models/__tests__/test-env";

import assert from "node:assert/strict";
import { test } from "node:test";

import type { RenderSpecV3 } from "@simforge-oss/scenario";

import { publicFailureDetail } from "../render/detail-store";
import { assertCarlaRenderClip } from "../render-intent-store";

function spec(clip: { startSeconds: number; endSeconds: number }, options: { fps?: number; physics?: boolean } = {}): RenderSpecV3 {
  const fps = options.fps ?? 24;
  return {
    schema: "simforge.render-spec/v3",
    sources: [{
      actorId: "ego", sensorId: "camera-front", outputName: "ego-camera-front-rgb",
      transform: { position: { x: 1, y: 2, z: 0 }, rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 } },
      modality: "rgb",
      attributes: { width: 1280, height: 720, fps, horizontalFovDeg: 90, nearM: 0.05, farM: 1000 },
    }],
    clip,
    video: { width: 1280, height: 720, fps, container: "mp4", codec: "h264", quality: "standard" },
    artifacts: ["manifest", "video"],
    capabilityIntent: {
      required: ["sensor.rgb", ...(options.physics ? ["actor.native_controls"] : [])],
      preferred: [],
      fidelity: "dataset",
    },
    authoredEnvironment: { weather: "clear", timeOfDay: "noon", surfacePatches: [] },
  } as unknown as RenderSpecV3;
}

/** The frozen clip of the dev job's scenario: 20 s. */
const carla = (renderSpec: RenderSpecV3): void => assertCarlaRenderClip(renderSpec, 20);

function refusal(run: () => void): { code: string; detail: string } {
  try {
    run();
  } catch (error) {
    return { code: (error as Error).message, detail: String((error as Error & { detail?: unknown }).detail) };
  }
  assert.fail("expected a submit-time refusal");
}

test("CARLA accepts a prefix of the clip, like the native engine (usrj_6258072eb5434ce682a9ff03)", () => {
  assert.doesNotThrow(() => carla(spec({ startSeconds: 0, endSeconds: 10 })));
  assert.doesNotThrow(() => carla(spec({ startSeconds: 0, endSeconds: 20 })));
  // Trace replay seeks, so a later window renders too.
  assert.doesNotThrow(() => carla(spec({ startSeconds: 2, endSeconds: 12 })));
  // Physics validation renders the whole clip.
  assert.doesNotThrow(() => carla(spec({ startSeconds: 0, endSeconds: 20 }, { physics: true })));
});

test("CARLA refuses at submit, with its reason, a clip it cannot render exactly", () => {
  for (const clip of [{ startSeconds: 2, endSeconds: 10 }, { startSeconds: 0, endSeconds: 10 }]) {
    const physics = refusal(() => carla(spec(clip, { physics: true })));
    assert.equal(physics.code, "carla_render_clip_physics_validation_partial");
    assert.match(physics.detail, /whole 20 s clip/);
  }
  const fractional = refusal(() => carla(spec({ startSeconds: 0, endSeconds: 10.01 })));
  assert.equal(fractional.code, "carla_render_clip_frame_count_fractional");
  assert.match(fractional.detail, /whole number of frames/);
  const short = refusal(() => carla(spec({ startSeconds: 1, endSeconds: 1.01 })));
  assert.equal(short.code, "carla_render_clip_too_short");
});

test("a crashed CARLA process's scrubbed stderr tail is the job's public failure detail", () => {
  const message = "CARLA renderer exited with code 1 without a failure record; last stderr lines:\nRuntimeError: tick barrier";
  assert.equal(publicFailureDetail("render.carla_process_failed", message), message);
  assert.equal(publicFailureDetail("render.carla_render_contract_violation", "renderSpec.clip is invalid"), "renderSpec.clip is invalid");
  // Uncoded worker messages stay redacted.
  assert.equal(publicFailureDetail("render.execution_failed", message), null);
});
