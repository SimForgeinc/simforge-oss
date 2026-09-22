// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScenarioTransferCandidateDto } from "@simforge-oss/studio-host";
import type { ScenarioDocumentSummaryDto } from "../../src/lib/scenario/contracts";
import { ScenarioTransferOverlay } from "../../src/scenario/list/transfer/ScenarioTransferOverlay";
import { StudioHostTestProvider } from "../helpers/studio-host";

/**
 * The transfer overlay against the real HTTP host with `fetch` stubbed: it
 * lists the other maps at once, fills each map's placements as its own search
 * answers, lets several be picked across maps, creates them in one action,
 * and reports a partial failure card by card with a link to each new scenario.
 */

const SOURCE: ScenarioDocumentSummaryDto = {
  id: "uscn_source",
  workspaceId: "ws",
  title: "Unprotected left",
  description: null,
  datasetId: "usds_1",
  datasetSortOrder: 0,
  mapVersionId: "usmap_src",
  mapLabel: "Source Map",
  latestRevisionId: null,
  revisionCount: 0,
  archetype: null,
  author: null,
  contentTags: [],
  tags: [],
  roleCount: 3,
  hasSensorProfile: false,
  propCount: 0,
  variantCount: 0,
  clipSeconds: 20,
  negativeControl: false,
  derivationKind: null,
  derivedFromDocumentId: null,
  hasRender: false,
  createdByUserName: null,
  updatedByUserName: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

function candidate(siteId: string, rank: number, extra: Partial<ScenarioTransferCandidateDto> = {}): ScenarioTransferCandidateDto {
  return {
    siteId,
    rank,
    score: 0.9,
    verdict: "exact",
    summary: "",
    offRoadActors: 0,
    preview: {
      viewBox: [0, 0, 80, 60],
      lanes: [{ kind: "drive", width: 3.5, d: "M0 30L80 30" }],
      route: "M10 30L70 30",
      actors: [{ id: "ego", kind: "subject", x: 10, y: 30, rotateDeg: 0, length: 4.8, width: 1.9 }],
    },
    ...extra,
  };
}

const MAPS = [
  { mapVersionId: "usmap_yale", sourceMapId: "yale", label: "Yale Street", locality: null, siteIds: [] },
  { mapVersionId: "usmap_belmont", sourceMapId: "belmont", label: "Belmont", locality: null, siteIds: [] },
];
const CANDIDATES: Record<string, ScenarioTransferCandidateDto[]> = {
  usmap_yale: [candidate("y1", 1), candidate("y2", 2, { verdict: "degraded", summary: "speed clamped", offRoadActors: 1 })],
  usmap_belmont: [candidate("b1", 1)],
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function createdDocument(id: string, title: string, mapVersionId: string) {
  return {
    id,
    workspaceId: "ws",
    title,
    draftVersion: 1,
    schemaVersion: "2",
    contentSha256: "0".repeat(64),
    content: { roles: [] },
    mapVersionId,
    datasetId: "usds_1",
    authoringQualityId: "low",
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    latestRevisionId: null,
  };
}

type Handler = (body: Record<string, unknown>) => Response | Promise<Response>;
let transferHandler: Handler;
let optionsHandler: Handler;
const transferBodies: Array<Record<string, unknown>> = [];

beforeEach(() => {
  transferBodies.length = 0;
  optionsHandler = (body) => {
    if (body.candidates === false) {
      return json(200, { sourceMapVersionId: "usmap_src", sourceSiteId: "s", lift: { ok: true, issues: [] }, maps: MAPS });
    }
    const id = (body.targetMapVersionIds as string[])[0]!;
    const map = MAPS.find((entry) => entry.mapVersionId === id)!;
    return json(200, {
      sourceMapVersionId: "usmap_src",
      sourceSiteId: "s",
      lift: { ok: true, issues: [] },
      maps: [{ ...map, siteIds: CANDIDATES[id]!.map((c) => c.siteId), candidates: CANDIDATES[id], error: null }],
    });
  };
  transferHandler = (body) => {
    if (body.siteId === "y2") {
      return json(422, { error: "transfer_refused", message: "That placement is no longer offered on Yale Street." });
    }
    return json(201, createdDocument(`uscn_${String(body.siteId)}`, String(body.title), String(body.targetMapVersionId)));
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url.endsWith("/transfer-options")) return optionsHandler(body);
    if (url.endsWith("/transfer")) {
      transferBodies.push(body);
      return transferHandler(body);
    }
    return json(404, { error: "not_found" });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

let revision = 0;
/** Each test opens a fresh revision of the source, so the overlay's session cache never answers for another test. */
function renderOverlay(document: ScenarioDocumentSummaryDto = { ...SOURCE, updatedAt: `2026-09-01T00:00:${String(++revision).padStart(2, "0")}.000Z` }) {
  const handlers = { onClose: vi.fn(), onCreated: vi.fn(), onOpenDocument: vi.fn() };
  render(
    <StudioHostTestProvider>
      <ScenarioTransferOverlay document={document} {...handlers} />
    </StudioHostTestProvider>,
  );
  return handlers;
}

describe("ScenarioTransferOverlay", () => {
  it("shows every placement on every other map as a selectable card", async () => {
    renderOverlay();
    expect(await screen.findByRole("dialog", { name: "Unprotected left" })).toBeTruthy();
    const cards = await screen.findAllByRole("checkbox");
    await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(3));
    expect(cards[0]!.getAttribute("aria-label")).toContain("Placement 1 on Yale Street");
    expect(screen.getByText("1 actor off road")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Belmont" })).toBeTruthy();
  });

  it("creates every selected placement at once and reports a partial failure card by card", async () => {
    const handlers = renderOverlay();
    await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(3));
    const create = screen.getByTestId("scenario-transfer-create") as HTMLButtonElement;
    expect(create.disabled).toBe(true);

    for (const card of screen.getAllByRole("checkbox")) fireEvent.click(card);
    expect(screen.getByRole("status").textContent).toBe("3 selected");
    expect(create.textContent).toContain("Create 3 variations");

    await act(async () => {
      fireEvent.click(create);
    });
    await waitFor(() => expect(screen.getByTestId("scenario-transfer-done")).toBeTruthy());

    expect(transferBodies.map((body) => body.siteId).sort()).toEqual(["b1", "y1", "y2"]);
    expect(transferBodies.find((body) => body.siteId === "y1")!.title).toBe("Unprotected left · Yale Street 1");
    expect(transferBodies.find((body) => body.siteId === "b1")!.title).toBe("Unprotected left · Belmont");
    expect(screen.getByText("2 variations created · 1 failed")).toBeTruthy();
    expect(screen.getByText("That placement is no longer offered on Yale Street.")).toBeTruthy();
    expect(handlers.onCreated).toHaveBeenCalledTimes(2);

    const links = screen.getAllByTestId("scenario-transfer-open") as HTMLAnchorElement[];
    expect(links).toHaveLength(2);
    expect(links.map((link) => link.getAttribute("href"))).toContain(
      "/dashboard/scenario?dataset=usds_1&document=uscn_y1",
    );
    fireEvent.click(links[0]!, { button: 0 });
    expect(handlers.onClose).toHaveBeenCalled();
    expect(handlers.onOpenDocument).toHaveBeenCalledTimes(1);
  });

  it("retries only the placements that failed", async () => {
    renderOverlay();
    await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(3));
    fireEvent.click(screen.getAllByRole("checkbox")[1]!);
    fireEvent.click(screen.getAllByRole("checkbox")[2]!);
    await act(async () => {
      fireEvent.click(screen.getByTestId("scenario-transfer-create"));
    });
    await waitFor(() => expect(screen.getByText("Retry failed")).toBeTruthy());

    transferHandler = (body) => json(201, createdDocument(`uscn_${String(body.siteId)}`, String(body.title), String(body.targetMapVersionId)));
    transferBodies.length = 0;
    await act(async () => {
      fireEvent.click(screen.getByText("Retry failed"));
    });
    await waitFor(() => expect(screen.getByText("2 variations created")).toBeTruthy());
    expect(transferBodies.map((body) => body.siteId)).toEqual(["y2"]);
  });

  it("opens with focus inside, so the first Tab reaches a card rather than the page behind", async () => {
    renderOverlay();
    await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(3));
    expect(document.activeElement).toBe(screen.getByTestId("scenario-transfer-body"));
  });

  it("toggles a focused card from the keyboard and creates with Ctrl+Enter", async () => {
    renderOverlay();
    await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(3));
    const card = screen.getAllByRole("checkbox")[0]!;
    card.focus();
    fireEvent.keyDown(card, { key: " " });
    expect(card.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(card, { key: "Enter" });
    expect(card.getAttribute("aria-checked")).toBe("false");
    fireEvent.keyDown(card, { key: " " });
    await act(async () => {
      fireEvent.keyDown(card, { key: "Enter", ctrlKey: true });
    });
    await waitFor(() => expect(screen.getByText("1 variation created")).toBeTruthy());
  });

  it("explains a scenario that cannot be transferred instead of showing an empty grid", async () => {
    optionsHandler = () =>
      json(200, {
        sourceMapVersionId: "usmap_src",
        sourceSiteId: null,
        lift: {
          ok: false,
          issues: [{ code: "reference_role_missing", severity: "error", message: "the document has no scene_absolute role to lift from" }],
        },
        maps: [],
      });
    renderOverlay();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("This scenario cannot be transferred")).toBeTruthy();
    expect(within(alert).getByText(/no actor placed on the map/)).toBeTruthy();
    expect(within(alert).getByText(/no scene_absolute role/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(screen.queryByTestId("scenario-transfer-create")).toBeNull();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("surfaces every refusal the lift reports, in plain words first", async () => {
    optionsHandler = () =>
      json(200, {
        sourceMapVersionId: "usmap_src",
        sourceSiteId: null,
        lift: {
          ok: false,
          issues: [
            { code: "reference_lane_anchor_missing", severity: "error", path: "roles.ego", message: "The reference role has no lane anchor." },
            { code: "route_turn_unbindable", severity: "error", message: "A route turn cannot be carried between maps." },
            { code: "role_projection_too_far", severity: "warning", message: "actor is 183 m from the reference path" },
          ],
        },
        maps: [],
      });
    renderOverlay();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/not snapped to a lane/)).toBeTruthy();
    expect(within(alert).getByText("The reference role has no lane anchor.")).toBeTruthy();
    expect(within(alert).getByText("A route turn cannot be carried between maps.")).toBeTruthy();
    // Warnings do not block a transfer and are not listed as reasons it was refused.
    expect(within(alert).queryByText(/183 m/)).toBeNull();
  });

  it("says a failure that is the scenario's once, not on each map", async () => {
    const reason = "actor_catalog_class_mismatch: catalog id \"carla.vehicle_old\" does not exist";
    const base = optionsHandler;
    optionsHandler = (body) => {
      if (body.candidates === false) return base(body);
      const id = (body.targetMapVersionIds as string[])[0]!;
      const map = MAPS.find((entry) => entry.mapVersionId === id)!;
      return json(200, {
        sourceMapVersionId: "usmap_src",
        sourceSiteId: "s",
        lift: { ok: true, issues: [] },
        maps: [{ ...map, candidates: [], error: reason, errorScope: "scenario" }],
      });
    };
    renderOverlay();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(reason)).toBeTruthy();
    expect(screen.queryAllByRole("region")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("keeps the other maps usable when one map's search fails, and retries it alone", async () => {
    let belmontCalls = 0;
    const base = optionsHandler;
    optionsHandler = (body) => {
      if ((body.targetMapVersionIds as string[] | undefined)?.[0] === "usmap_belmont") {
        belmontCalls += 1;
        if (belmontCalls === 1) return json(500, { error: "transfer_options_failed", message: "Transfer candidates could not be loaded. Try again." });
      }
      return base(body);
    };
    renderOverlay();
    await screen.findByText("Transfer candidates could not be loaded. Try again.");
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(3));
    expect(belmontCalls).toBe(2);
  });
});
