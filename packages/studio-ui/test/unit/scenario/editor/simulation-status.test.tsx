// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SimulationStatus } from "../../../../src/scenario/editor/SimulationStatus";

afterEach(cleanup);

describe("SimulationStatus", () => {
  it("shows a failed simulation's message and a Retry while retries remain", () => {
    const onRetry = vi.fn();
    render(
      <SimulationStatus
        verification={{ status: "failed", failureCode: "materialization_infeasible", message: "No lane fits the cut-in.", retriesRemaining: 2 }}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("Simulation failed")).toBeTruthy();
    expect(screen.getByTestId("simulation-failure-reason").textContent).toBe("No lane fits the cut-in.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("falls back to the humanized failure code and offers no Retry once the limit is reached", () => {
    render(
      <SimulationStatus
        verification={{ status: "failed", failureCode: "template_invalid", message: null, retriesRemaining: 0 }}
        onRetry={vi.fn()}
      />,
    );
    const reason = screen.getByTestId("simulation-failure-reason");
    expect(reason.textContent).toBe("Template invalid");
    expect(reason.getAttribute("title")).toContain("retry limit is reached");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers a re-check for a failure from a host that predates explicit retries", () => {
    render(
      <SimulationStatus
        verification={{ status: "failed", failureCode: "simulation_failed", message: "Runner offline", retriesRemaining: null }}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
