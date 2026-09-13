// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DashboardLoadingProvider } from "../../../../src/components/DashboardLoadingCoordinator";
import { ScenarioBootGate } from "../../../../src/scenario/editor/status/ScenarioBootGate";
import { useScenarioNotificationStore } from "../../../../src/scenario/editor/status/notification-store";

afterEach(() => {
  cleanup();
  useScenarioNotificationStore.getState().reset();
});

describe("ScenarioBootGate cloud loading", () => {
  it("uses a full cloud blocker for non-error boot progress", () => {
    useScenarioNotificationStore.getState().publish({
      key: "editor-boot",
      severity: "progress",
      source: "scenario",
      message: "Loading scenario document",
      detail: "The editor remains mounted while this finishes.",
      progress: 42,
      blocking: true,
    });

    render(
      <DashboardLoadingProvider>
        <ScenarioBootGate />
      </DashboardLoadingProvider>,
    );

    const gate = screen.getByTestId("dashboard-loading-surface");
    // "screen" scope is the blocker contract: the surface takes the whole viewport rather
    // than sitting inside a pane, and it reports itself as busy work rather than an error.
    expect(gate.getAttribute("data-cloud-loading-scope")).toBe("screen");
    expect(gate.getAttribute("data-load-kind")).toBe("boot");
    expect(gate.getAttribute("aria-busy")).toBe("true");
    expect(gate.getAttribute("role")).toBe("status");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42");
    expect(screen.getByText("Loading scenario document")).toBeTruthy();
    expect(screen.getByText("The editor remains mounted while this finishes.")).toBeTruthy();
  });

  it("keeps actionable boot failures as an error surface", () => {
    useScenarioNotificationStore.getState().publish({
      key: "editor-boot-error",
      severity: "error",
      source: "scenario",
      message: "Scenario could not be loaded",
      detail: "Try the request again.",
      blocking: true,
    });

    render(
      <DashboardLoadingProvider>
        <ScenarioBootGate />
      </DashboardLoadingProvider>,
    );

    const gate = screen.getByTestId("dashboard-loading-surface");
    expect(screen.getByRole("alert")).toBe(gate);
    expect(gate.getAttribute("data-load-kind")).toBe("boot");
    // An actionable failure still covers the viewport, but it stops claiming to be busy and
    // announces itself assertively instead of politely.
    expect(gate.getAttribute("data-cloud-loading-scope")).toBe("screen");
    expect(gate.getAttribute("aria-busy")).toBe("false");
    expect(gate.getAttribute("aria-live")).toBe("assertive");
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByTestId("scenario-boot-gate")).toBeNull();
  });
});
