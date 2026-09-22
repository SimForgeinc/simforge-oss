// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudLoadingHost } from "../../../../src/components/CloudLoadingHost";
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
      <CloudLoadingHost>
        <ScenarioBootGate />
      </CloudLoadingHost>,
    );

    const gate = screen.getByTestId("cloud-loading-surface");
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
    const retry = vi.fn();
    useScenarioNotificationStore.getState().publish({
      key: "editor-boot-error",
      action: { label: "Retry", run: retry },
      severity: "error",
      source: "scenario",
      message: "Scenario could not be loaded",
      detail: "Try the request again.",
      blocking: true,
    });

    render(
      <CloudLoadingHost>
        <ScenarioBootGate />
      </CloudLoadingHost>,
    );

    const alert = screen.getByRole("alert");
    expect(within(alert).queryByRole("progressbar")).toBeNull();
    expect(alert.getAttribute("aria-busy")).not.toBe("true");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(within(alert).getByRole("link", { name: "Back to scenarios" }).getAttribute("href")).toBe("/dashboard/scenario");
  });
});
