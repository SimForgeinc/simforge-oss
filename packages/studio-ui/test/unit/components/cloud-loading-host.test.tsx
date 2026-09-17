// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_LOADING_PATIENCE_MS,
  CLOUD_LOADING_STALL_MS,
  CloudLoadingHost,
} from "../../../src/components/CloudLoadingHost";
import { CloudLoadingSurface } from "../../../src/components/CloudLoadingSurface";
import type { CloudLoadingSource } from "../../../src/components/cloud-loading-context";

vi.mock("../../../src/components/SkyCloudBackdrop", () => ({
  SkyCloudBackdrop: ({ className }: { className?: string }) => (
    <canvas className={className} data-testid="coordinator-cloud-canvas" />
  ),
}));

/** What a route segment's `loading.tsx` publishes. */
function routeSource(label: string, detail: string, priority = 11): CloudLoadingSource {
  return {
    kind: "route",
    title: detail,
    detail: `Opening ${label.toLowerCase()} in your workspace.`,
    progress: null,
    priority,
  };
}

/** A screen-scoped surface written the way every consumer writes one. */
function SourceProbe({ source }: { source: CloudLoadingSource | null }) {
  if (!source) return null;
  const { severity, actions, ...rest } = source;
  return (
    <CloudLoadingSurface {...rest} role={severity === "error" ? "alert" : "status"} scope="screen">
      {actions}
    </CloudLoadingSurface>
  );
}

/**
 * A stalled load is no longer reported as a failure, so `role="alert"` is not
 * the signal any more: the host keeps the real source and publishes the stall
 * on the document root, which is also what automation reads.
 */
function stalled(): boolean {
  return document.documentElement.getAttribute("data-simforge-loading-stalled") === "true";
}

/** Drive the resource-timing observer the host uses to measure liveness. */
function installTransferObserver(): (bytes: number) => void {
  const callbacks: Array<(list: { getEntries: () => PerformanceEntry[] }) => void> = [];
  class FakeObserver {
    constructor(callback: (list: { getEntries: () => PerformanceEntry[] }) => void) {
      callbacks.push(callback);
    }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal("PerformanceObserver", FakeObserver);
  return (bytes: number) => {
    const entry = {
      entryType: "resource",
      initiatorType: "fetch",
      transferSize: bytes,
      encodedBodySize: bytes,
      decodedBodySize: bytes,
      responseEnd: 1,
      startTime: 0,
    } as unknown as PerformanceEntry;
    for (const callback of callbacks) callback({ getEntries: () => [entry] });
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CloudLoadingHost", () => {
  it("keeps one surface and cloud canvas through a route-to-scene handoff", async () => {
    const route = routeSource("Maps", "Loading map library…");
    const scene: CloudLoadingSource = {
      kind: "scene",
      title: "Preparing Belmont Research Center",
      detail: "Starting the renderer and loading map metadata…",
      progress: 20,
      phase: "resolving",
    };
    const view = render(
      <CloudLoadingHost>
        <SourceProbe source={route} />
      </CloudLoadingHost>,
    );

    await screen.findByText("Loading map library…");
    const surface = screen.getByTestId("cloud-loading-surface");
    const canvas = screen.getByTestId("coordinator-cloud-canvas");

    view.rerender(
      <CloudLoadingHost>
        <SourceProbe source={scene} />
      </CloudLoadingHost>,
    );

    await screen.findByText("Preparing Belmont Research Center");
    expect(screen.getByTestId("cloud-loading-surface")).toBe(surface);
    expect(screen.getByTestId("coordinator-cloud-canvas")).toBe(canvas);
    expect(screen.getAllByTestId("cloud-loading-surface")).toHaveLength(1);
  });

  it("chooses errors, editor boot, scene, then route in that order", async () => {
    const route = routeSource("Maps", "Loading map library…");
    const scene: CloudLoadingSource = {
      kind: "scene",
      title: "Loading scene",
      progress: 50,
    };
    const boot: CloudLoadingSource = {
      kind: "boot",
      title: "Preparing editor",
      progress: 70,
    };
    const error: CloudLoadingSource = {
      kind: "scene",
      title: "Scene failed",
      severity: "error",
    };
    const view = render(
      <CloudLoadingHost>
        <SourceProbe source={route} />
        <SourceProbe source={scene} />
        <SourceProbe source={boot} />
        <SourceProbe source={error} />
      </CloudLoadingHost>,
    );

    await screen.findByText("Scene failed");
    expect(screen.getByRole("alert")).toBeTruthy();

    view.rerender(
      <CloudLoadingHost>
        <SourceProbe source={route} />
        <SourceProbe source={scene} />
        <SourceProbe source={boot} />
      </CloudLoadingHost>,
    );
    await screen.findByText("Preparing editor");
  });

  it("reveals once after the final source clears", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) =>
      window.setTimeout(() => callback(performance.now()), 16),
    );
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) =>
      window.clearTimeout(handle),
    );
    const scene: CloudLoadingSource = {
      kind: "scene",
      title: "Loading scene",
      progress: 80,
    };
    const view = render(
      <CloudLoadingHost>
        <SourceProbe source={scene} />
      </CloudLoadingHost>,
    );
    const surface = screen.getByTestId("cloud-loading-surface");
    act(() => vi.advanceTimersByTime(1_000));

    view.rerender(
      <CloudLoadingHost>
        <SourceProbe source={null} />
      </CloudLoadingHost>,
    );
    act(() => vi.advanceTimersToNextTimer());
    expect(surface.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByTestId("cloud-loading-surface")).toBe(surface);

    act(() => vi.runOnlyPendingTimers());
    expect(screen.queryByTestId("cloud-loading-surface")).toBeNull();
  });

  it("keeps the load visible and offers a reload when nothing progresses", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const route = routeSource("Scenarios", "Loading Scenarios");
    render(
      <CloudLoadingHost>
        <SourceProbe source={route} />
      </CloudLoadingHost>,
    );

    act(() => vi.advanceTimersByTime(CLOUD_LOADING_STALL_MS - 1));
    expect(stalled()).toBe(false);

    act(() => vi.advanceTimersByTime(1));
    expect(stalled()).toBe(true);
    // The wait is described; the load is not declared failed.
    expect(screen.getByText(/still waiting/)).toBeTruthy();
    expect(screen.getByText(/No data has arrived for 45 seconds/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();

    const reloadSpy = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      reload: reloadSpy,
    } as unknown as Location);
    screen.getByRole("button", { name: "Reload" }).click();
    expect(reloadSpy).toHaveBeenCalled();
  });

  it("says how long it has been waiting once the load outlives the patience window", () => {
    vi.useFakeTimers();
    render(
      <CloudLoadingHost>
        <SourceProbe
          source={{ kind: "scene", title: "Preparing Belmont Research Center", detail: "Reading the map definition…", progress: 20 }}
        />
      </CloudLoadingHost>,
    );

    act(() => vi.advanceTimersByTime(CLOUD_LOADING_PATIENCE_MS - 1));
    expect(screen.queryByText(/waiting for/)).toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText(/Reading the map definition….*waiting for 20s/)).toBeTruthy();
  });

  it("treats responses the browser completed as progress", () => {
    vi.useFakeTimers();
    const transfer = installTransferObserver();
    render(
      <CloudLoadingHost>
        <SourceProbe source={{ kind: "scene", title: "Loading Garching Phase 1 2", progress: 55 }} />
      </CloudLoadingHost>,
    );

    // A large map streams for minutes behind one unchanging source line; each
    // completed response must restart the no-progress window.
    for (let round = 0; round < 6; round += 1) {
      act(() => vi.advanceTimersByTime(CLOUD_LOADING_STALL_MS - 5_000));
      act(() => transfer((round + 1) * 4_000_000));
      expect(stalled()).toBe(false);
    }

    // Bytes stop arriving: the window now runs out.
    act(() => vi.advanceTimersByTime(CLOUD_LOADING_STALL_MS));
    expect(stalled()).toBe(true);
  });

  it("restarts the stall window whenever the source content changes", async () => {
    vi.useFakeTimers();
    const first = routeSource("Scenarios", "Loading Scenarios");
    const view = render(
      <CloudLoadingHost>
        <SourceProbe source={first} />
      </CloudLoadingHost>,
    );

    act(() => vi.advanceTimersByTime(CLOUD_LOADING_STALL_MS - 1_000));
    view.rerender(
      <CloudLoadingHost>
        <SourceProbe
          source={routeSource("Dashboard", "Loading Dashboard")}
        />
      </CloudLoadingHost>,
    );
    act(() => vi.advanceTimersByTime(CLOUD_LOADING_STALL_MS - 1_000));
    expect(stalled()).toBe(false);

    act(() => vi.advanceTimersByTime(1_000));
    expect(stalled()).toBe(true);
  });

  it("pauses the stall deadline while hidden without discarding prior visible waiting", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    render(
      <CloudLoadingHost>
        <SourceProbe source={{ kind: "scene", title: "Finishing a map", progress: 90 }} />
      </CloudLoadingHost>,
    );

    act(() => vi.advanceTimersByTime(20_000));
    act(() => {
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => vi.advanceTimersByTime(CLOUD_LOADING_STALL_MS * 2));
    expect(stalled()).toBe(false);
    act(() => {
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => vi.advanceTimersByTime(CLOUD_LOADING_STALL_MS - 20_001));
    expect(stalled()).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(stalled()).toBe(true);
  });

  it("gives a source changed while hidden its full visible stall window", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let visibility: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const source: CloudLoadingSource = { kind: "scene", title: "Preparing a map", progress: 10 };
    const view = render(
      <CloudLoadingHost>
        <SourceProbe source={source} />
      </CloudLoadingHost>,
    );

    act(() => vi.advanceTimersByTime(CLOUD_LOADING_STALL_MS * 2));
    expect(stalled()).toBe(false);
    view.rerender(
      <CloudLoadingHost>
        <SourceProbe source={{ ...source, progress: 20 }} />
      </CloudLoadingHost>,
    );
    act(() => vi.advanceTimersByTime(CLOUD_LOADING_STALL_MS * 2));
    expect(stalled()).toBe(false);
    act(() => {
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => vi.advanceTimersByTime(CLOUD_LOADING_STALL_MS - 1));
    expect(stalled()).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(stalled()).toBe(true);
  });

  it("treats a cooperative stage heartbeat as progress", () => {
    vi.useFakeTimers();
    const source = (activityToken: number): CloudLoadingSource => ({
      kind: "scene",
      title: "Finishing Belmont Research Center",
      detail: "Checking the completed scene and preparing the first frame…",
      progress: 94,
      activityToken,
    });
    const view = render(
      <CloudLoadingHost>
        <SourceProbe source={source(0)} />
      </CloudLoadingHost>,
    );

    act(() => vi.advanceTimersByTime(CLOUD_LOADING_STALL_MS - 5_000));
    view.rerender(
      <CloudLoadingHost>
        <SourceProbe source={source(1)} />
      </CloudLoadingHost>,
    );
    act(() => vi.advanceTimersByTime(CLOUD_LOADING_STALL_MS - 5_000));

    expect(stalled()).toBe(false);
  });

  it("never raises the stall alarm after the source clears", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) =>
      window.setTimeout(() => callback(performance.now()), 16),
    );
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) =>
      window.clearTimeout(handle),
    );
    const route = routeSource("Scenarios", "Loading Scenarios");
    const view = render(
      <CloudLoadingHost>
        <SourceProbe source={route} />
      </CloudLoadingHost>,
    );

    act(() => vi.advanceTimersByTime(CLOUD_LOADING_STALL_MS - 1_000));
    view.rerender(
      <CloudLoadingHost>
        <SourceProbe source={null} />
      </CloudLoadingHost>,
    );
    act(() => vi.advanceTimersByTime(CLOUD_LOADING_STALL_MS * 2));
    expect(stalled()).toBe(false);
  });
});
