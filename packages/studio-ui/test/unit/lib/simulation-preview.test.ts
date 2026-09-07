import { beforeEach, describe, expect, it, vi } from "vitest";
import { contentHash, parseSimScenarioInput, TRACE_FORMAT_VERSION, type SimTrace } from "@simforge-oss/engine";
import { parsePlaybackPair } from "@simforge-oss/playback";

const artifact = vi.hoisted(() => ({ bytes: new Uint8Array() }));
vi.mock("../../../src/lib/scenario/artifact-cache", () => ({
  fetchContentAddressedArtifact: async () => artifact.bytes,
}));

import {
  downloadSimulationPreview,
  encodeSimulationPreview,
} from "../../../src/lib/scenario/playback/simulationPreview";

const ENGINE = { engineVersion: "0.6.0", abiVersion: 2 };
const MAP_CLOSURE = "a".repeat(64);
const RUNTIME = { engine: ENGINE, mapClosureSha256: MAP_CLOSURE };

function bundle() {
  const input = parseSimScenarioInput({
    mapId: "test-map",
    clipSeconds: 1,
    warmupSeconds: 0,
    dt: 0.2,
    seed: "preview-test",
    metricSubject: "ego",
    actors: [{
      id: "ego",
      kind: "vehicle",
      dims: { l: 4.8, w: 1.9, h: 1.5 },
      initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 10 },
      behavior: { route: { kind: "polyline", points: [{ x: 0, z: 0 }, { x: 20, z: 0 }] } },
    }],
  });
  const hash = contentHash(input);
  const trace: SimTrace = {
    header: {
      traceVersion: TRACE_FORMAT_VERSION,
      engineVersion: ENGINE.engineVersion,
      inputHash: hash,
      seed: "preview-test",
      mapId: "test-map",
      engineGraphDigest: "graph-digest",
      dt: 0.2,
      clipSeconds: 1,
      warmupSeconds: 0,
      frame: "xodr-local",
      actorIds: ["ego"],
      metricSubject: "ego",
      operationalConditions: input.operationalConditions,
      physics: { mode: "kinematic-v1", solver: "uniscenarios-sim-engine", solverVersion: "0.1.0", substepS: 0.2, vehicleProfileDigest: null },
    },
    ticks: {
      t: [0, 1],
      actors: {
        ego: { x: [0, 10], y: [0, 0], headingRad: [0, 0], speedMps: [10, 10], lateralOffsetM: [0, 0], laneRsl: [null, null], s: [0, 10], present: [1, 1] },
      },
    },
    events: [],
    metrics: { minTTC: null, minDistance: [], requiredDecelMax: { ego: 0 }, collisions: [], triggerNeverFired: [], clippedCriticality: false, ticksSimulated: 2 },
  };
  const instance = {
    kind: "scenario-instance",
    version: 1,
    manifest: { instanceId: "preview#1", inputHash: hash, replayKey: { mapId: "test-map", engineGraphDigest: "graph-digest" }, actors: [{ id: "ego" }] },
    input,
  };
  return parsePlaybackPair(instance, trace);
}

const descriptor = { artifactId: "usart", draftVersion: 7, sha256: "", sizeBytes: 0, mediaType: "", downloadUrl: "/preview", createdAt: "" };

describe("persisted simulation preview admission", () => {
  beforeEach(async () => {
    const encoded = await encodeSimulationPreview(bundle(), 7, RUNTIME);
    artifact.bytes = encoded.bytes;
  });

  it("replays a saved trace for the engine build, map closure and version that produced it", async () => {
    const saved = await downloadSimulationPreview(descriptor, RUNTIME);
    const genuine = bundle();
    expect(saved.trace).toEqual(genuine.trace);
    expect(saved.instance).toEqual(genuine.instance);
  });

  it("rejects a saved trace from another engine build even at the same schema and version", async () => {
    await expect(downloadSimulationPreview(descriptor, { ...RUNTIME, engine: { engineVersion: "0.6.1", abiVersion: 2 } }))
      .rejects.toThrow("different engine or map runtime");
    await expect(downloadSimulationPreview(descriptor, { ...RUNTIME, engine: { engineVersion: "0.6.0", abiVersion: 3 } }))
      .rejects.toThrow("different engine or map runtime");
  });

  it("rejects a saved trace executed on another immutable map closure", async () => {
    await expect(downloadSimulationPreview(descriptor, { ...RUNTIME, mapClosureSha256: "b".repeat(64) }))
      .rejects.toThrow("different engine or map runtime");
  });

  it("rejects a saved trace whose version no longer matches the scenario", async () => {
    await expect(downloadSimulationPreview({ ...descriptor, draftVersion: 8 }, RUNTIME))
      .rejects.toThrow("does not match this scenario version");
  });

  it("rejects a saved trace whose header names an engine other than the one recorded at save time", async () => {
    const genuine = bundle();
    const forged = { ...genuine, trace: { ...genuine.trace, header: { ...genuine.trace.header, engineVersion: "0.5.0" } } };
    artifact.bytes = (await encodeSimulationPreview(forged, 7, RUNTIME)).bytes;
    await expect(downloadSimulationPreview(descriptor, RUNTIME)).rejects.toThrow("executed by a different engine");
  });
});
