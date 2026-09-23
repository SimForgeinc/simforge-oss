import { describe, expect, it } from "vitest";

import {
  RENDER_DEFAULTS_EXTENSION_KEY,
  RENDER_SPEC_V3_SCHEMA,
  buildCanonicalRenderSpec,
  defaultDashCamera,
  type CanonicalRenderSpecInput,
  type ScenarioTemplateV2,
} from "../index.js";
import type { Environment } from "../schema/v2/environment.js";
import {
  EnvironmentExtensionError,
  LIGHTING_EXTENSION_KEY,
  SCENE_TIME_EXTENSION_KEY,
  parseRenderLightingOverrides,
  parseRenderSceneMinutes,
  resolveEditorLightingOverrides,
  sceneClockSunAngles,
} from "../studio-contracts/editor-environment-policy.js";

const BASE: Environment = { weather: "clear", timeOfDay: "noon", surfacePatches: [] };
const withBlock = (key: string, value: unknown): Environment => ({ ...BASE, extensions: { [key]: value } });

describe("render-side environment extensions", () => {
  it("read a current lighting block exactly, and no block as preset lighting", () => {
    expect(parseRenderLightingOverrides(BASE)).toEqual({});
    expect(parseRenderLightingOverrides(withBlock(LIGHTING_EXTENSION_KEY, { scaleRevision: 2, sun: 1.5, exposure: 0.5 })))
      .toEqual({ sun: 1.5, exposure: 0.5 });
  });

  it("refuse what the editor's lenient reading drops or clamps", () => {
    for (const block of [
      { sun: 1.5 },
      { scaleRevision: 1, sun: 1.5 },
      { scaleRevision: 2, sun: Number.NaN },
      { scaleRevision: 2, sun: "1.5" },
      { scaleRevision: 2, haze: 1.5 },
      { scaleRevision: 2, glow: 1 },
      [1, 2],
    ]) {
      // The editor keeps reading these as "no override" for display.
      expect(() => resolveEditorLightingOverrides(withBlock(LIGHTING_EXTENSION_KEY, block))).not.toThrow();
      expect(() => parseRenderLightingOverrides(withBlock(LIGHTING_EXTENSION_KEY, block)), JSON.stringify(block))
        .toThrow(EnvironmentExtensionError);
    }
  });

  it("read the scene clock, and refuse a clock block without finite minutes", () => {
    expect(parseRenderSceneMinutes(BASE)).toBeNull();
    expect(parseRenderSceneMinutes(withBlock(SCENE_TIME_EXTENSION_KEY, { minutes: 1500 }))).toBe(60);
    for (const block of [{ minutes: "noon" }, {}, 385, null]) {
      expect(() => parseRenderSceneMinutes(withBlock(SCENE_TIME_EXTENSION_KEY, block)), JSON.stringify(block))
        .toThrow(expect.objectContaining({ code: "environment_extension_invalid" }));
    }
  });

  it("derive the clock's display sun exactly as Studio writes it", () => {
    // studio-ui scene-time.ts sunAnglesForSceneMinutes(385).
    expect(sceneClockSunAngles(385)).toEqual({ azimuthDeg: 96.25, elevationDeg: 7.08 });
    expect(sceneClockSunAngles(0)).toEqual({ azimuthDeg: 0, elevationDeg: -12 });
  });
});

function content(renderDefaults?: unknown): ScenarioTemplateV2 {
  const camera = { ...defaultDashCamera({ class: "car" }), id: "front-camera" };
  return {
    scenarioVersion: 2,
    meta: { name: "Render", description: "", createdAt: "2026-08-18T00:00:00.000Z", modifiedAt: "2026-08-18T00:00:00.000Z", appVersion: "test", tags: [], negativeControl: false },
    params: { declarations: [], constraints: [] },
    environment: { weather: "clear", timeOfDay: "noon", surfacePatches: [] },
    anchor: { id: "anchor", corridor: {}, features: [], policy: {} },
    roles: [{ id: "ego", label: "Ego", actor: { sensors: [camera] } }],
    props: [],
    trafficControls: [],
    mapSignalPlans: [],
    choreography: { warmupSeconds: 0, clipSeconds: 10, interactions: [] },
    perception: {},
    invariants: [],
    variants: [],
    reasoningTrace: [],
    ...(renderDefaults ? { extensions: { [RENDER_DEFAULTS_EXTENSION_KEY]: renderDefaults } } : {}),
  } as unknown as ScenarioTemplateV2;
}

describe("canonical render spec capture", () => {
  const authoredCapture = {
    schema: RENDER_SPEC_V3_SCHEMA,
    sources: [{
      actorId: "ego", sensorId: "front-camera", outputName: "ego-front-camera-rgb", modality: "rgb",
      transform: { position: { x: 1, y: 1.4, z: 0 }, rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 } },
      attributes: { width: 1920, height: 1080, fps: 30, horizontalFovDeg: 90, nearM: 0.05, farM: 1000 },
    }],
    clip: { startSeconds: 0, endSeconds: 10 },
    artifacts: ["manifest"],
    capabilityIntent: { required: [], preferred: [], fidelity: "dataset" },
    authoredEnvironment: { weather: "clear", timeOfDay: "noon", surfacePatches: [] },
  };
  const input = (overrides: Partial<CanonicalRenderSpecInput> = {}): CanonicalRenderSpecInput => ({
    content: content(authoredCapture),
    selections: [{ actorId: "ego", sensorId: "front-camera", modalities: ["rgb"] }],
    clip: { startSeconds: 0, endSeconds: 10 },
    video: { width: 1280, height: 720, fps: 20, container: "mp4", codec: "h264", quality: "standard" },
    artifacts: ["video", "manifest"],
    staticSemantics: false,
    fidelity: "dataset",
    ...overrides,
  });
  const cameraAttributes = (spec: ReturnType<typeof buildCanonicalRenderSpec>) => (spec.sources[0] as { attributes: { width: number; height: number; fps: number } }).attributes;

  it("keeps each camera's authored capture when nothing explicit overrides it", () => {
    expect(cameraAttributes(buildCanonicalRenderSpec(input({ captureOverride: {} })))).toMatchObject({ width: 1920, height: 1080, fps: 30 });
  });

  it("applies exactly the capture fields the requester chose", () => {
    expect(cameraAttributes(buildCanonicalRenderSpec(input({ captureOverride: { fps: 20 } })))).toMatchObject({ width: 1920, height: 1080, fps: 20 });
    // The Studio wizard: its video format is the explicit choice.
    expect(cameraAttributes(buildCanonicalRenderSpec(input()))).toMatchObject({ width: 1280, height: 720, fps: 20 });
  });

  it("gives an unauthored camera the requested video size before the product default", () => {
    expect(cameraAttributes(buildCanonicalRenderSpec(input({ content: content(), captureOverride: {} })))).toMatchObject({ width: 1280, height: 720, fps: 20 });
  });
});
