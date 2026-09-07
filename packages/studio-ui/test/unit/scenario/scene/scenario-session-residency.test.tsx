// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioHostServices } from "@simforge-oss/studio-host";
import { StudioHostProvider } from "../../../../src/host";
import type { ScenarioDocumentDto } from "../../../../src/lib/scenario/contracts";
import type { ScenarioMapOption } from "../../../../src/scenario/list/document-map-groups";

const worker = vi.hoisted(() => ({
  prepare: vi.fn(),
  cancel: vi.fn(),
  dispose: vi.fn(),
  engineIdentity: vi.fn(async () => ({ engineVersion: "0.6.0", abiVersion: 2 })),
}));
vi.mock("../../../../src/lib/scenario/playback/scenarioWorkerClient", () => ({
  ScenarioWorkerClient: class {
    prepare = worker.prepare;
    cancel = worker.cancel;
    dispose = worker.dispose;
    engineIdentity = worker.engineIdentity;
  },
}));
vi.mock("../../../../src/lib/scenario/playback/usePlayback", () => ({
  usePlayback: () => ({ controller: null, state: null, error: null }),
}));
vi.mock("../../../../src/lib/scenario/useMapSignalOverlays", () => ({ useMapSignalOverlays: () => null }));
vi.mock("../../../../src/lib/scenario/ambient/sumoAssets", () => ({ loadSumoAssets: async () => ({}) }));
vi.mock("../../../../src/scenario/scene/mapCatalog", () => ({
  pickRandomMap: () => null,
  preloadMapManifests: async () => 0,
}));
vi.mock("@simforge-oss/viewer", () => ({ indexedWorldHeightSampler: () => () => null }));
vi.mock("../../../../src/lib/scenario/playback/simulationPreview", () => ({
  encodeSimulationPreview: async () => ({ bytes: new Uint8Array([1]), sha256: "f".repeat(64) }),
  downloadSimulationPreview: async () => { throw new Error("no saved preview in this test"); },
}));

import { useScenarioSession } from "../../../../src/scenario/scene/useScenarioSession";

const ROOT = "/api/simforge/maps/usmap_1/browser-assets";
const MAP: ScenarioMapOption = {
  id: "usmap_1",
  versionId: "usmap_1",
  mapVersionId: "usmap_1",
  sourceMapId: "source-map-1",
  label: "Test city",
  locality: "Test",
  browserAssetRootUrl: ROOT,
  browserManifestUrl: `${ROOT}/3d/manifest.json`,
  manifestUrl: `${ROOT}/3d/manifest.json`,
  browserClosureSha256: "c".repeat(64),
  artifacts: {
    xodrSha256: "1".repeat(64),
    topologySha256: "2".repeat(64),
    derivedTopologySha256: "3".repeat(64),
    locationsSha256: "4".repeat(64),
    signalsSha256: "5".repeat(64),
    lanePolygonsSha256: "6".repeat(64),
  },
  sumoNetworkSha256: null,
  topologyUrl: `${ROOT}/topology-index.json.gz`,
  derivedTopologyUrl: `${ROOT}/derived/topology-derived.json.gz`,
  locationsUrl: `${ROOT}/derived/locations.json.gz`,
  signalsUrl: `${ROOT}/signals.geojson.gz`,
};

function template(clipSeconds: number) {
  return {
    roles: [],
    props: [],
    invariants: [],
    variants: [],
    mapSignalPlans: [],
    extensions: {},
    choreography: { interactions: [], clipSeconds, warmupSeconds: 0 },
  };
}

function documentAt(draftVersion: number, clipSeconds = 20): ScenarioDocumentDto {
  // Only the fields the session reads; the DTO's remaining metadata is inert here.
  const record = {
    id: "doc_1",
    title: "Doc",
    draftVersion,
    mapVersionId: MAP.mapVersionId,
    content: template(clipSeconds),
  };
  return record as unknown as ScenarioDocumentDto;
}

function fakeBundle(tag: string) {
  return { tag, actors: [], instance: { manifest: { inputHash: tag } } };
}

function host(initial: ScenarioDocumentDto) {
  const saveSimulationPreview = vi.fn(async () => undefined);
  const services = {
    artifacts: { listMaps: async () => [MAP] },
    projects: {
      getDocument: async () => initial,
      getSimulationPreview: async () => null,
      saveSimulationPreview,
    },
  };
  // The hook touches only these services; the rest of the host surface is unused.
  return { services: services as unknown as StudioHostServices, saveSimulationPreview };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("scenario session trace residency", () => {
  it("keeps the compiled trace across an autosave echo and a list/editor mode change, and persists it once the content is saved", async () => {
    const { services, saveSimulationPreview } = host(documentAt(1));
    worker.prepare.mockImplementation(async () => fakeBundle("v1"));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StudioHostProvider host={services}>{children}</StudioHostProvider>
    );
    const rendered = renderHook(
      ({ listPresentationActive }: { listPresentationActive: boolean }) => useScenarioSession({
        documentId: "doc_1",
        listPresentationActive,
        viewer: null,
        actorRenderer: null,
        loadedMapVersionId: null,
      }),
      { wrapper, initialProps: { listPresentationActive: false } },
    );

    await waitFor(() => expect(rendered.result.current.bundle).not.toBeNull());
    const compiled = rendered.result.current.bundle;
    expect(worker.prepare).toHaveBeenCalledTimes(1);
    // Content at version 1 is what the server holds, so the trace is persisted for it.
    await waitFor(() => expect(saveSimulationPreview).toHaveBeenCalledTimes(1));
    expect(saveSimulationPreview.mock.calls[0]?.[0]).toEqual({ id: "doc_1", draftVersion: 1 });

    // A dirty edit: identical content, so the trace and the worker run are reused.
    act(() => rendered.result.current.updateDocument({ ...documentAt(1), title: "Renamed" }));
    expect(rendered.result.current.bundle).toBe(compiled);

    // The autosave echo advances the version without changing content.
    act(() => rendered.result.current.updateDocument(documentAt(2)));
    expect(rendered.result.current.bundle).toBe(compiled);
    expect(worker.prepare).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(saveSimulationPreview).toHaveBeenCalledTimes(2));
    expect(saveSimulationPreview.mock.calls[1]?.[0]).toEqual({ id: "doc_1", draftVersion: 2 });

    // Leaving for the list and coming back changes presentation only.
    rendered.rerender({ listPresentationActive: true });
    rendered.rerender({ listPresentationActive: false });
    expect(rendered.result.current.bundle).toBe(compiled);
    expect(worker.prepare).toHaveBeenCalledTimes(1);
    expect(saveSimulationPreview).toHaveBeenCalledTimes(2);
  });

  it("drops the trace and recompiles when the authored content changes, without uploading the unsaved trace", async () => {
    const { services, saveSimulationPreview } = host(documentAt(1));
    worker.prepare.mockImplementation(async (content: { choreography: { clipSeconds: number } }) => fakeBundle(`clip-${content.choreography.clipSeconds}`));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StudioHostProvider host={services}>{children}</StudioHostProvider>
    );
    const rendered = renderHook(() => useScenarioSession({
      documentId: "doc_1",
      listPresentationActive: false,
      viewer: null,
      actorRenderer: null,
      loadedMapVersionId: null,
    }), { wrapper });
    await waitFor(() => expect(rendered.result.current.bundle).not.toBeNull());
    await waitFor(() => expect(saveSimulationPreview).toHaveBeenCalledTimes(1));

    act(() => rendered.result.current.updateDocument(documentAt(1, 30)));
    expect(rendered.result.current.bundle).toBeNull();
    await waitFor(() => expect(worker.prepare).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(rendered.result.current.bundle).toMatchObject({ tag: "clip-30" }));
    // Version 1 on the server still holds the 20 s content; the 30 s trace is not persisted under it.
    expect(saveSimulationPreview).toHaveBeenCalledTimes(1);

    // The save lands: the same trace is now the preview of version 2.
    act(() => rendered.result.current.updateDocument(documentAt(2, 30)));
    await waitFor(() => expect(saveSimulationPreview).toHaveBeenCalledTimes(2));
    expect(saveSimulationPreview.mock.calls[1]?.[0]).toEqual({ id: "doc_1", draftVersion: 2 });
    expect(worker.prepare).toHaveBeenCalledTimes(2);
  });
});
