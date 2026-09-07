// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_LOADING_STALL_MS,
  DashboardLoadingProvider,
  dashboardRouteLoadingSource,
  useDashboardLoadingSource,
  type DashboardLoadingSource,
} from "../../../src/components/DashboardLoadingCoordinator";

vi.mock("../../../src/components/SkyCloudBackdrop", () => ({
  SkyCloudBackdrop: ({ className }: { className?: string }) => (
    <canvas className={className} data-testid="coordinator-cloud-canvas" />
  ),
}));

function SourceProbe({ source }: { source: DashboardLoadingSource | null }) {
  useDashboardLoadingSource(source);
  return null;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DashboardLoadingProvider", () => {
  it("keeps one surface and cloud canvas through a route-to-scene handoff", async () => {
    const route = dashboardRouteLoadingSource({
      label: "Maps",
      detail: "Loading map library…",
    });
    const scene: DashboardLoadingSource = {
      kind: "scene",
      title: "Preparing Belmont Research Center",
      detail: "Starting the renderer and loading map metadata…",
      progress: 20,
      progressLabel: "Map definition",
      phase: "resolving",
    };
    const view = render(
      <DashboardLoadingProvider>
        <SourceProbe source={route} />
      </DashboardLoadingProvider>,
    );

    await screen.findByText("Loading map library…");
    const surface = screen.getByTestId("dashboard-loading-surface");
    const canvas = screen.getByTestId("coordinator-cloud-canvas");

    view.rerender(
      <DashboardLoadingProvider>
        <SourceProbe source={scene} />
      </DashboardLoadingProvider>,
    );

    await screen.findByText("Preparing Belmont Research Center");
    expect(screen.getByTestId("dashboard-loading-surface")).toBe(surface);
    expect(screen.getByTestId("coordinator-cloud-canvas")).toBe(canvas);
    expect(screen.getAllByTestId("dashboard-loading-surface")).toHaveLength(1);
  });

  it("chooses errors, editor boot, scene, then route in that order", async () => {
    const route = dashboardRouteLoadingSource({
      label: "Maps",
      detail: "Loading map library…",
    });
    const scene: DashboardLoadingSource = {
      kind: "scene",
      title: "Loading scene",
      progress: 50,
    };
    const boot: DashboardLoadingSource = {
      kind: "boot",
      title: "Preparing editor",
      progress: 70,
    };
    const error: DashboardLoadingSource = {
      kind: "scene",
      title: "Scene failed",
      severity: "error",
    };
    const view = render(
      <DashboardLoadingProvider>
        <SourceProbe source={route} />
        <SourceProbe source={scene} />
        <SourceProbe source={boot} />
        <SourceProbe source={error} />
      </DashboardLoadingProvider>,
    );

    await screen.findByText("Scene failed");
    expect(screen.getByRole("alert")).toBeTruthy();

    view.rerender(
      <DashboardLoadingProvider>
        <SourceProbe source={route} />
        <SourceProbe source={scene} />
        <SourceProbe source={boot} />
      </DashboardLoadingProvider>,
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
    const scene: DashboardLoadingSource = {
      kind: "scene",
      title: "Loading scene",
      progress: 80,
    };
    const view = render(
      <DashboardLoadingProvider>
        <SourceProbe source={scene} />
      </DashboardLoadingProvider>,
    );
    const surface = screen.getByTestId("dashboard-loading-surface");
    act(() => vi.advanceTimersByTime(1_000));

    view.rerender(
      <DashboardLoadingProvider>
        <SourceProbe source={null} />
      </DashboardLoadingProvider>,
    );
    act(() => vi.advanceTimersToNextTimer());
    expect(surface.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByTestId("dashboard-loading-surface")).toBe(surface);

    act(() => vi.runOnlyPendingTimers());
    expect(screen.queryByTestId("dashboard-loading-surface")).toBeNull();
  });

  it("surfaces an error with a reload action when a route source stalls", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const route = dashboardRouteLoadingSource({
      label: "Scenarios",
      detail: "Loading Scenarios",
    });
    render(
      <DashboardLoadingProvider>
        <SourceProbe source={route} />
      </DashboardLoadingProvider>,
    );

    act(() => vi.advanceTimersByTime(DASHBOARD_LOADING_STALL_MS - 1));
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
    const first = dashboardRouteLoadingSource({
      label: "Scenarios",
      detail: "Loading Scenarios",
    });
    const view = render(
      <DashboardLoadingProvider>
        <SourceProbe source={first} />
      </DashboardLoadingProvider>,
    );

    act(() => vi.advanceTimersByTime(DASHBOARD_LOADING_STALL_MS - 1_000));
    view.rerender(
      <DashboardLoadingProvider>
        <SourceProbe
          source={dashboardRouteLoadingSource({
            label: "Dashboard",
            detail: "Loading Dashboard",
          })}
        />
      </DashboardLoadingProvider>,
    );
    act(() => vi.advanceTimersByTime(DASHBOARD_LOADING_STALL_MS - 1_000));
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
      <DashboardLoadingProvider>
        <SourceProbe source={{ kind: "scene", title: "Finishing a map", progress: 90 }} />
      </DashboardLoadingProvider>,
    );

    act(() => vi.advanceTimersByTime(20_000));
    act(() => {
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => vi.advanceTimersByTime(DASHBOARD_LOADING_STALL_MS * 2));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => {
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => vi.advanceTimersByTime(DASHBOARD_LOADING_STALL_MS - 20_001));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("gives a source changed while hidden its full visible stall window", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let visibility: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const source: DashboardLoadingSource = { kind: "scene", title: "Preparing a map", progress: 10 };
    const view = render(
      <DashboardLoadingProvider>
        <SourceProbe source={source} />
      </DashboardLoadingProvider>,
    );

    act(() => vi.advanceTimersByTime(DASHBOARD_LOADING_STALL_MS * 2));
    expect(screen.queryByRole("alert")).toBeNull();
    view.rerender(
      <DashboardLoadingProvider>
        <SourceProbe source={{ ...source, progress: 20 }} />
      </DashboardLoadingProvider>,
    );
    act(() => vi.advanceTimersByTime(DASHBOARD_LOADING_STALL_MS * 2));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => {
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => vi.advanceTimersByTime(DASHBOARD_LOADING_STALL_MS - 1));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("treats a cooperative stage heartbeat as progress", () => {
    vi.useFakeTimers();
    const source = (activityToken: number): DashboardLoadingSource => ({
      kind: "scene",
      title: "Finishing Belmont Research Center",
      detail: "Checking the completed scene and preparing the first frame…",
      progress: 94,
      activityToken,
    });
    const view = render(
      <DashboardLoadingProvider>
        <SourceProbe source={source(0)} />
      </DashboardLoadingProvider>,
    );

    act(() => vi.advanceTimersByTime(DASHBOARD_LOADING_STALL_MS - 5_000));
    view.rerender(
      <DashboardLoadingProvider>
        <SourceProbe source={source(1)} />
      </DashboardLoadingProvider>,
    );
    act(() => vi.advanceTimersByTime(DASHBOARD_LOADING_STALL_MS - 5_000));

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
    const route = dashboardRouteLoadingSource({
      label: "Scenarios",
      detail: "Loading Scenarios",
    });
    const view = render(
      <DashboardLoadingProvider>
        <SourceProbe source={route} />
      </DashboardLoadingProvider>,
    );

    act(() => vi.advanceTimersByTime(DASHBOARD_LOADING_STALL_MS - 1_000));
    view.rerender(
      <DashboardLoadingProvider>
        <SourceProbe source={null} />
      </DashboardLoadingProvider>,
    );
    act(() => vi.advanceTimersByTime(DASHBOARD_LOADING_STALL_MS * 2));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
