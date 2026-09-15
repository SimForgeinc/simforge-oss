// @vitest-environment jsdom
import type { ReactElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudLoadingHost } from "../../../../src/components/CloudLoadingHost";
import { CloudLoadingSurface } from "../../../../src/components/CloudLoadingSurface";
import type { SceneLoadProgress } from "../../../../src/scenario/scene/map-load-progress";
import { useSceneLoadingSurfaceProps } from "../../../../src/scenario/scene/scene-loading";
import { StudioHostTestProvider } from "../../../helpers/studio-host";
import { styles as coordinatorStyles } from "../../../../src/components/CloudLoadingHost.stylex";

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

/** The scene cover exactly as `ScenarioWorldHost` writes it. */
function SceneCover({ progress, onRetry }: { progress: SceneLoadProgress; onRetry?: () => void }) {
  return <CloudLoadingSurface scope="screen" {...useSceneLoadingSurfaceProps(progress, onRetry)} />;
}

function renderTransition(element: ReactElement) {
  return render(
    <StudioHostTestProvider>
      <CloudLoadingHost>{element}</CloudLoadingHost>
    </StudioHostTestProvider>,
  );
}

describe("the scene load cover", () => {
  it("publishes scene progress into the hosted surface without a portal bridge", async () => {
    renderTransition(
      <SceneCover
        progress={{
          phase: "assets",
          percent: 89,
          message: "Loading Belmont Research Center assets",
          detail: "1 downloading…",
        }}
      />,
    );

    await screen.findByText("Loading Belmont Research Center assets");
    const surface = screen.getByTestId("cloud-loading-surface");
    expect(surface.parentElement).not.toBe(document.body);
    expect(surface.getAttribute("data-load-kind")).toBe("scene");
    expect(surface.getAttribute("data-load-phase")).toBe("assets");
    expect(surface.className).toContain(atomFor(coordinatorStyles.overlay, "zIndex"));
    expect(surface.className).toContain(
      atomFor(coordinatorStyles.overlayVisible, "backgroundColor"),
    );
    expect(screen.queryByTestId("scene-loading-prerender-cover")).toBeNull();
    expect(screen.queryByTestId("scene-loading-transition")).toBeNull();
  });

  it("shows how much of the map is loaded and calls out a stall without network framing", async () => {
    renderTransition(
      <SceneCover
        progress={{
          phase: "assets",
          percent: 61,
          message: "Loading Belmont",
          detail: "No map data has arrived for 8s.",
          download: {
            transferred: "37.0 MB",
            total: "400 MB",
            stalled: true,
            stalledFor: "8s",
          },
        }}
      />,
    );

    const telemetry = await screen.findByTestId("cloud-loading-telemetry");
    expect(telemetry.textContent).toContain("37.0 MB of 400 MB");
    expect(telemetry.textContent).not.toMatch(/\/s|download/i);
    expect(telemetry.textContent).toContain("No data received for 8s");
  });

  it("publishes an actionable error through the same surface", async () => {
    const retry = vi.fn();
    renderTransition(
      <SceneCover
        onRetry={retry}
        progress={{
          phase: "error",
          percent: null,
          message: "Belmont could not load",
          detail: "The manifest request failed.",
        }}
      />,
    );

    await screen.findByText("Belmont could not load");
    expect(screen.getByRole("alert")).toBeTruthy();
    screen.getByRole("button", { name: "Try again" }).click();
    expect(retry).toHaveBeenCalledOnce();
  });
});
