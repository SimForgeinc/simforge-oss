// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { TEST_MAP } from "@simforge-oss/editor";
import type * as EditorRuntimeModule from "../../../../src/lib/scenario/editor/use-editor-runtime";
import { EDITOR_EXPERIENCE_STORAGE_KEY } from "../../../../src/scenario/editor/simple-timed-routes";

const useEditorRuntime = vi.hoisted(() =>
  vi.fn((_options: { runtimeReady?: boolean }) => ({
    controller: null,
    editorDocument: null,
    state: null,
    error: null,
    laneCount: null,
  })),
);
const editorHeader = vi.hoisted(() => vi.fn(() => null));

// Only the runtime hook is stubbed; the module's height sampler stays real.
vi.mock("../../../../src/lib/scenario/editor/use-editor-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof EditorRuntimeModule>()),
  useEditorRuntime,
}));
vi.mock("../../../../src/scenario/editor/regions/ActorLibraryRail", () => ({
  ActorLibraryRail: ({ onExpandedToolChange }: { onExpandedToolChange?: (tool: "vehicles") => void }) => (
    <button
      data-testid="mock-tool-sidebar"
      onClick={() => onExpandedToolChange?.("vehicles")}
      type="button"
    >
      Tools
    </button>
  ),
}));
vi.mock("../../../../src/scenario/editor/regions/EditorCanvasRegion", () => ({ EditorCanvasRegion: () => null }));
vi.mock("../../../../src/scenario/editor/regions/EditorHeader", () => ({
  EditorHeader: editorHeader,
}));
vi.mock("../../../../src/scenario/editor/regions/EditorModeBanner", () => ({ EditorModeBanner: () => null }));
vi.mock("../../../../src/scenario/editor/regions/slots", () => ({
  NotificationDockSlot: () => null,
  ScenarioRailSlot: () => null,
  TutorialOverlaySlot: () => null,
}));

const { ScenarioEditorSurface, stopAndResetTimelinePlayback } = await import(
  "../../../../src/scenario/editor/ScenarioEditorSurface"
);

afterEach(() => {
  cleanup();
  useEditorRuntime.mockClear();
  editorHeader.mockClear();
  window.localStorage.clear();
});

describe("ScenarioEditorSurface map transition", () => {
  it("stops, rewinds, and exits timeline inspection as one Escape action", () => {
    const pause = vi.fn();
    const seek = vi.fn();
    const setInspecting = vi.fn();

    stopAndResetTimelinePlayback({
      controller: { pause, seek },
      startTime: 3,
      setInspecting,
    });

    expect(pause).toHaveBeenCalledOnce();
    expect(seek).toHaveBeenCalledWith(3);
    expect(setInspecting).toHaveBeenCalledWith(false);
  });

  it("waits to create the controller without adding a full-screen blocker", () => {
    window.localStorage.setItem(EDITOR_EXPERIENCE_STORAGE_KEY, "simple");
    const canvas = document.createElement("canvas");
    const parent = document.createElement("div");
    parent.appendChild(canvas);
    const viewer = {
      renderer: { domElement: canvas },
      setLiveQuality: vi.fn(),
      setRenderingSuspended: vi.fn(),
      setAuthoringFidelity: vi.fn(),
      setLayerVisible: vi.fn(),
    };
    const props = {
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
      injectedViewer: viewer,
    } as unknown as ComponentProps<typeof ScenarioEditorSurface>;
    const view = render(
      <ScenarioEditorSurface
        {...props}
        loadedMapVersionId="map-belmont"
      />,
    );

    const toolSidebar = screen.getByTestId("mock-tool-sidebar");
    expect(toolSidebar.closest('[data-editor-shell-region="left-sidebar"]')).not.toBeNull();
    expect(toolSidebar.closest('[data-editor-shell-region="canvas"]')).toBeNull();
    expect(screen.queryByTestId("scenario-editor-map-transition")).toBeNull();
    expect(screen.queryByTestId("floating-timeline-layer")).toBeNull();
    expect(screen.queryByTestId("scenario-timeline-dock")).toBeNull();
    expect(useEditorRuntime.mock.calls.at(-1)?.[0].runtimeReady).toBe(false);
    expect(viewer.setLiveQuality).not.toHaveBeenCalled();
    expect(viewer.setRenderingSuspended).not.toHaveBeenCalled();
    expect(viewer.setAuthoringFidelity).not.toHaveBeenCalled();
    expect(viewer.setLayerVisible).not.toHaveBeenCalled();

    view.rerender(
      <ScenarioEditorSurface
        {...props}
        loadedMapVersionId="map-yale"
      />,
    );
    expect(screen.queryByTestId("floating-timeline-layer")).toBeNull();
    expect(screen.queryByTestId("scenario-timeline-dock")).toBeNull();
    fireEvent.click(toolSidebar);
    expect(useEditorRuntime.mock.calls.at(-1)?.[0].runtimeReady).toBe(true);
    expect(viewer.setLiveQuality).not.toHaveBeenCalled();
    expect(viewer.setRenderingSuspended).not.toHaveBeenCalled();
    expect(viewer.setAuthoringFidelity).not.toHaveBeenCalled();
    expect(viewer.setLayerVisible).not.toHaveBeenCalled();
  });

  it("unmounts editor top-bar actions while the persistent editor is inactive", () => {
    const canvas = document.createElement("canvas");
    const parent = document.createElement("div");
    parent.appendChild(canvas);
    const viewer = {
      renderer: { domElement: canvas },
      setLiveQuality: vi.fn(),
      setRenderingSuspended: vi.fn(),
      setAuthoringFidelity: vi.fn(),
      setLayerVisible: vi.fn(),
    };
    const props = {
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
      injectedViewer: viewer,
      loadedMapVersionId: "map-yale",
    } as unknown as ComponentProps<typeof ScenarioEditorSurface>;

    const view = render(<ScenarioEditorSurface {...props} active={false} />);
    expect(editorHeader).not.toHaveBeenCalled();

    view.rerender(<ScenarioEditorSurface {...props} active />);
    expect(editorHeader).toHaveBeenCalledOnce();

    view.rerender(<ScenarioEditorSurface {...props} active={false} />);
    expect(editorHeader).toHaveBeenCalledOnce();
  });
});
