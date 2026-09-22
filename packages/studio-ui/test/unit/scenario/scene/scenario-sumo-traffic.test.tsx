// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScenarioDocumentDto } from "../../../../src/lib/scenario/contracts";
import type { ScenarioMapOption } from "../../../../src/scenario/list/document-map-groups";
import type { ScenarioSession } from "../../../../src/scenario/scene/useScenarioSession";

const sumo = vi.hoisted(() => ({
  calls: [] as Array<{ enabled: boolean; mode: string; mapVersionId: string; signalPrograms?: unknown }>,
  status: { phase: "running", actorCount: 7 } as { phase: string; actorCount: number },
}));
vi.mock("../../../../src/lib/scenario/ambient/useSumoTraffic", () => ({
  useSumoTraffic: (options: { enabled: boolean; mode: string; map: { mapVersionId: string }; signalBook?: { programs: unknown } }) => {
    sumo.calls.push({ enabled: options.enabled, mode: options.mode, mapVersionId: options.map.mapVersionId, signalPrograms: options.signalBook?.programs });
    return sumo.status;
  },
}));
vi.mock("../../../../src/lib/scenario/parking/useParkedCars", () => ({
  useParkedCars: () => ({ cars: [] }),
  parkedCarOccupancySources: () => [],
}));
vi.mock("@simforge-oss/viewer", () => ({ indexedWorldHeightSampler: () => () => 0 }));
vi.mock("@simforge-oss/playback", async (original) => ({
  ...(await original<typeof import("@simforge-oss/playback")>()),
  createRestingHeading: () => ({}),
  applyRestingHeading: <T,>(actor: T) => actor,
}));

import { ScenarioSumoTraffic } from "../../../../src/scenario/scene/ScenarioSumoTraffic";

const ROOT = "/api/simforge/maps/usmap_1/browser-assets";
function map(sumoNetworkSha256: string | null): ScenarioMapOption {
  return {
    id: "usmap_1", versionId: "usmap_1", mapVersionId: "usmap_1", sourceMapId: "yale-street",
    label: "Yale Street", locality: "Palo Alto",
    browserAssetRootUrl: ROOT, browserManifestUrl: `${ROOT}/3d/manifest.json`, manifestUrl: `${ROOT}/3d/manifest.json`,
    browserClosureSha256: "c".repeat(64),
    artifacts: {
      xodrSha256: "1".repeat(64), topologySha256: "2".repeat(64), derivedTopologySha256: "3".repeat(64),
      locationsSha256: "4".repeat(64), signalsSha256: "5".repeat(64), lanePolygonsSha256: "6".repeat(64),
    },
    sumoNetworkSha256,
    topologyUrl: `${ROOT}/topology-index.json.gz`,
    derivedTopologyUrl: `${ROOT}/derived/topology-derived.json.gz`,
    locationsUrl: `${ROOT}/derived/locations.json.gz`,
    signalsUrl: `${ROOT}/signals.geojson.gz`,
  };
}

const PROGRAMS = [{ id: "signal:1", phases: [{ phase: "green", durationS: 10 }], stopLines: [] }];

function session(
  provider: "sumo" | "native",
  sumoNetworkSha256: string | null,
  options: { mapSignalPlans?: unknown[]; traceActorMetadata?: Record<string, { tags: string[] }> } = {},
) {
  const setSumoStatus = vi.fn();
  const document = {
    id: "doc_1",
    content: {
      roles: [], props: [], invariants: [], variants: [], mapSignalPlans: options.mapSignalPlans ?? [],
      extensions: { "studio.ambientTraffic.provider.v1": provider },
      choreography: { interactions: [], clipSeconds: 20, warmupSeconds: 0 },
    },
  } as unknown as ScenarioDocumentDto;
  const bundle = {
    actors: [], startTime: 0, endTime: 20,
    instance: { manifest: { inputHash: "input" }, input: { signalPrograms: PROGRAMS, roadControls: [] } },
    trace: { header: { dt: 0.02, clipSeconds: 20, warmupSeconds: 0, actorMetadata: options.traceActorMetadata ?? {} }, ticks: { signals: {} } },
  };
  const value = {
    map: map(sumoNetworkSha256),
    document,
    bundle,
    playback: {
      controller: null, inspecting: false, setInspecting: vi.fn(),
      sumoStatus: { phase: "disabled", actorCount: 0 }, setSumoStatus, overlays: null,
    },
    capture: { viewer: null, actorRenderer: null, loadedMapVersionId: "usmap_1" },
  } as unknown as ScenarioSession;
  return { value, setSumoStatus };
}

afterEach(() => {
  cleanup();
  sumo.calls.length = 0;
});

describe("editor SUMO host", () => {
  it("runs SUMO for a SUMO scenario on a map with a network and publishes its status", () => {
    const { value, setSumoStatus } = session("sumo", "a".repeat(64));
    render(<ScenarioSumoTraffic session={value} />);
    expect(sumo.calls.at(-1)).toEqual({ enabled: true, mode: "authoring", mapVersionId: "usmap_1", signalPrograms: PROGRAMS });
    expect(setSumoStatus).toHaveBeenCalledWith(sumo.status);
  });

  it("stays off without a SUMO network or when another provider is selected", () => {
    render(<ScenarioSumoTraffic session={session("sumo", null).value} />);
    expect(sumo.calls.at(-1)?.enabled).toBe(false);
    cleanup();
    render(<ScenarioSumoTraffic session={session("native", "a".repeat(64)).value} />);
    expect(sumo.calls.at(-1)?.enabled).toBe(false);
  });

  it("keeps running with authored map signal plans: SUMO obeys the compiled signal book", () => {
    render(<ScenarioSumoTraffic session={session("sumo", "a".repeat(64), { mapSignalPlans: [{ id: "plan" }] }).value} />);
    expect(sumo.calls.at(-1)).toMatchObject({ enabled: true, signalPrograms: PROGRAMS });
  });

  it("stands down when the loaded trace already carries the worker's SUMO traffic", () => {
    render(<ScenarioSumoTraffic session={session("sumo", "a".repeat(64), {
      traceActorMetadata: { "sumo-0badf00d": { tags: ["ambient", "catalog:vehicle.sedan", "sumo"] } },
    }).value} />);
    expect(sumo.calls.at(-1)?.enabled).toBe(false);
  });
});
