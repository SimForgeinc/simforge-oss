// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { TEST_MAP } from "@simforge-oss/editor";
import type * as EditorRuntimeModule from "../../../../src/lib/scenario/editor/use-editor-runtime";

/**
 * While the simulation player presents the physics trace, the authoring rail
 * has no job. Leaving it up is not merely noise: its placement tools stay armed,
 * so a click on the canvas drops a new actor into a running scenario. It is
 * hidden rather than unmounted, so it comes back exactly as the author left it.
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
  useEditorRuntime.mockReset();
  useEditorRuntime.mockImplementation(() => ({
    controller: null,
    editorDocument: null,
    state: null,
    error: null,
    laneCount: null,
  }));
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
    quality: "low" as const,
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

  it("hides the rail, still mounted, while playback presents the trace", () => {
    render(<ScenarioEditorSurface {...surfaceProps()} sharedPlayback={playback(true)} />);

    const region = document.querySelector<HTMLElement>('[data-editor-shell-region="left-sidebar"]');
    expect(region).not.toBeNull();
    // Hidden from pointer, focus and assistive tech: an armed placement tool
    // must not drop an actor into a running scenario.
    expect(region?.hasAttribute("inert")).toBe(true);
    expect(region?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByTestId("mock-tool-sidebar").closest('[data-editor-shell-region="left-sidebar"]')).toBe(region);
    expect(document.querySelector('[data-testid="scenario-editor-surface"]')?.getAttribute("data-player-mode")).toBe("true");
  });

  it("brings the rail back exactly as it was when playback ends", () => {
    const props = surfaceProps();
    const view = render(<ScenarioEditorSurface {...props} sharedPlayback={playback(false)} />);

    // Open the catalog, the way an author mid-placement would leave it.
    fireEvent.click(screen.getByTestId("mock-tool-sidebar"));
    const rail = screen.getByTestId("mock-tool-sidebar");
    expect(rail.dataset.activeTool).toBe("vehicles");

    view.rerender(<ScenarioEditorSurface {...props} sharedPlayback={playback(true)} />);
    // The same element throughout: nothing was unmounted, so nothing was lost.
    expect(screen.getByTestId("mock-tool-sidebar")).toBe(rail);

    view.rerender(<ScenarioEditorSurface {...props} sharedPlayback={playback(false)} />);
    expect(screen.getByTestId("mock-tool-sidebar")).toBe(rail);
    expect(rail.dataset.activeTool).toBe("vehicles");
    const region = rail.closest<HTMLElement>('[data-editor-shell-region="left-sidebar"]');
    expect(region?.hasAttribute("inert")).toBe(false);
    expect(region?.getAttribute("aria-hidden")).toBeNull();
  });

  it("disarms a placement tool on entry, so the returning catalog is open but not armed", () => {
    const controller = {
      state: { mode: "placing" },
      cancel: vi.fn(),
      setPresentationActive: vi.fn(),
      setSelection: vi.fn(),
    };
    useEditorRuntime.mockImplementation(() => ({
      controller: controller as never,
      editorDocument: null,
      state: null,
      error: null,
      laneCount: null,
    }));
    const props = surfaceProps();
    const view = render(<ScenarioEditorSurface {...props} sharedPlayback={playback(false)} />);
    expect(controller.cancel).not.toHaveBeenCalled();

    view.rerender(<ScenarioEditorSurface {...props} sharedPlayback={playback(true)} />);
    expect(controller.cancel).toHaveBeenCalledOnce();
  });

  it("keeps the selection: an idle editor is not cancelled on entry", () => {
    // `cancel()` while idle clears the selection, and the inspector the author
    // had open must come back when the player exits.
    const controller = {
      state: { mode: "idle" },
      cancel: vi.fn(),
      setPresentationActive: vi.fn(),
      setSelection: vi.fn(),
    };
    useEditorRuntime.mockImplementation(() => ({
      controller: controller as never,
      editorDocument: null,
      state: null,
      error: null,
      laneCount: null,
    }));
    const props = surfaceProps();
    const view = render(<ScenarioEditorSurface {...props} sharedPlayback={playback(false)} />);
    view.rerender(<ScenarioEditorSurface {...props} sharedPlayback={playback(true)} />);
    view.rerender(<ScenarioEditorSurface {...props} sharedPlayback={playback(false)} />);
    expect(controller.cancel).not.toHaveBeenCalled();
    expect(controller.setSelection).not.toHaveBeenCalled();
  });
});
