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
    expect(surface.getAttribute("data-load-kind")).toBe("scene");
    expect(surface.getAttribute("data-load-phase")).toBe("resolving");
    expect(surface.className).not.toContain("dashboard-scene-loading-enter");
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
    act(() => vi.advanceTimersByTime(200));

    view.rerender(
      <DashboardLoadingProvider>
        <SourceProbe source={null} />
      </DashboardLoadingProvider>,
    );
    act(() => vi.advanceTimersByTime(16));
    expect(surface.getAttribute("data-transition-state")).toBe("revealing");
    expect(screen.getByTestId("dashboard-loading-surface")).toBe(surface);

    act(() => vi.advanceTimersByTime(899));
    expect(screen.getByTestId("dashboard-loading-surface")).toBe(surface);
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId("dashboard-loading-surface")).toBeNull();
  });

  it("surfaces an error with a reload action when a route source stalls", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
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
    screen.getByText("Loading is taking longer than expected");
    expect(
      screen.getByTestId("dashboard-loading-surface").textContent,
    ).toContain("Loading Scenarios");
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('route source "Loading Scenarios"'),
    );

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
