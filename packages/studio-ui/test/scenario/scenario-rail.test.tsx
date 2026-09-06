// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScenarioScenarioRail } from "../../src/scenario/rail/ScenarioScenarioRail";

afterEach(cleanup);

function renderRail(
  overrides: Partial<Parameters<typeof ScenarioScenarioRail>[0]> = {},
) {
  const onCreateDocument = vi.fn();
  render(
    <ScenarioScenarioRail
      datasetId="usds_1"
      datasetName="Cut-in corpus"
      documents={[]}
      activeDocumentId={null}
      loading={false}
      error={null}
      canCreate
      creating={false}
      autoplayPlaying={false}
      autoplayProgress={0}
      statusOpen={false}
      onSelectDocument={vi.fn()}
      onSelectPrevious={vi.fn()}
      onSelectNext={vi.fn()}
      onCreateDocument={onCreateDocument}
      onToggleAutoplay={vi.fn()}
      onToggleStatus={vi.fn()}
      {...overrides}
    />,
  );
  return { onCreateDocument };
}

describe("ScenarioScenarioRail", () => {
  it("keeps the scenario title and create action together in the sidebar header", () => {
    const { onCreateDocument } = renderRail();
    const header = screen.getByTestId("scenario-scenario-header");
    const addScenario = screen.getByRole("button", { name: "Add Scenario" });

    expect(screen.getByRole("heading", { name: "Scenarios" })).toBeTruthy();
    expect(screen.getByText("Cut-in corpus")).toBeTruthy();
    expect(header.contains(addScenario)).toBe(true);
    expect(addScenario.className).toContain("justify-center");
    expect(addScenario.className).toContain("bg-[#E8E044]");
    expect(addScenario.className).toContain("font-bold");
    expect(screen.getByTestId("scenario-scenario-rail").className).toContain(
      "bg-transparent",
    );
    expect(screen.getByTestId("scenario-scenario-header").nextElementSibling?.className).toContain(
      "scenario-glass-scrollbar",
    );
    fireEvent.click(addScenario);
    expect(onCreateDocument).toHaveBeenCalledOnce();
  });
});
