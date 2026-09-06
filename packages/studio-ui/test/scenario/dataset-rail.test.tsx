// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScenarioDatasetDto } from "../../src/lib/scenario/contracts";
import { ScenarioDatasetRail } from "../../src/scenario/rail/ScenarioDatasetRail";

/**
 * The datasets rail — the left pane of the datasets page.
 *
 * The cases that matter are the ones the eye does not catch: a delete button offered on a system-managed
 * dataset, row actions that only exist on hover and so are unreachable from the keyboard, and the
 * distinction between "still loading" and "you have no datasets", which are the same empty list.
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

function renderRail(
  props: Partial<Parameters<typeof ScenarioDatasetRail>[0]> = {},
) {
  const handlers = {
    onSelectDataset: vi.fn(),
    onPrefetchDataset: vi.fn(),
    onOpenNewDatasetDialog: vi.fn(),
    onEditDatasetDetails: vi.fn(),
    onDeleteDataset: vi.fn(),
  };
  render(
    <ScenarioDatasetRail
      datasets={[dataset("a")]}
      loading={false}
      error={null}
      creating={false}
      busyDatasetId={null}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

/**
 * The row button for a dataset.
 *
 * Looked up by data attribute rather than accessible name: the row is named after the dataset, and so are
 * its Edit and Delete controls, so a name query matches three elements.
 */
function row(datasetId: string): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>(
    `[data-dataset-id="${datasetId}"]`,
  );
  if (!element) throw new Error(`no rail row for ${datasetId}`);
  return element;
}

afterEach(cleanup);

describe("ScenarioDatasetRail", () => {
  it("keeps the list title and controls together in the sidebar header", () => {
    renderRail();
    const header = screen.getByTestId(
      "scenario-dataset-header",
    ).parentElement;
    expect(header?.className).not.toContain("bg-black");
    expect(header?.className).toContain("border-b");
    expect(
      screen.getByRole("heading", { name: "Datasets & Scenarios" }),
    ).toBeTruthy();
    expect(
      header?.contains(
        screen.getByRole("searchbox", { name: "Filter datasets" }),
      ),
    ).toBe(true);
    const filter = screen.getByRole("searchbox", { name: "Filter datasets" });
    expect(filter.className).toContain("bg-transparent");
    expect(filter.className).toContain("border-0");
    expect(
      header?.contains(screen.getByRole("link", { name: "Review queue" })),
    ).toBe(true);
    expect(
      header?.contains(screen.getByTestId("scenario-new-dataset")),
    ).toBe(true);
    const create = screen.getByTestId("scenario-new-dataset");
    expect(create.className).toContain("justify-center");
    expect(create.className).toContain("bg-[#E8E044]");
    expect(create.className).toContain("font-bold");
    expect(header?.nextElementSibling?.className).toContain("scenario-glass-scrollbar");
  });

  it("lists each dataset without scenario or render counters", () => {
    renderRail({
      datasets: [dataset("a", {
        name: "Cut-in",
        documentCount: 12,
        renderCompletedCount: 4,
      })],
    });
    expect(screen.getByText("Cut-in")).toBeTruthy();
    expect(screen.queryByText("12 scenarios")).toBeNull();
    expect(screen.queryByText("4 rendered")).toBeNull();
  });

  it("selects a dataset on click", () => {
    const handlers = renderRail();
    fireEvent.click(row("a"));
    expect(handlers.onSelectDataset).toHaveBeenCalledWith("a");
  });

  it("prefetches on hover and on focus, not only on hover", () => {
    // Row prefetch driven by `mouseenter` alone leaves keyboard users with a cold navigation on every
    // dataset they open.
    const handlers = renderRail();
    const target = row("a");
    fireEvent.mouseEnter(target);
    expect(handlers.onPrefetchDataset).toHaveBeenCalledWith("a");

    handlers.onPrefetchDataset.mockClear();
    fireEvent.focus(target);
    expect(handlers.onPrefetchDataset).toHaveBeenCalledWith("a");
  });

  it("offers no delete for a system-managed dataset", () => {
    // These are templates the workspace does not own. Showing the control and failing server-side would
    // be a worse answer than not offering it.
    renderRail({ datasets: [dataset("a", { isSystemManaged: true })] });
    expect(screen.queryByRole("button", { name: /^Delete/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Edit/ })).toBeTruthy();
  });

  it("keeps the row actions in the accessibility tree rather than hiding them until hover", () => {
    // They are visually revealed with opacity, deliberately: `display: none` or a conditional mount
    // would make them unreachable by keyboard and invisible to assistive tech.
    renderRail();
    expect(
      screen.getByRole("button", { name: /^Edit Dataset a/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^Delete Dataset a/ }),
    ).toBeTruthy();
  });

  it("distinguishes loading from genuinely empty", () => {
    const { unmount } = render(
      <ScenarioDatasetRail
        datasets={[]}
        loading
        error={null}
        creating={false}
        busyDatasetId={null}
        onSelectDataset={vi.fn()}
        onOpenNewDatasetDialog={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByText("No datasets yet.")).toBeNull();
    unmount();

    renderRail({ datasets: [], loading: false });
    expect(screen.getByText("No datasets yet.")).toBeTruthy();
  });

  it("reports an error as an alert", () => {
    renderRail({ error: "Failed to load datasets." });
    expect(screen.getByRole("alert").textContent).toContain(
      "Failed to load datasets.",
    );
  });

  it("disables the create control while a create is in flight", () => {
    renderRail({ creating: true });
    const create = screen.getByRole("button", { name: /New dataset/ });
    expect((create as HTMLButtonElement).disabled).toBe(true);
  });

  it("presents new dataset as the centered primary action", () => {
    renderRail();
    const create = screen.getByRole("button", { name: /New dataset/ });
    expect(create.className).toContain("justify-center");
    expect(create.className).toContain("bg-[#E8E044]");
    expect(create.className).toContain("font-bold");
  });

  it("disables a row while that dataset is busy, without disabling the others", () => {
    renderRail({ datasets: [dataset("a"), dataset("b")], busyDatasetId: "a" });
    expect(row("a").disabled).toBe(true);
    expect(row("b").disabled).toBe(false);
  });
});
