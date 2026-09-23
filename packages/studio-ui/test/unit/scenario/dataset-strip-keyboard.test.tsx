// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScenarioDatasetDto } from "../../../src/lib/scenario/contracts";
import { DatasetStrip } from "../../../src/scenario/rail/DatasetStrip";

/**
 * The dataset strip scrolls on its own, and a keyboard user moves through it with the arrow keys:
 * focus moves tile to tile and the tile column (never the page around it) follows the focus.
 */
function dataset(id: string, name: string): ScenarioDatasetDto {
  return {
    id, workspaceId: "ws_1", name, description: null, visibility: "workspace", isSystemManaged: false,
    systemSlug: null, isDefault: false, itemCount: 0, documentCount: 1, renderSubmittedCount: 0,
    renderCompletedCount: 0, exportCompletedCount: 0, createdByUserName: null, updatedByUserName: null,
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

const NAMES = ["Alpha", "Bravo", "Charlie", "Delta"];

function strip() {
  render(
    <DatasetStrip
      datasets={NAMES.map((name, index) => dataset(`usds_${index}`, name))}
      cloudHome={{ state: "managed", workspaceId: "ws_1", organizationId: "org_1", workspaceName: "Acme" }}
      loading={false}
      creating={false}
      busyDatasetId={null}
      activeDatasetId="usds_0"
      onSelectDataset={vi.fn()}
      onOpenNewDatasetDialog={vi.fn()}
      onEditDatasetDetails={vi.fn()}
      onDeleteDataset={vi.fn()}
    />,
  );
  return screen.getByTestId("scenario-dataset-rail-list");
}

const tile = (name: string) => screen.getByRole("button", { name });

afterEach(cleanup);

describe("dataset strip keyboard", () => {
  it("moves focus between tiles with the arrow keys, Home and End", () => {
    const list = strip();
    tile("Alpha").focus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(tile("Bravo"));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(tile("Delta"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement, "stops at the last tile").toBe(tile("Delta"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(tile("Charlie"));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(tile("Alpha"));
    expect(list.scrollTop).toBe(0);
  });

  it("leaves other keys and focus outside the tiles alone", () => {
    strip();
    tile("Alpha").focus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tile("Alpha"));
    const bravo = tile("Bravo");
    const caret = screen.getByRole("button", { name: "Dataset actions for Alpha" });
    caret.focus();
    fireEvent.keyDown(caret, { key: "ArrowDown" });
    // The caret's own menu may take the key; the strip does not move focus to another tile.
    expect(document.activeElement).not.toBe(bravo);
  });
});
