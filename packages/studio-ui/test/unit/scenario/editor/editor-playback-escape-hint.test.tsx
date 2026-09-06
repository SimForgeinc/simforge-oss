// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { TEST_MAP } from "@simforge-oss/editor";
import type * as EditorRuntimeModule from "../../../../src/lib/scenario/editor/use-editor-runtime";

/**
 * Escape is bound to exit playback only while the trace is being inspected
 * (`V1TimelineRail`), so the hint that advertises it must appear on exactly that
 * condition — a hint for a key that does nothing is worse than no hint.
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
  AssistantChatSlot: () => null,
  NotificationDockSlot: () => null,
  ScenarioRailSlot: () => null,
  TutorialOverlaySlot: () => null,
}));
// The timeline itself is irrelevant here; only the hint floating above it is
// under test, and the real dock wants a fully-formed template.
vi.mock("../../../../src/scenario/editor/ScenarioTimelineDock", () => ({
  ScenarioTimelineDock: () => null,
}));

// Deferred deliberately: a static import would be hoisted above the `vi.mock`
// calls, and the surface would then pull in the real timeline, rail and canvas.
const { ScenarioEditorSurface } = await import(
  "../../../../src/scenario/editor/ScenarioEditorSurface"
);

const HINT = "Press Escape to exit simulation";

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
    quality: "minimal" as const,
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
  return { inspecting } as unknown as ComponentProps<
    typeof ScenarioEditorSurface
  >["sharedPlayback"];
}

describe("escape hint above the timeline", () => {
  it("tells the author how to leave while the simulation is being watched", () => {
    render(<ScenarioEditorSurface {...surfaceProps()} sharedPlayback={playback(true)} />);

    const hint = screen.getByText(HINT);
    expect(hint.closest('[data-testid="floating-timeline-layer"]')).not.toBeNull();
  });

  it("is plain floating white text, with nothing drawn behind it", () => {
    render(<ScenarioEditorSurface {...surfaceProps()} sharedPlayback={playback(true)} />);

    const hint = screen.getByText(HINT);
    expect(hint.className).toContain("text-white");
    // No plate, chip or panel behind it, and it never eats a click meant for
    // the scene underneath.
    expect(hint.className).not.toMatch(/\bbg-/);
    expect(hint.className).not.toMatch(/\bborder\b/);
    expect(hint.className).toContain("pointer-events-none");
  });

  it("stays out of the way while the author is authoring", () => {
    render(<ScenarioEditorSurface {...surfaceProps()} sharedPlayback={playback(false)} />);

    expect(screen.queryByText(HINT)).toBeNull();
  });
});
