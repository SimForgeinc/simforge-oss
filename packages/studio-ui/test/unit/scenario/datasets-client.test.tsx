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
import type { ScenarioDatasetDto } from "../../../src/lib/scenario/contracts";
import { ScenarioDatasetsClient } from "../../../src/scenario/ScenarioDatasetsClient";
import { StudioHostTestProvider } from "../../helpers/studio-host";
import {
  TopBarSlotProvider,
  useTopBarSlotContext,
} from "../../../src/components/TopBarSlot";
import { resetScenarioListCache } from "../../../src/scenario/list/scenarioListCache";

const push = vi.fn();
/**
 * The coverage map is stubbed out here.
 *
 * The real one owns a MapLibre instance and fetches map footprints; this file drives `fetch` with
 * queued responses, so those requests would consume the response queued for the dataset mutation
 * under test and the assertions would fail for a reason that has nothing to do with the list.
 *
 * The `data-testid` is kept: one test asserts the browsing surface is the *same DOM node* across a
 * dataset selection, which is the guard against reintroducing a remount.
 */
vi.mock("../../../src/scenario/coverage/ScenarioCoverageMap", () => ({
  ScenarioCoverageMap: () => <div data-testid="scenario-coverage-map" />,
}));
// Dataset CRUD does not instantiate the retained GPU world or the editor runtime.
vi.mock("../../../src/scenario/scene/ScenarioWorldProvider", () => ({
  ScenarioWorldSurface: () => null,
}));
vi.mock("../../../src/scenario/editor/ScenarioEditorClient", () => ({
  ScenarioEditorClient: () => null,
}));
vi.mock("../../../src/scenario/render/DatasetRenderPane", () => ({
  DatasetRenderPane: () => null,
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

/**
 * The reads the open column makes on mount — its documents, readiness, the tag catalog, the map
 * catalog — answered empty, with one override for the mutation under test.
 */
function quietHost(
  override?: (url: string, init: RequestInit | undefined) => Response | null,
): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const overridden = override?.(url, init);
    if (overridden) return overridden;
    if (url.includes("/api/simforge/tags")) return jsonResponse({ tags: [] });
    if (url.includes("/api/simforge/documents/summaries")) {
      return jsonResponse({ documents: [], nextCursor: null });
    }
    return jsonResponse({});
  };
}

afterEach(() => {
  cleanup();
});

describe("ScenarioDatasetsClient", () => {
  const fetchMock = vi.fn<typeof fetch>();

  function TopBarActionHost() {
    const topBar = useTopBarSlotContext();
    return (
      <div>
        <span data-testid="test-topbar-title">{topBar?.header?.title}</span>
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
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    resetScenarioListCache();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/dashboard/scenario");
    fetchMock.mockReset();
    fetchMock.mockImplementation(quietHost());
    push.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Radix opens a menu on `pointerdown`, not `click`, and only mounts its items once open. */
  function openMenu(name: RegExp | string) {
    act(() => {
      fireEvent.pointerDown(screen.getByRole("button", { name }), {
        button: 0,
        ctrlKey: false,
        pointerType: "mouse",
      });
    });
  }

  function selectMenuItem(name: RegExp | string) {
    // Radix selects on the pointer-up/click sequence, with a `click` as the final event.
    const item = screen.getByRole("menuitem", { name });
    act(() => {
      fireEvent.pointerMove(item, { pointerType: "mouse" });
      fireEvent.click(item);
    });
  }

  it("switches narrow list and detail without remounting the coverage scene", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    window.localStorage.setItem("uniscenario.scenario-list-width.v2", "520");
    renderDatasetsClient();
    const coverage = screen.getByTestId("scenario-coverage-map");
    expect(screen.getByRole("button", { name: "List", exact: true }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("separator")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Detail", exact: true }));
    expect(screen.getByRole("button", { name: "Detail", exact: true }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("scenario-coverage-map")).toBe(coverage);
    fireEvent.click(screen.getByRole("button", { name: "List", exact: true }));
    expect(screen.getByRole("button", { name: "Cut-in corpus" })).toBeTruthy();
    expect(screen.getByTestId("scenario-coverage-map")).toBe(coverage);
  });

  it("lands on the seeded dataset without refetching the list, and reflects it in the URL", () => {
    renderDatasetsClient();
    // The strip is always visible and the column always shows a dataset: one dataset means it is open.
    expect(screen.getByTestId("test-topbar-title").textContent).toBe("Cut-in corpus");
    expect(
      screen.getByRole("button", { name: "Cut-in corpus" }).getAttribute("aria-current"),
    ).toBe("true");
    expect(screen.getByRole("heading", { name: "Cut-in corpus" })).toBeTruthy();
    expect(new URL(window.location.href).searchParams.get("dataset")).toBe("usds_1");
    // Selected in place; a navigation would remount the world scene.
    expect(push).not.toHaveBeenCalled();
    // Scoped to the datasets read rather than asserting no fetch at all: the column fetches the
    // dataset's documents, which is unrelated to whether the seeded list was trusted.
    const datasetReads = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).includes("/api/simforge/datasets") && (init?.method ?? "GET") === "GET",
    );
    expect(datasetReads).toEqual([]);
  });

  it("keeps the dataset strip, the column header and the add affordances out of the top bar", () => {
    renderDatasetsClient();
    const strip = screen.getByTestId("scenario-dataset-rail");
    const header = screen.getByTestId("scenario-scenario-list-header");
    const topBar = screen.getByTestId("test-topbar-actions");
    const newDataset = screen.getByTestId("scenario-new-dataset");
    const reviewQueue = screen.getByRole("link", { name: "Review queue" });
    expect(strip.contains(newDataset)).toBe(true);
    expect(strip.contains(reviewQueue)).toBe(true);
    // Slack's channel header: the name, then the description, then the tools.
    expect(screen.getByTestId("scenario-dataset-description").textContent).toBe(
      "Fifty cut-ins at highway speed.",
    );
    // The tools are icons in the header's top-right corner; the search field only
    // appears once its button is pressed, and closing it clears the query.
    expect(screen.queryByRole("searchbox", { name: "Filter scenarios by name" })).toBeNull();
    expect(header.contains(screen.getByRole("button", { name: "Filter scenarios" }))).toBe(true);
    expect(header.contains(screen.getByRole("button", { name: "Edit tags" }))).toBe(true);
    // Corner, not a toolbar row: the tools end the row the dataset name opens,
    // and the scenario/render counts that used to sit under it are gone.
    const titleRow = screen.getByRole("heading", { name: "Cut-in corpus" }).closest("div");
    const tools = screen.getByRole("button", { name: "Edit tags" }).parentElement;
    expect(titleRow?.lastElementChild).toBe(tools);
    expect(header.textContent).not.toMatch(/\d+\s+scenarios?/i);
    expect(header.textContent).not.toMatch(/rendered/i);
    fireEvent.click(screen.getByRole("button", { name: "Search scenarios" }));
    const search = screen.getByRole("searchbox", { name: "Filter scenarios by name" });
    expect(header.contains(search)).toBe(true);
    fireEvent.change(search, { target: { value: "cut-in" } });
    fireEvent.click(screen.getByRole("button", { name: "Hide scenario search" }));
    expect(screen.queryByRole("searchbox", { name: "Filter scenarios by name" })).toBeNull();
    expect(header.contains(screen.getByTestId("scenario-add-scenario"))).toBe(true);
    // And "Add scenario" again as the last row of the list, like Slack's "Add channels".
    const index = screen.getByTestId("scenario-document-index");
    const footerRow = screen.getByTestId("scenario-add-scenario-row");
    expect(index.lastElementChild === footerRow || index.contains(footerRow)).toBe(true);
    expect(header.contains(footerRow)).toBe(false);
    expect(topBar.childElementCount).toBe(0);
  });

  it("offers a way in when the workspace has no datasets", () => {
    render(
      <StudioHostTestProvider>
        <TopBarSlotProvider>
          <ScenarioDatasetsClient initialDatasets={[]} />
        </TopBarSlotProvider>
      </StudioHostTestProvider>,
    );
    expect(screen.getByText("No datasets yet")).toBeTruthy();
    act(() => {
      screen.getByRole("button", { name: "Create dataset" }).click();
    });
    expect(screen.getByPlaceholderText("Dataset name")).toBeTruthy();
  });

  it("splices a created dataset in and lands on it rather than refetching the list", async () => {
    fetchMock.mockImplementation(
      quietHost((url, init) =>
        init?.method === "POST" && url.includes("/api/simforge/datasets")
          ? jsonResponse(dataset({ id: "usds_new", name: "Fresh corpus" }), 201)
          : null,
      ),
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
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Fresh corpus" })).toBeTruthy(),
    );
    expect(
      screen.getByRole("button", { name: "Fresh corpus" }).getAttribute("aria-current"),
    ).toBe("true");
    // One POST and no follow-up GET of the list.
    const datasetCalls = fetchMock.mock.calls.filter(([url]) =>
      /\/api\/simforge\/datasets(\?|$)/.test(String(url)),
    );
    expect(datasetCalls).toHaveLength(1);
    expect(datasetCalls[0]?.[1]?.method).toBe("POST");
  });

  it("shows a name collision in the dialog, beside the field to change", async () => {
    fetchMock.mockImplementation(
      quietHost((url, init) =>
        init?.method === "POST" && url.includes("/api/simforge/datasets")
          ? jsonResponse({ error: "dataset_name_taken", field: "name" }, 409)
          : null,
      ),
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
    fetchMock.mockImplementation(
      quietHost((_url, init) =>
        init?.method === "DELETE" ? jsonResponse({ error: "dataset_action_denied" }, 403) : null,
      ),
    );
    renderDatasetsClient();
    // Delete lives in the column header's dataset menu, under the name — as in Slack's channel menu.
    openMenu("Cut-in corpus dataset menu");
    await act(async () => {
      selectMenuItem("Delete dataset");
    });
    await waitFor(() =>
      expect(screen.getByText(/do not have permission/)).toBeTruthy(),
    );
    expect(screen.getByRole("heading", { name: "Cut-in corpus" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("switches datasets in place rather than navigating away from the coverage map", () => {
    render(
      <StudioHostTestProvider>
        <TopBarSlotProvider>
          <TopBarActionHost />
          <ScenarioDatasetsClient
            initialDatasets={[dataset(), dataset({ id: "usds_2", name: "Jaywalking", description: null })]}
          />
        </TopBarSlotProvider>
      </StudioHostTestProvider>,
    );
    const scene = screen.getByTestId("scenario-coverage-map");
    expect(screen.getByTestId("test-topbar-title").textContent).toBe("Cut-in corpus");
    act(() => {
      screen.getByRole("button", { name: "Jaywalking" }).click();
    });
    expect(screen.getByTestId("test-topbar-title").textContent).toBe("Jaywalking");
    expect(screen.getByRole("heading", { name: "Jaywalking" })).toBeTruthy();
    expect(new URL(window.location.href).searchParams.get("dataset")).toBe("usds_2");
    // Two properties at once. v2's old grid linked straight to `/editor?datasetId=`, which made every
    // sibling document unreachable; the later fix routed to the dataset page, which rebuilt the whole
    // browsing surface. Neither is a navigation any more.
    expect(push).not.toHaveBeenCalled();
    // The same DOM node: a remount would replace it, and that is the regression this guards.
    expect(screen.getByTestId("scenario-coverage-map")).toBe(scene);
  });

  it("returns to the last opened dataset on the next visit", () => {
    const two = [dataset(), dataset({ id: "usds_2", name: "Jaywalking" })];
    const first = render(
      <StudioHostTestProvider>
        <TopBarSlotProvider>
          <ScenarioDatasetsClient initialDatasets={two} />
        </TopBarSlotProvider>
      </StudioHostTestProvider>,
    );
    act(() => {
      screen.getByRole("button", { name: "Jaywalking" }).click();
    });
    first.unmount();
    window.history.replaceState(null, "", "/dashboard/scenario");
    resetScenarioListCache();
    render(
      <StudioHostTestProvider>
        <TopBarSlotProvider>
          <ScenarioDatasetsClient initialDatasets={two} />
        </TopBarSlotProvider>
      </StudioHostTestProvider>,
    );
    expect(
      screen.getByRole("button", { name: "Jaywalking" }).getAttribute("aria-current"),
    ).toBe("true");
  });
});
