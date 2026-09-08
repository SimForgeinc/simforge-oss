// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { TEST_MAP } from "@simforge-oss/editor";
import type * as EditorRuntimeModule from "../../../../src/lib/scenario/editor/use-editor-runtime";

/**
 * While the simulation preview presents the physics trace, the authoring rail
 * has no job. Leaving it up is not merely noise: its placement tools stay armed,
 * so a click on the canvas drops a new actor into a running scenario.
 */

const useEditorRuntime = vi.hoisted(() =>
  vi.fn((_options: { runtimeReady?: boolean }) => ({
    controller: null,
    editorDocument: null,
    state: null,
    error: null,
    laneCount: null,
  })),
);

vi.mock("../../../../src/lib/scenario/editor/use-editor-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof EditorRuntimeModule>()),
  useEditorRuntime,
}));
vi.mock("../../../../src/scenario/editor/regions/ActorLibraryRail", () => ({
  ActorLibraryRail: ({
    activeTool,
    onExpandedToolChange,
  }: {
    activeTool?: string | null;
    onExpandedToolChange?: (tool: "vehicles") => void;
  }) => (
    <button
      data-testid="mock-tool-sidebar"
      data-active-tool={String(activeTool)}
      onClick={() => onExpandedToolChange?.("vehicles")}
      type="button"
    >
      Tools
    </button>
  ),
}));
vi.mock("../../../../src/scenario/editor/regions/EditorCanvasRegion", () => ({ EditorCanvasRegion: () => null }));
vi.mock("../../../../src/scenario/editor/regions/EditorHeader", () => ({ EditorHeader: () => null }));
vi.mock("../../../../src/scenario/editor/regions/EditorModeBanner", () => ({ EditorModeBanner: () => null }));
vi.mock("../../../../src/scenario/editor/regions/slots", () => ({
  NotificationDockSlot: () => null,
  ScenarioRailSlot: () => null,
  TutorialOverlaySlot: () => null,
}));

// Deferred deliberately: a static import would be hoisted above the `vi.mock`
// calls, and the surface would then pull in the real rail, canvas and slots.
const { ScenarioEditorSurface } = await import(
  "../../../../src/scenario/editor/ScenarioEditorSurface"
);

afterEach(() => {
  cleanup();
  useEditorRuntime.mockClear();
  window.localStorage.clear();
});

function surfaceProps() {
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
  } as unknown as ComponentProps<typeof ScenarioEditorSurface>;
}

/** Only the flag the surface reads; the rest of the session is irrelevant here. */
function playback(inspecting: boolean) {
  return { inspecting } as unknown as ComponentProps<
    typeof ScenarioEditorSurface
  >["sharedPlayback"];
}

describe("actor rail visibility during simulation playback", () => {
  it("offers the rail while the author is authoring", () => {
    render(<ScenarioEditorSurface {...surfaceProps()} sharedPlayback={playback(false)} />);

    expect(screen.getByTestId("mock-tool-sidebar").closest('[data-editor-shell-region="left-sidebar"]')).not.toBeNull();
  });

  it("takes the rail away while playback presents the trace", () => {
    render(<ScenarioEditorSurface {...surfaceProps()} sharedPlayback={playback(true)} />);

    expect(screen.queryByTestId("mock-tool-sidebar")).toBeNull();
    expect(document.querySelector('[data-editor-shell-region="left-sidebar"]')).toBeNull();
  });

  it("brings the rail back, disarmed, when playback ends", () => {
    const props = surfaceProps();
    const view = render(<ScenarioEditorSurface {...props} sharedPlayback={playback(false)} />);

    // Arm a placement tool, the way an author mid-placement would leave it.
    fireEvent.click(screen.getByTestId("mock-tool-sidebar"));
    expect(screen.getByTestId("mock-tool-sidebar").dataset.activeTool).toBe("vehicles");

    view.rerender(<ScenarioEditorSurface {...props} sharedPlayback={playback(true)} />);
    expect(screen.queryByTestId("mock-tool-sidebar")).toBeNull();

    view.rerender(<ScenarioEditorSurface {...props} sharedPlayback={playback(false)} />);
    // Returning to an armed tool would place an actor on the author's next
    // click, somewhere they last aimed several seconds of playback ago.
    expect(screen.getByTestId("mock-tool-sidebar").dataset.activeTool).toBe("null");
  });
});
