// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useScenarioOpenScenarioImport } from "../../../src/scenario/list/useScenarioOpenScenarioImport";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness() {
  const flow = useScenarioOpenScenarioImport({
    datasetId: "usds-1",
    maps: [{ mapVersionId: "map-version-1", sourceMapId: "map-source-1", label: "Test map" }],
    onImported: vi.fn(),
  });
  return (
    <>
      <button onClick={flow.openDialog} type="button">Open importer</button>
      {flow.dialog}
    </>
  );
}

function analysisResponse() {
  return {
    analysis: {
      standard: "ASAM OpenSCENARIO XML 1.4.0",
      source: { byteLength: 100, sha256: "a".repeat(64), fileName: "scenario.xosc" },
      title: "Reference scenario",
      logicFile: "test.xodr",
      embeddedMapIdentity: { mapVersionId: "map-version-1", mapId: null, xodrSha256: null },
      diagnostics: [
        { code: "actors_supported", path: "Entities", disposition: "supported", message: "Actors are converted." },
        { code: "storyboard_semantics_not_translated", path: "Storyboard.Story", disposition: "unsupported", message: "Storyboard behavior stays in the source file." },
      ],
      capabilities: { supported: 1, approximated: 0, unsupported: 1 },
    },
    resolution: {
      status: "resolved",
      source: "embedded-identity",
      requestedIdentity: "map-version-1",
      candidates: [{ mapVersionId: "map-version-1", label: "Test map" }],
      selectedMapVersionId: "map-version-1",
    },
  };
}

describe("OpenSCENARIO reference import", () => {
  it("summarizes conversion and requires acknowledgement for unsupported content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(analysisResponse())));
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Open importer" }));
    expect(screen.getByRole("heading", { name: "Open OpenSCENARIO as reference" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Choose OpenSCENARIO file"), {
      target: { files: [new File(["<OpenSCENARIO />"], "scenario.xosc", { type: "application/xml" })] },
    });

    const summary = await screen.findByTestId("xosc-conversion-summary");
    expect(summary.textContent).toContain("1 part will carry over");
    expect(summary.textContent).toContain("1 part will remain only in the source file");
    const createButton = screen.getByRole("button", { name: "Create reference scenario" });
    expect(createButton.hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByTestId("xosc-unsupported-acknowledgement"));
    await waitFor(() => expect(createButton.hasAttribute("disabled")).toBe(false));
  });
});
