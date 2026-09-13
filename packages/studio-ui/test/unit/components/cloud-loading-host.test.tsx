// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
    eyebrow: "SimForge",
    progress: null,
    progressLabel: "Cloud workspace",
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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
      progressLabel: "Map definition",
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

  it("surfaces an error with a reload action when a route source stalls", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const route = routeSource("Scenarios", "Loading Scenarios");
    render(
      <CloudLoadingHost>
        <SourceProbe source={route} />
      </CloudLoadingHost>,
    );

    act(() => vi.advanceTimersByTime(CLOUD_LOADING_STALL_MS - 1));
    expect(screen.queryByRole("alert")).toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("alert")).toBeTruthy();

    const reloadSpy = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      reload: reloadSpy,
    } as unknown as Location);
    screen.getByRole("button", { name: "Reload" }).click();
    expect(reloadSpy).toHaveBeenCalled();
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
    expect(screen.queryByRole("alert")).toBeNull();

    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByRole("alert")).toBeTruthy();
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
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => {
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => vi.advanceTimersByTime(CLOUD_LOADING_STALL_MS - 20_001));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("alert")).toBeTruthy();
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
    expect(screen.queryByRole("alert")).toBeNull();
    view.rerender(
      <CloudLoadingHost>
        <SourceProbe source={{ ...source, progress: 20 }} />
      </CloudLoadingHost>,
    );
    act(() => vi.advanceTimersByTime(CLOUD_LOADING_STALL_MS * 2));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => {
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => vi.advanceTimersByTime(CLOUD_LOADING_STALL_MS - 1));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("alert")).toBeTruthy();
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

    expect(screen.queryByRole("alert")).toBeNull();
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
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
