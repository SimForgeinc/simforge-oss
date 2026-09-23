// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { TEST_MAP } from "@simforge-oss/editor";
import type * as EditorRuntimeModule from "../../../../src/lib/scenario/editor/use-editor-runtime";

/**
 * While the simulation plays, the editor is a player: the scene, and one bar
 * of controls to play, pause, scrub and leave. Everything else steps aside
 * (hidden, still mounted) and comes back when the player exits.
 */

// One stable result object. Returning a fresh document each call gives every
// document-keyed effect a new identity on every render, which spins the surface
// forever instead of failing.
const editorRuntimeResult = vi.hoisted(() => ({
  controller: null,
  editorDocument: {
    revision: 1,
    subscribe: () => () => {},
    data: {
      roles: [],
      choreography: { interactions: [] },
      environment: { weather: "clear", timeOfDay: 12 },
    },
  },
  state: null,
  error: null,
  laneCount: null,
}));
const useEditorRuntime = vi.hoisted(() => vi.fn(() => editorRuntimeResult));

vi.mock("../../../../src/lib/scenario/editor/use-editor-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof EditorRuntimeModule>()),
  useEditorRuntime,
}));
vi.mock("../../../../src/scenario/editor/regions/ActorLibraryRail", () => ({
  ActorLibraryRail: () => null,
}));
vi.mock("../../../../src/scenario/editor/regions/EditorCanvasRegion", () => ({ EditorCanvasRegion: () => null }));
vi.mock("../../../../src/scenario/editor/regions/EditorHeader", () => ({ EditorHeader: () => null }));
vi.mock("../../../../src/scenario/editor/regions/EditorModeBanner", () => ({ EditorModeBanner: () => null }));
vi.mock("../../../../src/scenario/editor/regions/slots", () => ({
  NotificationDockSlot: () => null,
  ScenarioRailSlot: () => null,
  TutorialOverlaySlot: () => null,
}));
// The timeline itself is irrelevant here; only whether it steps aside is under
// test, and the real dock wants a fully-formed template.
vi.mock("../../../../src/scenario/editor/ScenarioTimelineDock", () => ({
  ScenarioTimelineDock: () => null,
}));

// Deferred deliberately: a static import would be hoisted above the `vi.mock`
// calls, and the surface would then pull in the real timeline, rail and canvas.
const { ScenarioEditorSurface } = await import(
  "../../../../src/scenario/editor/ScenarioEditorSurface"
);


afterEach(() => {
  cleanup();
  useEditorRuntime.mockClear();
  window.localStorage.clear();
});

function surfaceProps() {
  const canvas = document.createElement("canvas");
  document.createElement("div").appendChild(canvas);
  return {
    map: {
      ...TEST_MAP,
      id: "map-yale",
      versionId: "map-yale",
      mapVersionId: "map-yale",
    },
    record: null,
    onChanged: vi.fn(),
    quality: "low" as const,
    onQualityChange: vi.fn(),
    loadedMapVersionId: "map-yale",
    active: true,
    // Exactly the viewer surface the editor drives on mount: quality and
    // fidelity toggles, the weather pass, and the scene it sweeps for a stale
    // placement ghost.
    injectedViewer: {
      renderer: { domElement: canvas },
      scene: { children: [], getObjectByName: () => undefined },
      setLiveQuality: vi.fn(),
      setRenderingSuspended: vi.fn(),
      setAuthoringFidelity: vi.fn(),
      setLayerVisible: vi.fn(),
      setWeatherAppearance: vi.fn(),
      setWeatherTimeSeconds: vi.fn(),
      // The environment bridge drives practical lighting on mount and reverses
      // it on unmount; the probe reads live luminaire stats on demand.
      setStreetLightsEnabled: vi.fn(),
      getStreetLightingStats: vi.fn(() => ({ discovered: 0, active: 0, enabled: false })),
    },
  } as unknown as ComponentProps<typeof ScenarioEditorSurface>;
}

function playback(inspecting: boolean) {
  const snapshot = { time: 4, startTime: 0, endTime: 20, playing: true };
  const controller = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    currentActors: [],
    toggle: vi.fn(),
    seek: vi.fn(),
    pause: vi.fn(),
  };
  const session = {
    inspecting,
    controller,
    setInspecting: vi.fn(),
    bundle: {
      startTime: 0,
      endTime: 20,
      actors: [],
      instance: { manifest: { inputHash: "hash" } },
      trace: { events: [] },
    },
  };
  return {
    controller,
    session,
    props: session as unknown as ComponentProps<typeof ScenarioEditorSurface>["sharedPlayback"],
  };
}

describe("simulation player", () => {
  it("shows only the player's controls while the simulation plays", () => {
    const { props } = playback(true);
    render(<ScenarioEditorSurface {...surfaceProps()} sharedPlayback={props} />);

    expect(screen.getByTestId("simulation-player")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause simulation" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Simulation time" }).getAttribute("aria-valuenow")).toBe("4");
    expect(screen.getByRole("button", { name: "Exit simulation (Esc)" })).toBeTruthy();
    expect(screen.getByTestId("simulation-player-hint").textContent).toBe("Click an actor to follow it");
    // The timeline steps aside without unmounting, and the old blocking hint is gone.
    const timeline = screen.getByTestId("floating-timeline-layer");
    expect(timeline.hasAttribute("inert")).toBe(true);
    expect(timeline.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByText("Press Escape to exit simulation")).toBeNull();
  });

  it("plays, pauses and scrubs through the playback controller", () => {
    const { controller, props } = playback(true);
    render(<ScenarioEditorSurface {...surfaceProps()} sharedPlayback={props} />);

    fireEvent.click(screen.getByRole("button", { name: "Pause simulation" }));
    expect(controller.toggle).toHaveBeenCalledOnce();
    const slider = screen.getByRole("slider", { name: "Simulation time" });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(controller.seek).toHaveBeenLastCalledWith(5);
    fireEvent.keyDown(slider, { key: "ArrowLeft", shiftKey: true });
    expect(controller.seek).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(slider, { key: "End" });
    expect(controller.seek).toHaveBeenLastCalledWith(20);
  });

  it("exits the way Escape does: stop, rewind and hand the editor back", () => {
    const { controller, session, props } = playback(true);
    render(<ScenarioEditorSurface {...surfaceProps()} sharedPlayback={props} />);

    fireEvent.click(screen.getByRole("button", { name: "Exit simulation (Esc)" }));
    expect(controller.pause).toHaveBeenCalledOnce();
    expect(controller.seek).toHaveBeenCalledWith(0);
    expect(session.setInspecting).toHaveBeenCalledWith(false);
  });

  it("stays out of the way while the author is authoring", () => {
    const { props } = playback(false);
    render(<ScenarioEditorSurface {...surfaceProps()} sharedPlayback={props} />);

    expect(screen.queryByTestId("simulation-player")).toBeNull();
    const timeline = screen.getByTestId("floating-timeline-layer");
    expect(timeline.hasAttribute("inert")).toBe(false);
    expect(timeline.getAttribute("aria-hidden")).toBeNull();
  });
});
