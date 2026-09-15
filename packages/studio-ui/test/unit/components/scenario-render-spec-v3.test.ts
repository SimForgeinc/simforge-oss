import { describe, expect, it } from "vitest";
import {
  RENDER_DEFAULTS_EXTENSION_KEY,
  defaultDashCamera,
  defaultLidar,
  defaultRadar,
  type ScenarioTemplateV2,
} from "@simforge-oss/scenario";
import { buildCanonicalRenderSpec, type CanonicalRenderSpecInput } from "@simforge-oss/scenario";

function contentWithTwoCameras(): ScenarioTemplateV2 {
  const content = contentWithCamera() as unknown as {
    roles: { actor: { sensors: unknown[] } }[];
  };
  const front = content.roles[0]!.actor.sensors[0]!;
  content.roles[0]!.actor.sensors = [
    front,
    { ...(front as object), id: "rear-camera", label: "Rear camera" },
  ];
  return content as unknown as ScenarioTemplateV2;
}
function contentWithCamera(): ScenarioTemplateV2 {
  const camera = { ...defaultDashCamera({ class: "car" }), id: "front-camera", label: "Front camera" };
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
  } as unknown as ScenarioTemplateV2;
}

function input(): CanonicalRenderSpecInput {
  return {
    content: contentWithCamera(),
    selections: [{ actorId: "ego", sensorId: "front-camera", modalities: ["rgb", "depth", "instance"] }],
    clip: { startSeconds: 0, endSeconds: 10 },
    video: { width: 1280, height: 720, fps: 24, container: "webm", codec: "vp9", quality: "standard" },
    artifacts: ["video", "manifest", "frames", "sensorArchive"],
    staticSemantics: false,
    fidelity: "dataset",
  };
}

describe("canonical render spec v3 authoring", () => {
  it("builds the selected modalities into one validated v3 document", () => {
    const spec = buildCanonicalRenderSpec(input());
    expect(spec.schema).toBe("simforge.render-spec/v3");
    expect(spec.sources.map((source) => [source.sensorId, source.modality])).toEqual([
      ["front-camera", "rgb"],
      ["front-camera", "depth"],
      ["front-camera", "instance"],
    ]);
    expect(spec.artifacts).toEqual(["manifest", "video", "frames", "sensorArchive"]);
  });

  it("produces byte-identical documents for browser and CARLA worker execution", () => {
    const authored = input();
    const browser = buildCanonicalRenderSpec(authored);
    const carla = buildCanonicalRenderSpec(authored);
    expect(JSON.stringify(browser)).toBe(JSON.stringify(carla));
  });

  it("renders the draft's authored environment unless the intent overrides it", () => {
    const authored = buildCanonicalRenderSpec(input());
    expect(authored.authoredEnvironment).toMatchObject({ weather: "clear", timeOfDay: "noon" });

    const overridden = buildCanonicalRenderSpec({
      ...input(),
      environment: { weather: "heavy_rain", timeOfDay: "night", surfacePatches: [] } as CanonicalRenderSpecInput["environment"],
    });
    expect(overridden.authoredEnvironment).toMatchObject({ weather: "heavy_rain", timeOfDay: "night" });
    // The override is intent-only: the draft handed in is untouched.
    expect(input().content.environment).toMatchObject({ weather: "clear", timeOfDay: "noon" });
  });

  it("captures only the requested clip window, not the whole authored scenario", () => {
    const spec = buildCanonicalRenderSpec({ ...input(), clip: { startSeconds: 0, endSeconds: 5 } });
    expect(spec.clip).toEqual({ startSeconds: 0, endSeconds: 5 });
  });

  it("requires map.static_semantics only when the map advertises it and semantic is selected", () => {
    const authored = input();
    const semantic = buildCanonicalRenderSpec({
      ...authored,
      selections: [{ actorId: "ego", sensorId: "front-camera", modalities: ["rgb", "semantic"] }],
      staticSemantics: true,
    });
    expect(semantic.capabilityIntent.required).toContain("map.static_semantics");
  });

  it("captures each selected camera as its own uniquely named source", () => {
    /**
     * The cameras step opens with every authored camera captured, so two RGB cameras are the
     * default shape of a two-camera scenario. Every source is addressed by `outputName`
     * downstream (`render-intent.ts` maps host sensors by it), so two cameras must survive
     * selection as two distinctly named sources.
     */
    const twoCameras = buildCanonicalRenderSpec({
      ...input(),
      selections: [
        { actorId: "ego", sensorId: "front-camera", modalities: ["rgb"] },
        { actorId: "ego", sensorId: "rear-camera", modalities: ["rgb"] },
      ],
      content: contentWithTwoCameras(),
    });

    expect(twoCameras.sources.map((source) => [source.sensorId, source.modality])).toEqual([
      ["front-camera", "rgb"],
      ["rear-camera", "rgb"],
    ]);
    expect(new Set(twoCameras.sources.map((source) => source.outputName)).size)
      .toBe(twoCameras.sources.length);
  });

  it("keeps client-authored sensor videos out of managed-worker requirements", () => {
    const authored = input();
    const lidar = { ...defaultLidar({ class: "car" }), id: "roof-lidar" };
    const radar = { ...defaultRadar({ class: "car" }), id: "front-radar" };
    const content = structuredClone(authored.content);
    content.roles[0]!.actor.sensors.push(lidar, radar);
    const spec = buildCanonicalRenderSpec({
      ...authored,
      content,
      selections: [
        { actorId: "ego", sensorId: lidar.id, modalities: ["lidar"] },
        { actorId: "ego", sensorId: radar.id, modalities: ["radar"] },
      ],
    });

    expect(spec.capabilityIntent.required).not.toContain("artifact.sensor_video");

    const archiveOnly = buildCanonicalRenderSpec({
      ...authored,
      content,
      video: null,
      artifacts: authored.artifacts.filter((artifact) => artifact !== "video"),
      selections: [{ actorId: "ego", sensorId: lidar.id, modalities: ["lidar"] }],
    });
    expect(archiveOnly.capabilityIntent.required).not.toContain("artifact.sensor_video");
  });

  it("starts from the scenario's authored capture defaults and lets an explicit video format win", () => {
    const authored = input();
    const lidar = { ...defaultLidar({ class: "car" }), id: "roof-lidar" };
    const content = structuredClone(authored.content);
    content.roles[0]!.actor.sensors.push(lidar);
    const camera = content.roles[0]!.actor.sensors[0]!;
    content.extensions = {
      [RENDER_DEFAULTS_EXTENSION_KEY]: {
        schema: "simforge.render-spec/v3",
        sources: [
          {
            actorId: "ego", sensorId: "front-camera", outputName: "ego-front-camera-rgb", modality: "rgb",
            transform: camera.mount,
            attributes: { width: 1920, height: 1208, fps: 30, horizontalFovDeg: 90, nearM: 0.05, farM: 1000 },
          },
          {
            actorId: "ego", sensorId: "roof-lidar", outputName: "ego-roof-lidar-lidar", modality: "lidar",
            transform: lidar.mount,
            attributes: { channels: 128, rangeM: 250, pointsPerSecond: 1_310_720, rotationFrequencyHz: 10, upperFovDeg: 20, lowerFovDeg: -20 },
          },
        ],
        clip: { startSeconds: 0, endSeconds: 10 },
        artifacts: ["manifest"],
        capabilityIntent: { required: [], preferred: [], fidelity: "dataset" },
        authoredEnvironment: content.environment,
      },
    };
    const selections: CanonicalRenderSpecInput["selections"] = [
      { actorId: "ego", sensorId: "front-camera", modalities: ["rgb"] },
      { actorId: "ego", sensorId: "roof-lidar", modalities: ["lidar"] },
    ];
    const fromDefaults = buildCanonicalRenderSpec({
      ...authored, content, selections, video: null, artifacts: ["manifest", "sensorArchive"],
    });
    expect(fromDefaults.sources[0]!.attributes).toMatchObject({ width: 1920, height: 1208, fps: 30 });
    expect(fromDefaults.sources[1]!.attributes).toMatchObject({ channels: 128, pointsPerSecond: 1_310_720, rotationFrequencyHz: 10 });

    const overridden = buildCanonicalRenderSpec({ ...authored, content, selections });
    expect(overridden.sources[0]!.attributes).toMatchObject({ width: 1280, height: 720, fps: 24 });
    expect(overridden.sources[1]!.attributes).toMatchObject({ channels: 128 });
  });
});
