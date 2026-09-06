// @vitest-environment jsdom
import { act, cleanup, render as renderView, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Viewer from "@simforge-oss/viewer";
import { ScenarioWorldHost } from "../../src/scenario/scene/ScenarioWorldHost";
import { saveRenderingPreference } from "../../src/components/rendering-preference";
import { ScenarioWorkspaceStatusProvider } from "../../src/scenario/editor/status";
import { DashboardLoadingProvider } from "../../src/components/DashboardLoadingCoordinator";
import { StudioHostTestProvider } from "../helpers/studio-host";

const {
  constructions,
  loads,
  disposals,
  rendererDisposals,
  setLiveQuality,
  setAuthoringFidelity,
  setLayerVisible,
} = vi.hoisted(
  () => ({
    constructions: vi.fn(),
    loads: vi.fn<(manifestUrl: string) => Promise<void>>(() =>
      Promise.resolve(),
    ),
    disposals: vi.fn(),
    rendererDisposals: vi.fn(),
    setLiveQuality: vi.fn(),
    setAuthoringFidelity: vi.fn(),
    setLayerVisible: vi.fn(),
  }),
);

// The world host builds its actor layer from the viewer package; the real
// renderer paints shadow textures through canvas 2D, which jsdom does not have.
vi.mock("@simforge-oss/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof Viewer>()),
  ActorRenderer: class {
    readonly group = { name: "" };
    dispose = rendererDisposals;
  },
}));

vi.mock("@simforge-oss/viewer/react", async () => {
  const React = await import("react");
  class FakeCityViewer {
    readonly renderer: { domElement: HTMLCanvasElement };
    readonly scene = { add: vi.fn() };
    constructor(canvas: HTMLCanvasElement, options: unknown) {
      constructions(options);
      this.renderer = { domElement: canvas };
    }
    loadMap = loads;
    dispose = disposals;
    setLiveQuality = setLiveQuality;
    setAuthoringFidelity = setAuthoringFidelity;
    setLayerVisible = setLayerVisible;
  }
  return {
    CityView({
      manifestUrl,
      options,
      onReady,
      onMapLoaded,
      onError,
    }: {
      manifestUrl: string;
      options?: unknown;
      onReady?: (viewer: FakeCityViewer) => void;
      onMapLoaded?: (manifestUrl: string) => void;
      onError?: (error: unknown, manifestUrl: string) => void;
    }) {
      const canvasRef = React.useRef<HTMLCanvasElement>(null);
      const viewerRef = React.useRef<FakeCityViewer | null>(null);
      const generationRef = React.useRef(0);
      const [error, setError] = React.useState<unknown>(null);
      React.useEffect(() => {
        const viewer = new FakeCityViewer(canvasRef.current!, options);
        viewerRef.current = viewer;
        onReady?.(viewer);
        return () => viewer.dispose();
      }, []);
      React.useEffect(() => {
        const viewer = viewerRef.current;
        if (!viewer) return;
        const generation = ++generationRef.current;
        setError(null);
        viewer.loadMap(manifestUrl).then(
          () => generation === generationRef.current && onMapLoaded?.(manifestUrl),
          (reason) => {
            if (generation !== generationRef.current) return;
            setError(reason);
            onError?.(reason, manifestUrl);
          },
        );
      }, [manifestUrl]);
      return <canvas ref={canvasRef} data-error={error ? String(error) : undefined} />;
    },
  };
});

const first = {
  mapVersionId: "mapv_one",
  manifestUrl: "/maps/one/manifest.json",
  label: "One",
};
const second = {
  mapVersionId: "mapv_two",
  manifestUrl: "/maps/two/manifest.json",
  label: "Two",
};

/** The loading surface carries the cache-all-assets action, which reaches the host for the map catalog. */
function wrap(ui: ReactNode) {
  return (
    <StudioHostTestProvider>
      <DashboardLoadingProvider>{ui}</DashboardLoadingProvider>
    </StudioHostTestProvider>
  );
}

function render(ui: ReactNode) {
  const view = renderView(wrap(ui));
  return {
    ...view,
    rerender(nextUi: ReactNode) {
      view.rerender(wrap(nextUi));
    },
  };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  constructions.mockClear();
  loads.mockClear();
  disposals.mockClear();
  rendererDisposals.mockClear();
  setLiveQuality.mockClear();
  setAuthoringFidelity.mockClear();
  setLayerVisible.mockClear();
});

describe("persistent SimForge world host", () => {

  it("keeps the same canvas, viewer, and instance identity across same-map mode renders", async () => {
    const onViewerChange = vi.fn();
    const onStateChange = vi.fn();
    const view = render(
      <ScenarioWorldHost
        target={first}
        onViewerChange={onViewerChange}
        onActorRendererChange={vi.fn()}
        onStateChange={onStateChange}
      />,
    );
    const host = view.getByTestId("scenario-world-host");
    const canvas = host.querySelector("canvas");
    const viewer = onViewerChange.mock.calls[0]?.[0];
    const instanceId = host.getAttribute("data-world-instance-id");

    act(() => saveRenderingPreference("minimal"));
    view.rerender(
      <ScenarioWorldHost
        target={{ ...first, manifestUrl: "/api/maps/mapv_one/browser-assets/manifest.json" }}
        onViewerChange={onViewerChange}
        onActorRendererChange={vi.fn()}
        onStateChange={onStateChange}
      />,
    );

    expect(
      view.getByTestId("scenario-world-host").querySelector("canvas"),
    ).toBe(canvas);
    expect(
      view
        .getByTestId("scenario-world-host")
        .getAttribute("data-world-instance-id"),
    ).toBe(instanceId);
    expect(onViewerChange).toHaveBeenCalledWith(viewer);
    expect(constructions).toHaveBeenCalledOnce();
    expect(loads).toHaveBeenCalledOnce();
    expect(host.getAttribute("data-world-manifest-url")).toBe(first.manifestUrl);
    expect(disposals).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(host.getAttribute("data-world-loaded-map-version-id")).toBe(
        "mapv_one",
      ),
    );
  });

  it("loads a deliberate map change through the same viewer instead of replacing WebGL", async () => {
    const view = render(
      <ScenarioWorkspaceStatusProvider>
        <ScenarioWorldHost
          target={first}
          onViewerChange={vi.fn()}
          onActorRendererChange={vi.fn()}
          onStateChange={vi.fn()}
        />
      </ScenarioWorkspaceStatusProvider>,
    );
    const canvas = view.container.querySelector("canvas");

    view.rerender(
      <ScenarioWorkspaceStatusProvider>
        <ScenarioWorldHost
          target={second}
          onViewerChange={vi.fn()}
          onActorRendererChange={vi.fn()}
          onStateChange={vi.fn()}
        />
      </ScenarioWorkspaceStatusProvider>,
    );

    await waitFor(() =>
      expect(loads).toHaveBeenLastCalledWith(second.manifestUrl),
    );
    expect(view.container.querySelector("canvas")).toBe(canvas);
    expect(constructions).toHaveBeenCalledOnce();
    expect(disposals).not.toHaveBeenCalled();
  });

  it("covers the workspace with the shared cloud loader during a map change", async () => {
    const view = render(
      <ScenarioWorkspaceStatusProvider>
        <ScenarioWorldHost
          target={first}
          onViewerChange={vi.fn()}
          onActorRendererChange={vi.fn()}
          onStateChange={vi.fn()}
        />
      </ScenarioWorkspaceStatusProvider>,
    );
    await waitFor(() =>
      expect(
        view.getByTestId("scenario-world-host").getAttribute("data-world-loaded-map-version-id"),
      ).toBe(first.mapVersionId),
    );

    let completeMapLoad!: () => void;
    loads.mockImplementation(
      () => new Promise<void>((resolve) => {
        completeMapLoad = resolve;
      }),
    );
    view.rerender(
      <ScenarioWorkspaceStatusProvider>
        <ScenarioWorldHost
          target={second}
          onViewerChange={vi.fn()}
          onActorRendererChange={vi.fn()}
          onStateChange={vi.fn()}
        />
      </ScenarioWorkspaceStatusProvider>,
    );

    await waitFor(() => expect(loads).toHaveBeenLastCalledWith(second.manifestUrl));
    expect(view.getByTestId("dashboard-loading-surface")).toBeTruthy();
    expect(view.getByText("Loading Two")).toBeTruthy();
    expect(view.getByText("Preparing the map definition…")).toBeTruthy();

    completeMapLoad();
    await waitFor(() =>
      expect(view.queryByTestId("dashboard-loading-surface")).toBeNull(),
    );
  });

  it("does not publish runtime readiness until building and GPU queues settle", async () => {
    let completeMapLoad!: () => void;
    loads.mockImplementation(
      () => new Promise<void>((resolve) => {
        completeMapLoad = resolve;
      }),
    );
    const onViewerChange = vi.fn();
    const view = render(
      <ScenarioWorkspaceStatusProvider>
        <ScenarioWorldHost
          target={first}
          onViewerChange={onViewerChange}
          onActorRendererChange={vi.fn()}
          onStateChange={vi.fn()}
        />
      </ScenarioWorkspaceStatusProvider>,
    );
    await waitFor(() => expect(loads).toHaveBeenCalledOnce());
    const viewer = onViewerChange.mock.calls[0]?.[0] as Record<string, unknown>;
    viewer.roadReady = true;
    viewer.getStats = () => ({
      roadVisible: true,
      loading: 1,
      queued: 0,
      uploading: 0,
      streamingError: null,
    });
    viewer.controls = {
      getView: () => ({ position: [0, 10, 10], target: [0, 0, 0], fov: 45 }),
      applyView: vi.fn(),
      setEnabled: vi.fn(),
    };
    viewer.setCameraPoseConstraintsEnabled = vi.fn();

    completeMapLoad();

    await waitFor(() => expect(view.getByText("Loading One assets")).toBeTruthy());
    expect(
      view
        .getByTestId("scenario-world-host")
        .getAttribute("data-world-loaded-map-version-id"),
    ).toBe("");
    expect(
      view
        .getByTestId("scenario-world-host")
        .getAttribute("data-world-transition"),
    ).toBe("loading");
    expect(view.getByText("Loading One assets")).toBeTruthy();
    expect(view.getByText("1 downloading…")).toBeTruthy();
  });

  it("ignores a stale map failure after the next target starts and clears error on success", async () => {
    let rejectFirst!: (reason: unknown) => void;
    let resolveSecond!: () => void;
    loads.mockImplementation((manifestUrl) =>
      new Promise<void>((resolve, reject) => {
        if (manifestUrl === first.manifestUrl) rejectFirst = reject;
        else resolveSecond = resolve;
      }),
    );
    const onStateChange = vi.fn();
    const view = render(
      <ScenarioWorldHost
        target={first}
        onViewerChange={vi.fn()}
        onActorRendererChange={vi.fn()}
        onStateChange={onStateChange}
      />,
    );
    await waitFor(() => expect(loads).toHaveBeenCalledWith(first.manifestUrl));
    view.rerender(
      <ScenarioWorldHost
        target={second}
        onViewerChange={vi.fn()}
        onActorRendererChange={vi.fn()}
        onStateChange={onStateChange}
      />,
    );
    await waitFor(() => expect(loads).toHaveBeenCalledWith(second.manifestUrl));

    rejectFirst(new Error("stale A failure"));
    resolveSecond();

    const host = view.getByTestId("scenario-world-host");
    await waitFor(() =>
      expect(host.getAttribute("data-world-loaded-map-version-id")).toBe(
        "mapv_two",
      ),
    );
    expect(host.querySelector("canvas")?.hasAttribute("data-error")).toBe(false);
    expect(onStateChange.mock.calls.at(-1)?.[0]).toMatchObject({
      loadedMapVersionId: "mapv_two",
      error: null,
    });
  });
});
