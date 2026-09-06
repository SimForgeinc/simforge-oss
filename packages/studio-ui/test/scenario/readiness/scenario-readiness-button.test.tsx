// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScenarioReadinessButton } from "../../../src/scenario/editor/readiness";
import {
  buildReadinessSummary,
  explainTechnicalMetrics,
} from "../../../src/scenario/editor/readiness/readiness-model";

afterEach(cleanup);

describe("scenario readiness", () => {
  it("shows a compact ready state when there are no issues", () => {
    render(<ScenarioReadinessButton issues={[]} />);

    const button = screen.getByRole("button", { name: "Scenario readiness: Ready" });
    expect(button.getAttribute("data-readiness-status")).toBe("ready");
    expect(within(button).getByText("Ready")).toBeTruthy();

    fireEvent.click(button);
    expect(screen.getByText("The preview is ready. New concerns will appear here.")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Realism" }).getAttribute("data-state")).toBe("active");
    expect(screen.getByRole("tab", { name: "Scenario behavior" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Export" })).toBeTruthy();
    expect(screen.getAllByLabelText("Looks good")).toHaveLength(1);
  });

  it("groups concerns and explains technical safety terms in plain language", () => {
    const summary = buildReadinessSummary([
      {
        id: "playback",
        severity: "error",
        title: "Playback controller failed",
        detail: "The preview could not start.",
      },
      {
        id: "engine-collision",
        severity: "warning",
        title: "TTC is too short",
        detail: "PET is below the desired range.",
      },
      {
        id: "materialization-note-0",
        severity: "warning",
        title: "Scenario detail was approximated",
        detail: "This action is unsupported by the export.",
      },
    ]);

    expect(summary.status).toBe("needs-attention");
    expect(summary.groups.behavior).toHaveLength(1);
    expect(summary.groups.realism).toHaveLength(1);
    expect(summary.groups.export).toHaveLength(1);
    expect(summary.groups.realism[0]?.title).toBe("time until a collision is too short");
    expect(summary.groups.realism[0]?.detail).toBe(
      "time between actors reaching the same point is below the desired range.",
    );
    expect(summary.groups.behavior[0]?.solution).toMatch(/start the preview again/i);
    expect(summary.groups.realism[0]?.solution).toMatch(/starting positions, speeds, or timing/i);
    expect(summary.groups.export[0]?.solution).toMatch(/supported by the selected export format/i);
    expect(explainTechnicalMetrics("TTC and PET")).toBe(
      "time until a collision and time between actors reaching the same point",
    );
  });

  it("opens grouped concerns and forwards a selected issue", () => {
    const issue = {
      id: "materialization-note-0",
      severity: "warning" as const,
      title: "Interaction was not included",
      detail: "The selected action cannot be represented in this export.",
    };
    const onSelectIssue = vi.fn();
    render(<ScenarioReadinessButton issues={[issue]} onSelectIssue={onSelectIssue} />);

    const button = screen.getByRole("button", {
      name: "Scenario readiness: Simulation warnings, 1 item",
    });
    expect(button.getAttribute("data-readiness-status")).toBe("needs-attention");
    expect(within(button).getByText("Simulation Warnings")).toBeTruthy();

    fireEvent.click(button);
    expect(screen.getByRole("tab", { name: "Realism" }).getAttribute("data-state")).toBe("active");
    fireEvent.click(screen.getByRole("tab", { name: "Export, 1 item" }));
    expect(within(screen.getByTestId("scenario-readiness-export")).getByText("1 item")).toBeTruthy();
    expect(screen.getByText("How to fix it")).toBeTruthy();
    expect(screen.getByText(/supported by the selected export format/i)).toBeTruthy();
    fireEvent.click(screen.getByTestId("scenario-readiness-issue"));
    expect(onSelectIssue).toHaveBeenCalledWith(issue);
  });
});
