// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import type { ScenarioDatasetDto } from "../../../src/lib/scenario/contracts";
import { ScenarioDatasetBrowser } from "../../../src/scenario/list/ScenarioDatasetBrowser";
import { ScenarioDatasetsClient } from "../../../src/scenario/ScenarioDatasetsClient";
import { StudioHostTestProvider } from "../../helpers/studio-host";
import {
  TopBarSlotProvider,
  useTopBarSlotContext,
} from "../../../src/components/TopBarSlot";
import { resetScenarioListCache } from "../../../src/scenario/list/scenarioListCache";

const push = vi.fn();
/**
 * The world scene is stubbed out here.
 *
 * It fetches the map catalog on mount, and this file drives `fetch` with `mockResolvedValueOnce`
 * queues — so the scene's request would consume the response queued for the dataset mutation under
 * test and the assertions would fail for a reason that has nothing to do with the list. The scene has
 * its own coverage in `test/scenario/map-preload.test.ts`.
 *
 * The `data-testid` is kept: one test asserts the scene is the *same DOM node* across a dataset
 * selection, which is the guard against reintroducing a remount.
 */
vi.mock("../../../src/scenario/scene/ScenarioIdleScene", () => ({
  ScenarioIdleScene: () => <div data-testid="scenario-idle-scene" />,
}));
vi.mock("../../../src/scenario/scene/useScenarioSession", () => ({
  useScenarioSession: ({ documentId }: { documentId: string | null }) => ({
    maps: [],
    map: null,
    document: documentId ? { id: documentId } : null,
    bundle: null,
    message: null,
    failed: false,
    updateDocument: vi.fn(),
    playback: {
      bundle: null,
      controller: null,
      state: null,
      error: null,
      inspecting: false,
      setInspecting: vi.fn(),
    },
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

function dataset(
  overrides: Partial<ScenarioDatasetDto> = {},
): ScenarioDatasetDto {
  return {
    id: "usds_1",
    workspaceId: "ws_1",
    name: "Cut-in corpus",
    description: "Fifty cut-ins at highway speed.",
    visibility: "workspace",
    isSystemManaged: false,
    systemSlug: null,
    isDefault: false,
    itemCount: 0,
    documentCount: 12,
    renderSubmittedCount: 9,
    renderCompletedCount: 7,
    exportCompletedCount: 5,
    createdByUserName: "Ada",
    updatedByUserName: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function browserHtml(
  overrides: Partial<
    React.ComponentProps<typeof ScenarioDatasetBrowser>
  > = {},
) {
  const datasets = overrides.datasets ?? [dataset()];
  return renderToString(
    <ScenarioDatasetBrowser
      datasets={datasets}
      orderedDatasets={overrides.orderedDatasets ?? datasets}
      datasetsLoading={false}
      expanded
      creatingDataset={false}
      onSelectDataset={() => {}}
      onOpenNewDatasetDialog={() => {}}
      {...overrides}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("ScenarioDatasetBrowser", () => {
  it("renders the five-layer hero banner through the token utilities", () => {
    const html = browserHtml();
    expect(html).toContain("list-hero-photo");
    expect(html).toContain("list-hero-veil-diagonal");
    expect(html).toContain("list-hero-veil-lateral");
    expect(html).toContain("list-hero-veil-glow");
    expect(html).toContain("list-hero-scanlines");
    // Every stop is an alpha over --surface-deep; none of them is re-inlined as a literal.
    expect(html).not.toContain("#050607");
    expect(html).not.toContain("rgba(5,6,7");
  });

  it("marks every hero layer decorative", () => {
    const html = browserHtml();
    const heroLayers = html.match(/list-hero-[a-z-]+/g) ?? [];
    expect(heroLayers.length).toBe(5);
    // Each layer div carries aria-hidden; the count of aria-hidden must at least cover them.
    expect(
      (html.match(/aria-hidden="true"/g) ?? []).length,
    ).toBeGreaterThanOrEqual(5);
  });

  it("renders the sticky column header", () => {
    const html = browserHtml();
    expect(html).toContain(">Dataset<");
    expect(html).toContain(">Renders<");
    expect(html).toContain(">Revisions<");
    expect(html).toContain(">Last Updated<");
  });

  it("shows documentCount, not itemCount", () => {
    // `itemCount` counts pinned revision×render-job pairs and reads 0 until someone pins one — it is
    // exactly the number v2's old grid showed for every dataset.
    const html = browserHtml({
      datasets: [dataset({ documentCount: 12, itemCount: 0 })],
    });
    expect(html).toContain("12 scenarios");
    expect(html).toContain("7 / 12");
  });

  it("singularises a one-scenario dataset", () => {
    const html = browserHtml({ datasets: [dataset({ documentCount: 1 })] });
    expect(html).toContain("1 scenario<");
  });

  it("prefers a live document count over the stored one", () => {
    const html = browserHtml({ documentCountsByDataset: { usds_1: 3 } });
    expect(html).toContain("3 scenarios");
  });

  describe("the shared-dataset reveal", () => {
    // Rendered rather than asserted against the server string: SSR splits interpolated text with
    // comment markers, so the reveal's label is only one string once it is in the DOM.
    function renderWith(shared: ScenarioDatasetDto) {
      const datasets = [dataset(), shared];
      render(
        <ScenarioDatasetBrowser
          datasets={datasets}
          orderedDatasets={datasets}
          datasetsLoading={false}
          expanded
          creatingDataset={false}
          onSelectDataset={() => {}}
          onOpenNewDatasetDialog={() => {}}
        />,
      );
    }

    it("collapses a system-managed dataset out of the default view", () => {
      renderWith(
        dataset({ id: "usds_public", name: "Public", isSystemManaged: true }),
      );
      const reveal = screen.getByTestId(
        "scenario-organization-datasets-reveal",
      );
      expect(reveal.textContent).toBe("Show 1 shared dataset");
      // The workspace's own datasets are what the operator sees first.
      expect(screen.queryByText("Public")).toBeNull();
      act(() => {
        screen.getByRole("button", { name: /Show 1 shared dataset/ }).click();
      });
      expect(screen.getByText("Public")).toBeTruthy();
      expect(
        screen.getByRole("button", { name: /Hide 1 shared dataset/ }),
      ).toBeTruthy();
      // Once revealed, it carries the read-only badge — mutability is derived, never stored (§6.5).
      expect(screen.getByText("Read-only")).toBeTruthy();
    });

    it("treats an organization-visible dataset as shared too", () => {
      renderWith(
        dataset({
          id: "usds_org",
          name: "Org wide",
          visibility: "organization",
        }),
      );
      expect(
        screen.getByTestId("scenario-organization-datasets-reveal")
          .textContent,
      ).toBe("Show 1 shared dataset");
    });

    it("pluralises the reveal", () => {
      const datasets = [
        dataset(),
        dataset({ id: "a", name: "A", isSystemManaged: true }),
        dataset({ id: "b", name: "B", visibility: "public" }),
      ];
      render(
        <ScenarioDatasetBrowser
          datasets={datasets}
          orderedDatasets={datasets}
          datasetsLoading={false}
          expanded
          creatingDataset={false}
          onSelectDataset={() => {}}
          onOpenNewDatasetDialog={() => {}}
        />,
      );
      expect(
        screen.getByTestId("scenario-organization-datasets-reveal")
          .textContent,
      ).toBe("Show 2 shared datasets");
    });
  });

  it("names the dataset in its actions menu label", () => {
    expect(browserHtml()).toContain(
      'aria-label="Dataset actions for Cut-in corpus"',
    );
  });

  it("announces the loading state instead of rendering an empty grid", () => {
    const html = browserHtml({
      datasets: [],
      datasetsLoading: true,
      orderedDatasets: [],
    });
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading datasets");
  });

  it("distinguishes an empty workspace from a loading one", () => {
    const html = browserHtml({
      datasets: [],
      datasetsLoading: false,
      orderedDatasets: [],
    });
    expect(html).toContain("No datasets yet");
  });

  describe("search", () => {
    function renderBrowser(datasets: ScenarioDatasetDto[]) {
      render(
        <ScenarioDatasetBrowser
          datasets={datasets}
          orderedDatasets={datasets}
          datasetsLoading={false}
          expanded
          creatingDataset={false}
          onSelectDataset={() => {}}
          onOpenNewDatasetDialog={() => {}}
        />,
      );
      return screen.getByLabelText("Search datasets");
    }

    it("matches on name and description", () => {
      const input = renderBrowser([
        dataset(),
        dataset({ id: "usds_2", name: "Jaywalking" }),
      ]);
      fireEvent.change(input, { target: { value: "jaywalk" } });
      expect(screen.getByText("Jaywalking")).toBeTruthy();
      expect(screen.queryByText("Cut-in corpus")).toBeNull();

      fireEvent.change(input, { target: { value: "highway speed" } });
      expect(screen.getByText("Cut-in corpus")).toBeTruthy();
    });

    it("matches on the dataset id", () => {
      const input = renderBrowser([dataset()]);
      fireEvent.change(input, { target: { value: "usds_1" } });
      expect(screen.getByText("Cut-in corpus")).toBeTruthy();
    });

    it("says so when nothing matches", () => {
      const input = renderBrowser([dataset()]);
      fireEvent.change(input, { target: { value: "zzz" } });
      expect(screen.getByText("No datasets match that search.")).toBeTruthy();
    });
  });
});

describe("ScenarioDatasetsClient", () => {
  const fetchMock = vi.fn<typeof fetch>();

  function TopBarActionHost() {
    const topBar = useTopBarSlotContext();
    return (
      <div>
        <span data-testid="test-topbar-title">{topBar?.customTitle}</span>
        <div
          ref={topBar?.registerActionsSlot}
          data-testid="test-topbar-actions"
        />
        <div
          ref={topBar?.registerTrailingSlot}
          data-testid="test-topbar-trailing"
        />
      </div>
    );
  }

  function renderDatasetsClient() {
    return render(
      <StudioHostTestProvider>
        <TopBarSlotProvider>
          <TopBarActionHost />
          <ScenarioDatasetsClient initialDatasets={[dataset()]} />
        </TopBarSlotProvider>
      </StudioHostTestProvider>,
    );
  }

  beforeEach(() => {
    resetScenarioListCache();
    fetchMock.mockReset();
    push.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders from initialDatasets without refetching the list", () => {
    renderDatasetsClient();
    expect(screen.getByTestId("test-topbar-title").textContent).toBe("Dataset");
    expect(screen.getByText("Cut-in corpus")).toBeTruthy();
    // Scoped to the datasets read rather than asserting no fetch at all: the world scene beside the rail
    // fetches the map catalog, which is unrelated to whether the seeded list was trusted.
    const datasetReads = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/api/simforge/datasets"),
    );
    expect(datasetReads).toEqual([]);
  });

  it("renders the dataset title and controls in the sidebar header", () => {
    renderDatasetsClient();
    const rail = screen.getByTestId("scenario-dataset-rail");
    const header = screen.getByTestId(
      "scenario-dataset-header",
    ).parentElement;
    const topBar = screen.getByTestId("test-topbar-actions");
    const filter = screen.getByRole("searchbox", { name: "Filter datasets" });
    const reviewQueue = screen.getByRole("link", { name: "Review queue" });
    const newDataset = screen.getByTestId("scenario-new-dataset");

    expect(
      screen.getByRole("heading", { name: "Datasets & Scenarios" }),
    ).toBeTruthy();
    expect(header?.contains(filter)).toBe(true);
    expect(header?.contains(reviewQueue)).toBe(true);
    expect(header?.contains(newDataset)).toBe(true);
    expect(rail.contains(filter)).toBe(true);
    expect(rail.contains(reviewQueue)).toBe(true);
    expect(rail.contains(newDataset)).toBe(true);
    expect(topBar.contains(filter)).toBe(false);
    expect(topBar.contains(reviewQueue)).toBe(false);
    expect(topBar.contains(newDataset)).toBe(false);
    expect(newDataset.className).toContain("justify-center");
    expect(newDataset.className).toContain("bg-[#E8E044]");
    expect(newDataset.className).toContain("font-bold");

    fireEvent.change(filter, { target: { value: "zzz" } });
    expect(screen.queryByText("Cut-in corpus")).toBeNull();
    expect(screen.getByText("Nothing matches “zzz”.")).toBeTruthy();
  });

  it("splices a created dataset in rather than refetching the list", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(dataset({ id: "usds_new", name: "Fresh corpus" }), 201),
    );
    renderDatasetsClient();
    act(() => {
      screen.getByTestId("scenario-new-dataset").click();
    });
    fireEvent.change(screen.getByPlaceholderText("Dataset name"), {
      target: { value: "Fresh corpus" },
    });
    await act(async () => {
      screen.getByRole("button", { name: "Create dataset" }).click();
    });
    await waitFor(() => expect(screen.getByText("Fresh corpus")).toBeTruthy());
    // One POST and no follow-up GET.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  it("shows a name collision in the dialog, beside the field to change", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "dataset_name_taken", field: "name" }, 409),
    );
    renderDatasetsClient();
    act(() => {
      screen.getByTestId("scenario-new-dataset").click();
    });
    fireEvent.change(screen.getByPlaceholderText("Dataset name"), {
      target: { value: "Cut-in corpus" },
    });
    await act(async () => {
      screen.getByRole("button", { name: "Create dataset" }).click();
    });
    await waitFor(() =>
      expect(screen.getByText(/already exists/)).toBeTruthy(),
    );
    // The dialog stays open with the typed name intact.
    expect(screen.getByPlaceholderText("Dataset name")).toHaveProperty(
      "value",
      "Cut-in corpus",
    );
  });

  it("keeps a deleted dataset when the delete fails, and offers a retry", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "dataset_action_denied" }, 403),
    );
    renderDatasetsClient();
    // The redesigned rail puts delete on the row, revealed by hover but always in the accessibility
    // tree, instead of behind an actions dropdown.
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /^Delete Cut-in corpus$/ }),
      );
    });
    await waitFor(() =>
      expect(screen.getByText(/do not have permission/)).toBeTruthy(),
    );
    expect(screen.getByText("Cut-in corpus")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("opens a dataset in place rather than navigating away from the world scene", () => {
    renderDatasetsClient();
    const scene = screen.getByTestId("scenario-idle-scene");
    act(() => {
      screen.getByText("Cut-in corpus").click();
    });
    expect(screen.getByTestId("test-topbar-title").textContent).toBe(
      "Cut-in corpus",
    );
    const scenarioHeader = screen.getByTestId(
      "scenario-scenario-list-header",
    );
    expect(scenarioHeader.className).not.toContain("bg-black");
    expect(scenarioHeader.className).toContain("border-b");
    expect(scenarioHeader.textContent).not.toMatch(/\d+ scenarios?\s*·\s*\d+ rendered/i);
    expect(screen.getByTestId("scenario-document-index").className).toContain(
      "bg-transparent",
    );
    const addScenario = screen.getByRole("button", { name: "Add scenario" });
    expect(screen.getByRole("heading", { name: "Scenarios" })).toBeTruthy();
    expect(scenarioHeader.contains(addScenario)).toBe(true);
    expect(
      screen.getByTestId("test-topbar-actions").contains(addScenario),
    ).toBe(false);
    // Two properties at once. v2's old grid linked straight to `/editor?datasetId=`, which made every
    // sibling document unreachable; the later fix routed to the dataset page, which disposed the WebGL
    // context and re-streamed the city. Neither is a navigation any more.
    expect(push).not.toHaveBeenCalled();
    // The same DOM node: a remount would replace it, and that is the regression this guards.
    expect(screen.getByTestId("scenario-idle-scene")).toBe(scene);
  });
});
