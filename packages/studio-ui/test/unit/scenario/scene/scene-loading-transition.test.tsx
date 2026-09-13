// @vitest-environment jsdom
import type { ReactElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardLoadingProvider } from "../../../../src/components/DashboardLoadingCoordinator";
import { SceneLoadingTransition } from "../../../../src/scenario/scene/SceneLoadingTransition";
import { StudioHostTestProvider } from "../../../helpers/studio-host";
import { styles as coordinatorStyles } from "../../../../src/components/DashboardLoadingCoordinator.stylex";

/** One compiled atom of a StyleX namespace, by the property it declares. */
const atomFor = (namespace: object, property: string): string => {
  const key = Object.keys(namespace).find((k) => k.startsWith(`${property}-`));
  if (!key) throw new Error(`no compiled ${property} atom`);
  return (namespace as Record<string, string>)[key];
};

vi.mock("../../../../src/components/SkyCloudBackdrop", () => ({
  SkyCloudBackdrop: ({ className }: { className?: string }) => (
    <canvas className={className} data-testid="scene-cloud-canvas" />
  ),
}));

afterEach(() => cleanup());

/** The surface carries the cache-all-assets action, which reaches the host for the map catalog. */
function renderTransition(element: ReactElement) {
  return render(
    <StudioHostTestProvider>
      <DashboardLoadingProvider>{element}</DashboardLoadingProvider>
    </StudioHostTestProvider>,
  );
}

describe("SceneLoadingTransition", () => {
  it("publishes scene progress into the dashboard surface without a portal bridge", async () => {
    renderTransition(
      <SceneLoadingTransition
        progress={{
          phase: "assets",
          percent: 89,
          message: "Loading Belmont Research Center assets",
          detail: "1 downloading…",
        }}
        visible
      />,
    );

    await screen.findByText("Loading Belmont Research Center assets");
    const surface = screen.getByTestId("dashboard-loading-surface");
    expect(surface.parentElement).not.toBe(document.body);
    expect(surface.getAttribute("data-load-kind")).toBe("scene");
    expect(surface.getAttribute("data-load-phase")).toBe("assets");
    expect(surface.className).toContain(atomFor(coordinatorStyles.overlay, "zIndex"));
    expect(surface.className).toContain(
      atomFor(coordinatorStyles.overlayVisible, "backgroundColor"),
    );
    expect(screen.queryByTestId("scene-loading-prerender-cover")).toBeNull();
    expect(screen.queryByTestId("scene-loading-transition")).toBeNull();
    expect(screen.getByRole("button", { name: "Tip: Click here to cache all assets." }))
      .toBeTruthy();
  });

  it("shows exact transfer progress and calls out a stalled asset", async () => {
    renderTransition(
      <SceneLoadingTransition
        progress={{
          phase: "assets",
          percent: 61,
          message: "Loading Belmont assets",
          detail: "The connection may be stalled.",
          download: {
            transferred: "37.0 MB",
            total: "400 MB",
            speed: "0 B/s",
            stalled: true,
            stalledFor: "8s",
          },
        }}
        visible
      />,
    );

    const telemetry = await screen.findByTestId("dashboard-loading-telemetry");
    expect(telemetry.textContent).toContain("37.0 MB / 400 MB");
    expect(telemetry.textContent).toContain("0 B/s");
    expect(telemetry.textContent).toContain("No bytes received for 8s");
  });

  it("publishes an actionable error through the same surface", async () => {
    const retry = vi.fn();
    renderTransition(
      <SceneLoadingTransition
        onRetry={retry}
        progress={{
          phase: "error",
          percent: null,
          message: "Belmont could not load",
          detail: "The manifest request failed.",
        }}
        visible
      />,
    );

    await screen.findByText("Belmont could not load");
    expect(screen.getByRole("alert")).toBeTruthy();
    screen.getByRole("button", { name: "Try again" }).click();
    expect(retry).toHaveBeenCalledOnce();
  });
});
