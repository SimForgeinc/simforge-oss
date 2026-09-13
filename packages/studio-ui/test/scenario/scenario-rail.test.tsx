// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScenarioScenarioRail } from "../../src/scenario/rail/ScenarioScenarioRail";
import { rail as railStyles } from "../../src/scenario/scenario-controls.stylex";

/** One compiled atom of a StyleX namespace, by the property it declares. */
const atomFor = (namespace: object, property: string): string => {
  const key = Object.keys(namespace).find((k) => k.startsWith(`${property}-`));
  if (!key) throw new Error(`no compiled ${property} atom`);
  return (namespace as Record<string, string>)[key];
};

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
    // The accent footer style — centered, on the accent fill, in the heavy meta
    // weight — as the atoms the compiler emitted, not as literal class text.
    for (const property of ["justifyContent", "backgroundColor", "fontWeight"]) {
      expect(addScenario.className).toContain(
        atomFor(railStyles.footerAction, property),
      );
    }
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
