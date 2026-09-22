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
vi.mock("@simforge-oss/viewer", () => ({ indexedWorldHeightSampler: () => () => null }));
const authoritative = vi.hoisted(() => ({ bundle: vi.fn() }));
vi.mock("../../../../src/lib/scenario/playback/authoritativeSimulation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  authoritativePlaybackBundle: authoritative.bundle,
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

function fakeBundle(tag: string, traceSha256 = "t".repeat(64)) {
  return { tag, actors: [], instance: { manifest: { inputHash: tag } }, traceSha256 };
}

function succeeded(traceSha256 = "t".repeat(64), draftVersion = 1) {
  return {
    state: "succeeded" as const,
    requestKey: "r".repeat(64),
    draftVersion,
    result: { simKey: "k".repeat(64), traceSha256, authoredTraceSha256: traceSha256, engineSemVer: "0.8.0", trafficProvider: "off" },
  };
}

function host(initial: ScenarioDocumentDto) {
  const resolveSimulation = vi.fn(async (document: { draftVersion: number }) => succeeded("t".repeat(64), document.draftVersion));
  const verifySimulation = vi.fn(async () => ({ outcome: "verified", authoritativeTraceSha256: "t".repeat(64) }));
  const services = {
    artifacts: { listMaps: async () => [MAP] },
    projects: { getDocument: async () => initial, resolveSimulation, verifySimulation },
  };
  // The hook touches only these services; the rest of the host surface is unused.
  return { services: services as unknown as StudioHostServices, resolveSimulation, verifySimulation };
}

function renderSession(services: StudioHostServices) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StudioHostProvider host={services}>{children}</StudioHostProvider>
  );
  return renderHook(() => useScenarioSession({
    documentId: "doc_1", viewer: null, actorRenderer: null, loadedMapVersionId: null,
  }), { wrapper });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("scenario session trace residency", () => {
  it("labels the local preview Verified when the authoritative trace digest matches, uploading nothing", async () => {
    const { services, resolveSimulation, verifySimulation } = host(documentAt(1));
    worker.prepare.mockImplementation(async () => fakeBundle("local"));
    const rendered = renderSession(services);
    await waitFor(() => expect(rendered.result.current.playback.simulationVerification?.status).toBe("verified"));
    expect(resolveSimulation.mock.calls[0]?.[0]).toEqual({ id: "doc_1", draftVersion: 1 });
    expect(verifySimulation).toHaveBeenCalledWith("k".repeat(64), expect.objectContaining({
      documentId: "doc_1", localTraceSha256: "t".repeat(64),
    }));
    expect(rendered.result.current.bundle).toMatchObject({ tag: "local" });
    expect(authoritative.bundle).not.toHaveBeenCalled();
  });

  it("shows the authoritative trace, flags the mismatch and reports it when the digests differ", async () => {
    const { services, resolveSimulation, verifySimulation } = host(documentAt(1));
    resolveSimulation.mockImplementation(async () => succeeded("a".repeat(64)));
    worker.prepare.mockImplementation(async () => fakeBundle("local", "b".repeat(64)));
    authoritative.bundle.mockImplementation(async () => fakeBundle("authoritative", "a".repeat(64)));
    const rendered = renderSession(services);
    await waitFor(() => expect(rendered.result.current.playback.simulationVerification).toMatchObject({
      status: "mismatch", localTraceSha256: "b".repeat(64), authoritativeTraceSha256: "a".repeat(64), showingAuthoritative: true,
    }));
    expect(rendered.result.current.bundle).toMatchObject({ tag: "authoritative" });
    expect(verifySimulation).toHaveBeenCalledWith("k".repeat(64), expect.objectContaining({ localTraceSha256: "b".repeat(64) }));
    expect(worker.prepare).toHaveBeenCalledTimes(1);
  });

  it("keeps the preview local while the simulation is queued on a worker, then verifies", async () => {
    const { services, resolveSimulation } = host(documentAt(1));
    resolveSimulation
      .mockImplementationOnce(async () => ({ state: "queued", requestKey: "r".repeat(64), draftVersion: 1 }) as never)
      .mockImplementationOnce(async () => succeeded());
    worker.prepare.mockImplementation(async () => fakeBundle("local"));
    const rendered = renderSession(services);
    await waitFor(() => expect(rendered.result.current.playback.simulationVerification?.status).toBe("verified"));
    expect(resolveSimulation).toHaveBeenCalledTimes(2);
  });

  it("reports an unavailable simulation and retries without rebuilding the playable trace", async () => {
    const { services, resolveSimulation } = host(documentAt(1));
    resolveSimulation.mockImplementationOnce(async () => ({
      state: "failed", requestKey: "r".repeat(64), draftVersion: 1, failureCode: "simulation_failed", message: "Runner offline",
    }) as never);
    worker.prepare.mockImplementation(async () => fakeBundle("retry"));
    const rendered = renderSession(services);
    await waitFor(() => expect(rendered.result.current.playback.simulationVerification).toMatchObject({ status: "unavailable", message: "Runner offline" }));
    const trace = rendered.result.current.bundle;
    act(() => rendered.result.current.playback.retrySimulationVerification?.());
    await waitFor(() => expect(rendered.result.current.playback.simulationVerification?.status).toBe("verified"));
    expect(rendered.result.current.bundle).toBe(trace);
    expect(worker.prepare).toHaveBeenCalledTimes(1);
  });

  it("opens a superseded draft on its source's current geometry-compatible map", async () => {
    const { services } = host({
      ...documentAt(1), mapVersionId: "retired-publication",
      mapSourceMapId: MAP.sourceMapId, mapXodrSha256: MAP.artifacts!.xodrSha256,
    });
    worker.prepare.mockImplementation(async () => fakeBundle("forward-resolved"));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StudioHostProvider host={services}>{children}</StudioHostProvider>
    );
    const rendered = renderHook(() => useScenarioSession({
      documentId: "doc_1", viewer: null, actorRenderer: null, loadedMapVersionId: null,
    }), { wrapper });
    await waitFor(() => expect(rendered.result.current.bundle).toMatchObject({ tag: "forward-resolved" }));
    expect(rendered.result.current.map?.mapVersionId).toBe(MAP.mapVersionId);
    expect(rendered.result.current.failed).toBe(false);
  });

  it("refuses drift before producing a driveable preview", async () => {
    const { services } = host({
      ...documentAt(1), mapVersionId: "retired-publication",
      mapSourceMapId: MAP.sourceMapId, mapXodrSha256: "0".repeat(64),
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StudioHostProvider host={services}>{children}</StudioHostProvider>
    );
    const rendered = renderHook(() => useScenarioSession({
      documentId: "doc_1", viewer: null, actorRenderer: null, loadedMapVersionId: null,
    }), { wrapper });
    await waitFor(() => expect(rendered.result.current.failed).toBe(true));
    expect(rendered.result.current.message).toContain("Remap");
    expect(rendered.result.current.bundle).toBeNull();
    expect(worker.prepare).not.toHaveBeenCalled();
  });

  it("keeps the compiled trace across an autosave echo and verifies it once per saved version", async () => {
    const { services, resolveSimulation } = host(documentAt(1));
    worker.prepare.mockImplementation(async () => fakeBundle("v1"));
    const rendered = renderSession(services);

    await waitFor(() => expect(rendered.result.current.playback.simulationVerification?.status).toBe("verified"));
    const compiled = rendered.result.current.bundle;
    expect(worker.prepare).toHaveBeenCalledTimes(1);
    expect(resolveSimulation).toHaveBeenCalledTimes(1);

    // A dirty edit with identical content: the trace and the worker run are reused.
    act(() => rendered.result.current.updateDocument({ ...documentAt(1), title: "Renamed" }));
    expect(rendered.result.current.bundle).toBe(compiled);

    // The autosave echo advances the version without changing content: verified again for it.
    act(() => rendered.result.current.updateDocument(documentAt(2)));
    expect(rendered.result.current.bundle).toBe(compiled);
    expect(worker.prepare).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(resolveSimulation).toHaveBeenCalledTimes(2));
    expect(resolveSimulation.mock.calls[1]?.[0]).toEqual({ id: "doc_1", draftVersion: 2 });
  });

  it("recompiles an edit as a local preview and verifies only once the content is saved", async () => {
    const { services, resolveSimulation } = host(documentAt(1));
    worker.prepare.mockImplementation(async (content: { choreography: { clipSeconds: number } }) => fakeBundle(`clip-${content.choreography.clipSeconds}`));
    const rendered = renderSession(services);
    await waitFor(() => expect(rendered.result.current.playback.simulationVerification?.status).toBe("verified"));

    act(() => rendered.result.current.updateDocument(documentAt(1, 30)));
    expect(rendered.result.current.bundle).toBeNull();
    await waitFor(() => expect(rendered.result.current.bundle).toMatchObject({ tag: "clip-30" }));
    // Version 1 on the server still holds the 20 s content: the 30 s preview stays local.
    expect(rendered.result.current.playback.simulationVerification?.status).toBe("local");
    expect(resolveSimulation).toHaveBeenCalledTimes(1);

    // The save lands: the same trace is verified as version 2.
    act(() => rendered.result.current.updateDocument(documentAt(2, 30)));
    await waitFor(() => expect(resolveSimulation).toHaveBeenCalledTimes(2));
    expect(resolveSimulation.mock.calls[1]?.[0]).toEqual({ id: "doc_1", draftVersion: 2 });
    expect(worker.prepare).toHaveBeenCalledTimes(2);
  });
});
