import { beforeEach, describe, expect, it, vi } from "vitest";
import { contentHash, parseSimScenarioInput, TRACE_FORMAT_VERSION, type SimTrace } from "@simforge-oss/engine";
import { parsePlaybackPair } from "@simforge-oss/playback";
import type { ScenarioSimulationResultDto } from "@simforge-oss/studio-host";

const artifacts = vi.hoisted(() => ({ byName: new Map<string, Uint8Array>(), calls: [] as Array<{ sha256: string; cacheKey?: string }> }));
vi.mock("../../../src/lib/scenario/artifact-cache", () => ({
  fetchContentAddressedArtifact: async (_url: string, descriptor: { sha256: string; cacheKey?: string }) => {
    artifacts.calls.push(descriptor);
    const bytes = artifacts.byName.get(descriptor.sha256);
    if (!bytes) throw new Error(`no artifact ${descriptor.sha256}`);
    return bytes;
  },
}));

import {
  authoritativePlaybackBundle,
  comparableTraceSha256,
} from "../../../src/lib/scenario/playback/authoritativeSimulation";

const AMBIENT = { profileHash: "p".repeat(64), baseInputHash: "b".repeat(64), generatedInputHash: "", actors: [], warnings: [] };

function scenario(speedMps = 10) {
  const input = parseSimScenarioInput({
    mapId: "test-map",
    clipSeconds: 1,
    warmupSeconds: 0,
    dt: 0.2,
    seed: "authoritative-test",
    metricSubject: "ego",
    actors: [{
      id: "ego",
      kind: "vehicle",
      dims: { l: 4.8, w: 1.9, h: 1.5 },
      initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps },
      behavior: { route: { kind: "polyline", points: [{ x: 0, z: 0 }, { x: 20, z: 0 }] } },
    }],
  });
  const hash = contentHash(input);
  const trace: SimTrace = {
    header: {
      traceVersion: TRACE_FORMAT_VERSION,
      engineVersion: "0.8.0",
      inputHash: hash,
      seed: "authoritative-test",
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
        ego: { x: [0, speedMps], y: [0, 0], headingRad: [0, 0], speedMps: [speedMps, speedMps], lateralOffsetM: [0, 0], laneRsl: [null, null], s: [0, speedMps], present: [1, 1] },
      },
    },
    events: [],
    metrics: { minTTC: null, minDistance: [], requiredDecelMax: { ego: 0 }, collisions: [], triggerNeverFired: [], clippedCriticality: false, ticksSimulated: 2 },
  } as SimTrace;
  const manifest = { instanceId: "authoritative#1", replayKey: { mapId: "test-map", engineGraphDigest: "graph-digest" }, actors: [{ id: "ego" }] };
  return { input, trace, manifest };
}

async function gzip(value: unknown): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}

function result(overrides: Partial<ScenarioSimulationResultDto> = {}): ScenarioSimulationResultDto {
  return {
    simKey: "k".repeat(64),
    traceSha256: "t".repeat(64),
    authoredTraceSha256: "t".repeat(64),
    engineSemVer: "0.8.0",
    solverVer: "0.8.0",
    traceSchema: "simforge.trace/v4",
    resolvedInputDigest: "i".repeat(64),
    mapClosureDigest: "m".repeat(64),
    mapVersionId: "usmap_1",
    trafficProvider: "off",
    trace: { mediaType: "application/vnd.simforge.trace+json+gzip", sizeBytes: 1, gzipSha256: "g".repeat(64), downloadUrl: "/trace" },
    resolution: { sizeBytes: 1, sha256: "r".repeat(64), downloadUrl: "/resolution" },
    timelineSha256: null,
    timelineSizeBytes: null,
    producer: "inline:test",
    createdAt: "now",
    ...overrides,
  };
}

describe("authoritative playback", () => {
  beforeEach(() => {
    artifacts.byName.clear();
    artifacts.calls.length = 0;
  });

  it("fetches the trace from the cache under its traceSha256 and replays it on the local instance of the same input", async () => {
    const { input, trace, manifest } = scenario();
    artifacts.byName.set("g".repeat(64), await gzip(trace));
    const local = parsePlaybackPair({ kind: "scenario-instance", version: 1, manifest: { ...manifest, inputHash: contentHash(input) }, input }, trace);
    const bundle = await authoritativePlaybackBundle(result(), local);
    expect(artifacts.calls).toEqual([expect.objectContaining({ sha256: "g".repeat(64), cacheKey: `trace/${"t".repeat(64)}` })]);
    expect(bundle.trace).toEqual(local.trace);
    expect(bundle.traceSha256).toBe("t".repeat(64));
  });

  it("rebuilds the instance from the resolution record when the local preview ran a different input", async () => {
    const authority = scenario(12);
    const localRun = scenario(10);
    artifacts.byName.set("g".repeat(64), await gzip(authority.trace));
    artifacts.byName.set("r".repeat(64), await gzip({
      contract: "simforge.sim-resolution/v1",
      resolvedInput: authority.input,
      materialization: authority.manifest,
      ambientTraffic: AMBIENT,
    }));
    const local = parsePlaybackPair({ kind: "scenario-instance", version: 1, manifest: { ...localRun.manifest, inputHash: contentHash(localRun.input) }, input: localRun.input }, localRun.trace);
    const bundle = await authoritativePlaybackBundle(result(), local);
    expect(bundle.instance.input).toEqual(authority.input);
    expect(bundle.trace.ticks.actors["ego"]!.speedMps[0]).toBe(12);
  });

  it("compares SUMO documents against the authored trace their preview runs", () => {
    expect(comparableTraceSha256(result())).toEqual(["t".repeat(64)]);
    expect(comparableTraceSha256(result({ trafficProvider: "sumo", authoredTraceSha256: "a".repeat(64) })))
      .toEqual(["a".repeat(64), "t".repeat(64)]);
  });
});
