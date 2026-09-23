// @vitest-environment jsdom
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  ScenarioMapRepinPreviewDto,
  ScenarioVersionsDto,
  SimulationMotionDiffDto,
  StudioHostServices,
} from "@simforge-oss/studio-host";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StudioHostProvider } from "../../../../src/host";
import { EngineChangeBanner } from "../../../../src/scenario/editor/versions/EngineChangeBanner";
import { NewerMapBanner } from "../../../../src/scenario/editor/versions/NewerMapBanner";
import { VersionsButton } from "../../../../src/scenario/editor/versions/VersionsPanel";
import {
  diffChip,
  mapLabel,
  panelSubtitle,
  simulationSummary,
  versionSummary,
} from "../../../../src/scenario/editor/versions/versions-model";
import type { ScenarioSharedPlayback } from "../../../../src/scenario/scene/useScenarioSession";

afterEach(cleanup);

const OLD = "a".repeat(64);
const NEW = "b".repeat(64);

function diff(overrides: Partial<SimulationMotionDiffDto> = {}): SimulationMotionDiffDto {
  return {
    format: "simforge.simulation-diff/v1",
    baseSimKey: OLD,
    candidateSimKey: NEW,
    identical: false,
    summary: "max 1.2 m · 2 actors · 1 event changed",
    maxPositionErrorM: 1.2,
    maxHeadingErrorDeg: 3,
    worst: { actorId: "ego", tS: 4.2, positionErrorM: 1.2 },
    actors: { compared: 3, changedCount: 2, changed: ["ego", "lead"], added: [], removed: [] },
    eventsChanged: 1,
    collisionsChanged: 0,
    signalsChanged: 0,
    durationS: { base: 20, candidate: 20 },
    strict: { profile: "strict-trajectory-v1", verdict: "fail", reportHash: "r", errorFindings: 2, reason: null },
    ...overrides,
  };
}

function simulation(simKey: string, engineSemVer: string, active: boolean, extra: Record<string, unknown> = {}) {
  return {
    simKey,
    engineSemVer,
    reason: active ? "commit" as const : "resimulate" as const,
    createdAt: "2026-09-23T10:00:00.000Z",
    createdBy: { id: "u1", name: "Michael" },
    active,
    previousSimKey: active ? null : OLD,
    motionDiff: active ? null : diff(),
    details: { traceSha256: "c".repeat(64), timelineSha256: null, mapClosureDigest: "d".repeat(64), resolvedInputDigest: "e".repeat(64), engineBuild: { engineVersion: engineSemVer }, producer: "inline" },
    ...extra,
  };
}

const VERSIONS: ScenarioVersionsDto = {
  documentId: "uscn_1",
  draftVersion: 4,
  currentEngineSemVer: "0.10.0",
  draft: { lastSimKey: NEW, lastSimEngineSemVer: "0.10.0", lastSimDraftVersion: 4 },
  versions: [
    {
      revisionId: "usrev_2",
      revisionNumber: 2,
      label: null,
      createdFor: "map_move",
      createdAt: "2026-09-23T09:00:00.000Z",
      createdBy: { id: "u1", name: "Michael" },
      sourceDraftVersion: 3,
      contentSha256: "f".repeat(64),
      map: { mapVersionId: "usmap_old", name: "Richmond", publishedAt: "2026-09-20T12:00:00.000Z" },
      active: { simKey: OLD, setAt: "2026-09-23T09:00:00.000Z", setBy: null },
      simulations: [simulation(NEW, "0.10.0", false), simulation(OLD, "0.9.0", true)],
      matchesDraft: false,
    },
    {
      revisionId: "usrev_1",
      revisionNumber: 1,
      label: "Baseline",
      createdFor: "render",
      createdAt: "2026-09-21T09:00:00.000Z",
      createdBy: { id: "u1", name: "Michael" },
      sourceDraftVersion: 2,
      contentSha256: "9".repeat(64),
      map: { mapVersionId: "usmap_new", name: "Richmond", publishedAt: "2026-09-22T12:00:00.000Z" },
      active: { simKey: OLD, setAt: "2026-09-21T09:00:00.000Z", setBy: null },
      simulations: [simulation(OLD, "0.9.0", true)],
      matchesDraft: false,
    },
  ],
};

function host(projects: Record<string, unknown>) {
  return { projects } as unknown as StudioHostServices;
}

function withHost(services: StudioHostServices, children: ReactNode) {
  return <StudioHostProvider host={services}>{children}</StudioHostProvider>;
}

describe("versions-model", () => {
  it("speaks in three version concepts: Version N, Engine x.y.z and Map name · date", () => {
    const version = VERSIONS.versions[0]!;
    expect(versionSummary(version)).toBe("Version 2 · Sep 23 · Michael · Before moving to another map version");
    expect(simulationSummary(version.simulations[1]!)).toBe("Engine 0.9.0 · Sep 23 · Michael · Authored");
    expect(mapLabel(version.map)).toBe("Richmond · Sep 20");
  });

  it("labels the diff chip identical, changed or not yet compared", () => {
    expect(diffChip(diff({ identical: true }), true)).toMatchObject({ text: "Motion identical", tone: "positive" });
    expect(diffChip(diff(), true)).toMatchObject({ text: "max 1.2 m · 2 actors · 1 event changed", tone: "warning" });
    expect(diffChip(null, true)).toMatchObject({ text: "Not compared yet", tone: "muted" });
    expect(diffChip(null, false)).toBeNull();
  });

  it("says whether the draft matches a version", () => {
    expect(panelSubtitle(VERSIONS)).toBe("2 versions · the draft has changes since the last version");
    expect(panelSubtitle({ ...VERSIONS, versions: [] })).toMatch(/No saved versions yet/);
  });
});

describe("EngineChangeBanner", () => {
  const change = { previous: { simKey: OLD, engineSemVer: "0.9.0" }, current: { simKey: NEW, engineSemVer: "0.10.0" }, motionDiff: diff() };
  const playback = (clear = vi.fn()) => ({
    simulationEngineChange: { documentId: "uscn_1", draftVersion: 4, change },
    clearSimulationEngineChange: clear,
  } as unknown as ScenarioSharedPlayback);

  it("keeps the previous engine's motion as a version", async () => {
    const keepPreviousMotion = vi.fn().mockResolvedValue({ revision: { revisionNumber: 3 } });
    const clear = vi.fn();
    render(withHost(host({ keepPreviousMotion }), <EngineChangeBanner documentId="uscn_1" playback={playback(clear)} />));
    expect(screen.getByTestId("engine-change-banner").textContent).toContain("Motion changed with Engine 0.10.0");
    expect(screen.getByTestId("engine-change-banner").textContent).toContain("max 1.2 m · 2 actors · 1 event changed since Engine 0.9.0");
    fireEvent.click(screen.getByTestId("engine-change-keep"));
    await waitFor(() => expect(keepPreviousMotion).toHaveBeenCalledWith(
      { id: "uscn_1", draftVersion: 4 },
      { previousSimKey: OLD, currentSimKey: NEW },
    ));
    await screen.findByText(/Version 3 keeps the Engine 0\.9\.0 motion/);
    expect(clear).toHaveBeenCalled();
  });

  it("uses the new motion without keeping anything", async () => {
    const acceptDraftSimulation = vi.fn().mockResolvedValue(undefined);
    const clear = vi.fn();
    render(withHost(host({ acceptDraftSimulation }), <EngineChangeBanner documentId="uscn_1" playback={playback(clear)} />));
    fireEvent.click(screen.getByTestId("engine-change-accept"));
    await waitFor(() => expect(acceptDraftSimulation).toHaveBeenCalledWith({ id: "uscn_1", draftVersion: 4 }, NEW));
    await waitFor(() => expect(clear).toHaveBeenCalled());
  });

  it("stays hidden for another document", () => {
    render(withHost(host({}), <EngineChangeBanner documentId="uscn_other" playback={playback()} />));
    expect(screen.queryByTestId("engine-change-banner")).toBeNull();
  });
});

describe("VersionsButton", () => {
  function open(projects: Record<string, unknown>, document: unknown = null) {
    render(withHost(
      host({ listVersions: vi.fn().mockResolvedValue(VERSIONS), ...projects }),
      <VersionsButton record={{ id: "uscn_1", mapVersionId: "usmap_new" }} document={document as never} />,
    ));
    fireEvent.click(screen.getByTestId("scenario-versions-button"));
  }

  it("lists versions with their simulations, the active one badged and the diff chip shown", async () => {
    open({});
    const rows = await screen.findAllByTestId("scenario-version");
    expect(rows).toHaveLength(2);
    const moved = rows[0]!;
    expect(moved.textContent).toContain("Version 2");
    expect(within(moved).getByTestId("scenario-version-map").textContent).toBe("Richmond · Sep 20");
    const sims = within(moved).getAllByTestId("scenario-version-simulation");
    expect(sims.map((sim) => [sim.getAttribute("data-engine"), sim.getAttribute("data-active")])).toEqual([["0.10.0", "false"], ["0.9.0", "true"]]);
    expect(within(sims[0]!).getByTestId("scenario-simulation-diff").textContent).toBe("max 1.2 m · 2 actors · 1 event changed");
    // A version saved before a map move offers the way back to its map version.
    expect(within(moved).getByTestId("scenario-version-restore").textContent).toBe("Revert to previous map version");
    // Details carry the digests; the row itself shows none.
    expect(moved.textContent).toContain("Details");
  });

  it("Use this simulation moves the active simulation", async () => {
    const setVersionActiveSimulation = vi.fn().mockResolvedValue(undefined);
    open({ setVersionActiveSimulation });
    const rows = await screen.findAllByTestId("scenario-version");
    const newer = within(rows[0]!).getAllByTestId("scenario-version-simulation")[0]!;
    fireEvent.click(within(newer).getByTestId("scenario-simulation-use"));
    await waitFor(() => expect(setVersionActiveSimulation).toHaveBeenCalledWith("uscn_1", "usrev_2", NEW));
    expect((await screen.findByTestId("scenario-versions-notice")).textContent).toContain("now renders the Engine 0.10.0 simulation");
  });

  it("restores a version on the same map as one undoable edit", async () => {
    const restoreTemplate = vi.fn();
    const content = { scenarioVersion: 2, meta: { name: "Baseline" } };
    const getVersionContent = vi.fn().mockResolvedValue({ revisionId: "usrev_1", contentSha256: "9".repeat(64), mapVersionId: "usmap_new", content });
    open({ getVersionContent }, { restoreTemplate, flush: vi.fn() });
    const rows = await screen.findAllByTestId("scenario-version");
    fireEvent.click(within(rows[1]!).getByTestId("scenario-version-restore"));
    await waitFor(() => expect(restoreTemplate).toHaveBeenCalledWith(content));
    expect((await screen.findByTestId("scenario-versions-notice")).textContent).toContain("Undo brings your edits back");
  });
});

describe("NewerMapBanner", () => {
  const preview = (state: "succeeded" | "running"): ScenarioMapRepinPreviewDto => ({
    target: { mapVersionId: "usmap_v2", name: "Richmond", publishedAt: "2026-09-25T12:00:00.000Z" },
    plan: {
      geometry: "same",
      source: { mapVersionId: "usmap_v1", name: "Richmond", publishedAt: "2026-09-20T12:00:00.000Z" },
      target: { mapVersionId: "usmap_v2", name: "Richmond", publishedAt: "2026-09-25T12:00:00.000Z" },
      content: {} as never,
      placements: [{ roleId: "ego", label: "Ego", kind: "car", isSubject: true, before: { x: 0, y: 0, headingRad: 0, elevationM: 1 }, after: { x: 0, y: 0, headingRad: 0, elevationM: 1.2 }, displacementM: 0, routeDeviationM: null, status: "kept", reason: null }],
      roads: [{ roadId: "68", change: "elevation", before: [[[0, 0], [10, 0]]], after: [[[0, 0], [10, 0]]] }],
      roadsTruncated: false,
      tolerances: { keptM: 0.05, movedM: 1, laneSearchM: 6, routeMatchM: 3, siteMatchM: 15 },
      blocking: null,
    },
    status: state === "succeeded"
      ? { state, requestKey: "r", result: { simKey: NEW } as never }
      : { state, requestKey: "r" },
    motionDiff: state === "succeeded" ? diff({ identical: true, summary: "Motion identical" }) : null,
  });

  it("offers the newer version, previews the move before and after, and moves on request", async () => {
    const getMapPinStatus = vi.fn().mockResolvedValue({
      pinned: { mapVersionId: "usmap_v1", name: "Richmond", publishedAt: "2026-09-20T12:00:00.000Z", retired: false },
      newer: { mapVersionId: "usmap_v2", name: "Richmond", publishedAt: "2026-09-25T12:00:00.000Z" },
      newerUnavailable: null,
      pinnedMap: null,
    });
    const previewMapRepin = vi.fn().mockResolvedValue(preview("succeeded"));
    const onMove = vi.fn().mockResolvedValue(undefined);
    render(withHost(host({ getMapPinStatus, previewMapRepin }), <NewerMapBanner documentId="uscn_1" mapVersionId="usmap_v1" onMove={onMove} />));
    const banner = await screen.findByTestId("newer-map-banner");
    expect(banner.textContent).toContain("Newer map version available: Richmond · Sep 25");
    fireEvent.click(within(banner).getByTestId("newer-map-review"));
    const dialog = await screen.findByTestId("map-transition-dialog");
    await waitFor(() => expect(within(dialog).getByTestId("map-transition-geometry").textContent).toBe("Same roads; only heights change"));
    expect(within(dialog).getByTestId("map-transition-before")).toBeTruthy();
    expect(within(dialog).getByTestId("map-transition-after").querySelector('[data-road-change="elevation"]')).toBeTruthy();
    expect(within(dialog).getByTestId("map-transition-motion").textContent).toBe("Motion: Motion identical");
    fireEvent.click(within(dialog).getByTestId("map-transition-move"));
    await waitFor(() => expect(onMove).toHaveBeenCalledWith("usmap_v2"));
  });

  it("reports a finished move and stays out of the way otherwise", async () => {
    render(withHost(host({ getMapPinStatus: vi.fn().mockResolvedValue({ pinned: null, newer: null, newerUnavailable: null, pinnedMap: null }) }),
      <NewerMapBanner documentId="uscn_1" mapVersionId="usmap_v2" notice="Moved to Richmond. The scenario as it was is saved as Version 2." onMove={vi.fn()} />));
    expect(screen.getByTestId("map-move-notice").textContent).toContain("saved as Version 2");
  });
});
