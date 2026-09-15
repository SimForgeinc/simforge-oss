// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScenarioDatasetDto } from "../../../src/lib/scenario/contracts";
import { DatasetStrip } from "../../../src/scenario/rail/DatasetStrip";
import type { DatasetCloudHome } from "../../../src/scenario/rail/dataset-home";

/**
 * The dataset strip's home sections.
 *
 * These cover the one rule the strip exists to express and cannot express any other way: a dataset
 * has exactly one home, and a home is never a mirror
 * (`docs/engineering/local-cloud-boundary.md` §2). Each case here is a claim the UI would be making
 * falsely if it regressed — a dataset in two sections, a silent gap that reads as "you have no
 * cloud datasets", or one organization's list implying it is the whole account.
 */
function dataset(overrides: Partial<ScenarioDatasetDto> = {}): ScenarioDatasetDto {
  return {
    id: "usds_1",
    workspaceId: "ws_1",
    name: "Uncategorized",
    description: null,
    visibility: "workspace",
    isSystemManaged: false,
    systemSlug: null,
    isDefault: false,
    itemCount: 0,
    documentCount: 1,
    renderSubmittedCount: 0,
    renderCompletedCount: 0,
    exportCompletedCount: 0,
    createdByUserName: null,
    updatedByUserName: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function strip(cloudHome: DatasetCloudHome, datasets = [dataset({ id: "usds_local" })]) {
  return render(
    <DatasetStrip
      datasets={datasets}
      cloudHome={cloudHome}
      loading={false}
      creating={false}
      busyDatasetId={null}
      activeDatasetId={null}
      onSelectDataset={vi.fn()}
      onOpenNewDatasetDialog={vi.fn()}
      onEditDatasetDetails={vi.fn()}
      onDeleteDataset={vi.fn()}
    />,
  );
}

/** The section headings in order, each as `[label, note?]`. */
function headings() {
  return [...document.querySelectorAll('[data-testid="scenario-dataset-rail"] ul > li')]
    .filter((li) => li.getAttribute("role") === "presentation" && li.querySelector("span[tabindex]"))
    .map((li) => [...li.querySelectorAll("span")].map((span) => span.textContent?.trim()));
}

afterEach(() => {
  cleanup();
});

describe("dataset strip home sections", () => {
  it("gives a dataset exactly one home, even when both homes hold the same name", () => {
    strip(
      {
        state: "connected",
        organizationName: "Acme",
        organizationCount: 1,
        datasets: [dataset({ id: "usds_cloud", name: "Uncategorized" })],
      },
      [dataset({ id: "usds_local", name: "Uncategorized" })],
    );
    const rows = [...document.querySelectorAll("li[data-dataset-id]")];
    expect(rows.map((row) => row.getAttribute("data-dataset-id"))).toEqual([
      "usds_local",
      "usds_cloud",
    ]);
    // The local dataset is operable; the cloud one states presence and offers no action, because
    // moving a dataset between homes is not something this strip does.
    expect(rows[0]!.querySelector('[data-testid="scenario-dataset-icon"]')!.tagName).toBe("BUTTON");
    const cloudTile = rows[1]!.querySelector('[data-testid="scenario-cloud-dataset-icon"]')!;
    expect(cloudTile.tagName).toBe("SPAN");
    expect(cloudTile.closest("a, button")).toBeNull();
    // The three states the boundary document rejects must have no rendering at all.
    expect(document.body.textContent).not.toMatch(/synced|mirror|available offline/i);
  });

  it("distinguishes an organization that owns nothing from no connection at all", () => {
    const connected = strip({
      state: "connected",
      organizationName: "Acme",
      organizationCount: 1,
      datasets: [],
    });
    expect(headings()[1]).toEqual(["Acme", "No datasets"]);
    expect(screen.queryByTestId("scenario-dataset-cloud-connect")).toBeNull();
    connected.unmount();

    strip({ state: "signed-out" });
    expect(headings()[1]).toEqual(["SimCloud", "Signed out"]);
    expect(screen.getByTestId("scenario-dataset-cloud-connect").getAttribute("href")).toBe(
      "/dashboard/simcloud",
    );
  });

  it("refuses to imply one organization's datasets are the whole account", () => {
    const several = strip({
      state: "connected",
      organizationName: "Path PC Test's workspace",
      organizationCount: 3,
      datasets: [dataset({ id: "usds_cloud" })],
    });
    expect(headings()).toEqual([
      ["On this computer"],
      ["Path PC Test's workspace", "1 of 3 orgs"],
    ]);
    several.unmount();

    // With nothing else to disclose, the heading is just the organization's name.
    strip({
      state: "connected",
      organizationName: "Path PC Test's workspace",
      organizationCount: 1,
      datasets: [dataset({ id: "usds_cloud" })],
    });
    expect(headings()).toEqual([["On this computer"], ["Path PC Test's workspace"]]);
  });

  it("reveals a cloud dataset's name and organization on hover", async () => {
    strip({
      state: "connected",
      organizationName: "Path PC Test's workspace",
      organizationCount: 1,
      datasets: [dataset({ id: "usds_cloud", name: "Night drives" })],
    });
    fireEvent.mouseEnter(document.querySelector('li[data-dataset-id="usds_cloud"]')!);
    await waitFor(() => {
      const tips = [...document.querySelectorAll('[role="tooltip"]')]
        .map((tip) => tip.textContent)
        .join(" ");
      expect(tips).toMatch(/Night drives/);
      expect(tips).toMatch(/In Path PC Test's workspace/);
    });
  });

  it("caps a large organization and sends the remainder to the SimCloud panel", () => {
    strip({
      state: "connected",
      organizationName: "Acme",
      organizationCount: 1,
      datasets: Array.from({ length: 760 }, (_, index) =>
        dataset({ id: `usds_c${index}`, name: `D${index}` }),
      ),
    });
    expect(document.querySelectorAll('[data-testid="scenario-cloud-dataset-icon"]').length).toBe(24);
    const overflow = screen.getByTestId("scenario-dataset-cloud-overflow");
    expect(overflow.textContent).toMatch(/\+736/);
    expect(overflow.getAttribute("href")).toBe("/dashboard/simcloud");
  });
});
