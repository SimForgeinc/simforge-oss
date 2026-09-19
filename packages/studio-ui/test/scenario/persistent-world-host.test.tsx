// @vitest-environment jsdom
import { act, cleanup, render as renderView, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Viewer from "@simforge-oss/viewer";
import { CityView } from "@simforge-oss/viewer/react";
import { ScenarioWorldHost } from "../../src/scenario/scene/ScenarioWorldHost";
import { ScenarioWorldProvider, ScenarioWorldSurface } from "../../src/scenario/scene/ScenarioWorldProvider";
import { readRenderingPreference, saveRenderingPreference } from "../../src/components/rendering-preference";
import { ScenarioWorkspaceStatusProvider } from "../../src/scenario/editor/status";
import { CloudLoadingHost } from "../../src/components/CloudLoadingHost";
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

// Exercise the real React lifetime. A second implementation of CityView here
// hid the options-identity loop: the fake mounted once while production
// recreated WebGL on every progress update. Only the GPU work is replaced.
vi.mock("../../../viewer/src/viewer", () => ({
  CityViewer: class {
    readonly renderer: { domElement: HTMLCanvasElement };
    readonly scene = { add: vi.fn(), getObjectByName: () => undefined };
    constructor(canvas: HTMLCanvasElement, options: unknown) {
      constructions(options);
      if (constructions.mock.calls.length > 10) throw new Error("renderer construction loop");
      this.renderer = { domElement: canvas };
    }
    loadMap = loads;
    dispose = disposals;
    getCapabilities = () => [];
    getRendererCapability = () => ({ backend: "test" });
    getStats = () => ({ byteBudget: 1, residentBytes: 0, pendingBytes: 0 });
    setLiveQuality = setLiveQuality;
    setAuthoringFidelity = setAuthoringFidelity;
    setLayerVisible = setLayerVisible;
    setRenderingSuspended = vi.fn();
    setActivityHeld = vi.fn();
    resetCamera = vi.fn();
    setWeatherAppearance = vi.fn();
  },
}));

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
      <CloudLoadingHost>{ui}</CloudLoadingHost>
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
  vi.unstubAllGlobals();
  window.localStorage.clear();
  constructions.mockClear();
  loads.mockReset().mockResolvedValue();
  disposals.mockClear();
  rendererDisposals.mockClear();
  setLiveQuality.mockClear();
  setAuthoringFidelity.mockClear();
  setLayerVisible.mockClear();
});

describe("persistent SimForge world host", () => {
  it("moves one loaded canvas between route viewports without loading the map again", async () => {
    const callbacks = { onViewerChange: vi.fn(), onActorRendererChange: vi.fn(), onStateChange: vi.fn() };
    const view = render(
      <ScenarioWorldProvider keepAlive>
        <ScenarioWorldSurface key="gallery" target={first} {...callbacks} />
      </ScenarioWorldProvider>,
    );
    await waitFor(() => expect(callbacks.onStateChange.mock.calls.at(-1)?.[0].loadedMapVersionId).toBe(first.mapVersionId));
    const canvas = view.container.querySelector("canvas");
    view.rerender(<ScenarioWorldProvider keepAlive>{null}</ScenarioWorldProvider>);
    expect(view.container.querySelector("canvas")).toBeNull();
    view.rerender(
      <ScenarioWorldProvider keepAlive>
        <ScenarioWorldSurface key="editor" target={{ ...first, manifestUrl: "/another/url/for/the/same/version.json" }} {...callbacks} />
      </ScenarioWorldProvider>,
    );
    expect(view.container.querySelector("canvas")).toBe(canvas);
    expect(callbacks.onStateChange.mock.calls.at(-1)?.[0].loadedMapVersionId).toBe(first.mapVersionId);
    expect(constructions).toHaveBeenCalledOnce();
    expect(loads).toHaveBeenCalledOnce();
    expect(disposals).not.toHaveBeenCalled();

    view.rerender(
      <ScenarioWorldProvider>
        <ScenarioWorldSurface key="other-map" target={second} {...callbacks} />
      </ScenarioWorldProvider>,
    );
    await waitFor(() => expect(loads).toHaveBeenLastCalledWith(second.manifestUrl));
    expect(view.container.querySelector("canvas")).toBe(canvas);
    expect(constructions).toHaveBeenCalledOnce();
    view.rerender(<ScenarioWorldProvider>{null}</ScenarioWorldProvider>);
    expect(disposals).toHaveBeenCalledOnce();
    expect(view.container.querySelector("canvas")).toBeNull();
  });

  it("does not publish a completed map from a released viewer", async () => {
    let complete!: () => void;
    loads.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
    const onMapLoaded = vi.fn();
    const view = render(<CityView manifestUrl={first.manifestUrl} onMapLoaded={onMapLoaded} />);
    view.unmount();
    await act(async () => { complete(); });
    expect(onMapLoaded).not.toHaveBeenCalled();
  });


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

    act(() => saveRenderingPreference("low"));
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
    expect(view.getByTestId("cloud-loading-surface")).toBeTruthy();

    completeMapLoad();
    await waitFor(() =>
      expect(view.queryByTestId("cloud-loading-surface")).toBeNull(),
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

    await waitFor(() =>
      expect(
        view.getByTestId("scenario-world-host").getAttribute("data-world-transition"),
      ).toBe("loading"),
    );
    expect(
      view
        .getByTestId("scenario-world-host")
        .getAttribute("data-world-loaded-map-version-id"),
    ).toBe("");
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
