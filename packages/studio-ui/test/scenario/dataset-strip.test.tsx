// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScenarioDatasetDto } from "../../src/lib/scenario/contracts";
import { datasetHue, datasetMonogram } from "../../src/lib/monogram";
import { DatasetStrip } from "../../src/scenario/rail/DatasetStrip";

/**
 * The dataset strip — the icon column at the far left of the scenario workspace.
 *
 * The strip shows no names, so the cases that matter are the ones that keep it usable without them:
 * every icon is named for assistive tech, the active one is announced, a system-managed dataset
 * gets no delete, and the monogram/hue a dataset is recognised by never changes under it.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

function dataset(
  id: string,
  overrides: Partial<ScenarioDatasetDto> = {},
): ScenarioDatasetDto {
  return {
    id,
    workspaceId: "ws_1",
    name: `Dataset ${id}`,
    description: null,
    visibility: "workspace",
    isSystemManaged: false,
    systemSlug: null,
    isDefault: false,
    itemCount: 0,
    documentCount: 3,
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

function renderStrip(
  props: Partial<Parameters<typeof DatasetStrip>[0]> = {},
) {
  const handlers = {
    onSelectDataset: vi.fn(),
    onPrefetchDataset: vi.fn(),
    onOpenNewDatasetDialog: vi.fn(),
    onEditDatasetDetails: vi.fn(),
    onDeleteDataset: vi.fn(),
  };
  render(
    <DatasetStrip
      datasets={[dataset("a")]}
      loading={false}
      creating={false}
      busyDatasetId={null}
      activeDatasetId={null}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

function icon(name: string) {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

afterEach(cleanup);

describe("datasetMonogram", () => {
  it("takes the initials of the first two words, else the first two characters", () => {
    expect(datasetMonogram("Cut-in corpus")).toBe("Cc");
    expect(datasetMonogram("Jaywalking")).toBe("Ja");
    expect(datasetMonogram("  ")).toBe("?");
  });
});

describe("datasetHue", () => {
  it("is a stable function of the id within the hue circle", () => {
    expect(datasetHue("usds_1")).toBe(datasetHue("usds_1"));
    expect(datasetHue("usds_1")).not.toBe(datasetHue("usds_2"));
    for (const id of ["a", "usds_1", "usds_2", "x".repeat(40)]) {
      const hue = datasetHue(id);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});

describe("DatasetStrip", () => {
  it("names every icon for assistive tech and announces the active one", () => {
    renderStrip({
      datasets: [dataset("a", { name: "Cut-in" }), dataset("b", { name: "Jaywalking" })],
      activeDatasetId: "b",
    });
    expect(screen.getByRole("navigation", { name: "Datasets" })).toBeTruthy();
    expect(icon("Cut-in").getAttribute("aria-current")).toBeNull();
    expect(icon("Jaywalking").getAttribute("aria-current")).toBe("true");
  });

  it("selects a dataset on click and prefetches on hover and on focus", () => {
    const handlers = renderStrip();
    fireEvent.click(icon("Dataset a"));
    expect(handlers.onSelectDataset).toHaveBeenCalledWith("a");
    fireEvent.mouseEnter(icon("Dataset a").closest("li")!);
    expect(handlers.onPrefetchDataset).toHaveBeenCalledWith("a");
    handlers.onPrefetchDataset.mockClear();
    fireEvent.focus(icon("Dataset a"));
    expect(handlers.onPrefetchDataset).toHaveBeenCalledWith("a");
  });

  it("offers a menu only for datasets the workspace can edit", () => {
    // Templates and shared datasets are read-only (§6.5): offering edit/delete and failing
    // server-side would be a worse answer than not offering it.
    renderStrip({
      datasets: [
        dataset("a"),
        dataset("tpl", { name: "Template", isSystemManaged: true }),
        dataset("org", { name: "Org wide", visibility: "organization" }),
      ],
    });
    expect(screen.getByRole("button", { name: "Dataset actions for Dataset a" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dataset actions for Template" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dataset actions for Org wide" })).toBeNull();
    // Read-only datasets sit below a divider, as Slack separates shared workspaces.
    expect(screen.getByRole("separator", { hidden: true })).toBeTruthy();
  });

  it("disables an icon while that dataset is busy, without disabling the others", () => {
    renderStrip({ datasets: [dataset("a"), dataset("b")], busyDatasetId: "a" });
    expect(icon("Dataset a").disabled).toBe(true);
    expect(icon("Dataset b").disabled).toBe(false);
  });

  it("disables the create control while a create is in flight", () => {
    renderStrip({ creating: true });
    expect(icon("New dataset").disabled).toBe(true);
  });

  it("shows placeholders while loading and nothing while genuinely empty", () => {
    const { unmount } = render(
      <DatasetStrip
        datasets={[]}
        loading
        creating={false}
        busyDatasetId={null}
        activeDatasetId={null}
        onSelectDataset={vi.fn()}
        onOpenNewDatasetDialog={vi.fn()}
        onEditDatasetDetails={vi.fn()}
        onDeleteDataset={vi.fn()}
      />,
    );
    expect(screen.getByRole("list").querySelectorAll("li").length).toBe(3);
    unmount();
    renderStrip({ datasets: [] });
    expect(screen.getByRole("list").querySelectorAll("li").length).toBe(0);
    // The way in is still there.
    expect(icon("New dataset")).toBeTruthy();
  });
});
