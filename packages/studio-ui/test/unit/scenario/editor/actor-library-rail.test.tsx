// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerExternalCatalogEntry } from "@simforge-oss/asset-catalog";

vi.mock("../../../../src/lib/scenario/carla-objects", () => ({
  registerCarlaObjects: vi.fn(async () => []),
}));
import { AUTHORING_CATALOG as CATALOG, isCatalogId } from "@simforge-oss/asset-catalog";
import {
  registerCarlaObjects,
  type CarlaObjectDto,
} from "../../../../src/lib/scenario/carla-objects";
import { ActorLibraryRail } from "../../../../src/scenario/editor/regions/ActorLibraryRail";
import {
  ACTOR_CATALOG_SECTIONS,
  filterActorCatalog,
  isHumanoidRobotCatalogEntry,
  isTwoWheelerCatalogEntry,
  pickRandomCar,
  pushActorCatalogRecent,
  STATIC_CAR_CATALOG_IDS,
} from "../../../../src/scenario/editor/regions/actor-catalog";
import { VEHICLE_CATALOG_IDS } from "../../../../src/scenario/editor/regions/VehicleCatalogIcon";
import { PEDESTRIAN_CATALOG_IDS } from "../../../../src/scenario/editor/regions/PedestrianCatalogIcon";
import { OBJECT_CATALOG_IDS } from "../../../../src/scenario/editor/regions/ObjectCatalogIcon";
import { DYNAMIC_ACTOR_CATALOG_IDS } from '../../../../src/scenario/editor/regions/DynamicActorCatalogIcon';

afterEach(() => {
  cleanup();
  for (const dock of [...document.querySelectorAll('[data-testid="floating-timeline-layer"]')]) {
    dock.remove();
  }
  try { window.localStorage.clear(); } catch { /* jsdom storage may be disabled. */ }
  vi.mocked(registerCarlaObjects).mockResolvedValue([]);
});

/**
 * A stand-in for the floating timeline dock, sized so the rail has something
 * to measure. `afterEach` takes it down, so a failing assertion cannot leave it
 * behind and change what the next test measures.
 */
function mountTimelineDock(height: number) {
  const dock = document.createElement("div");
  dock.dataset.testid = "floating-timeline-layer";
  Object.defineProperty(dock, "getBoundingClientRect", {
    value: () => ({ height, width: 900, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }),
  });
  document.body.appendChild(dock);
  return dock;
}

describe("ActorLibraryRail", () => {
  it("assigns supported actors to library sections and intentionally repeats static cars", () => {
    const assignedIds = Object.values(ACTOR_CATALOG_SECTIONS)
      .flatMap((sections) => sections)
      .flatMap((section) => section.catalogIds);

    // Every offered id must name a real catalog entry.
    for (const id of new Set(assignedIds)) {
      expect(isCatalogId(id), `${id} is not a catalog id`).toBe(true);
    }
    const duplicateIds = [...new Set(assignedIds.filter((id, index) => assignedIds.indexOf(id) !== index))].sort();
    expect(duplicateIds).toEqual([...STATIC_CAR_CATALOG_IDS].sort());
    expect(ACTOR_CATALOG_SECTIONS.vehicles.find((section) => section.label === "Emergency response")?.catalogIds)
      .toContain("vehicle.ambulance");
    expect(ACTOR_CATALOG_SECTIONS.vehicles.find((section) => section.label === "Everyday cars")?.catalogIds)
      .toContain("vehicle.honda_civic");
    expect(ACTOR_CATALOG_SECTIONS.pedestrians.map((section) => section.label))
      .toEqual(["Adults", "Children", "Traffic & work crews"]);
    expect(ACTOR_CATALOG_SECTIONS.objects[0]).toMatchObject({
      id: "static-cars",
      label: "Static cars",
      catalogIds: STATIC_CAR_CATALOG_IDS,
    });
  });

  it("adds loaded CARLA objects to the matching existing section", async () => {
    const carlaObject: CarlaObjectDto = {
      catalogId: "carla.vehicle.mock_emergency",
      label: "Mock emergency vehicle",
      class: "vehicle",
      actorClass: "car",
      dims: { l: 4.8, w: 1.9, h: 1.7 },
      tags: ["emergency"],
      blueprintId: "vehicle.mock.emergency",
    };
    vi.mocked(registerCarlaObjects).mockImplementationOnce(async () => {
      registerExternalCatalogEntry({
        id: carlaObject.catalogId,
        label: carlaObject.label,
        class: carlaObject.class,
        actorClass: carlaObject.actorClass,
        description: "Mock registered CARLA object",
        dims: carlaObject.dims,
        tags: ["emergency"],
        defaultParams: {},
        model: { kind: "proxy", tint: "#68a5ff" },
      });
      return [carlaObject];
    });

    render(
      <ActorLibraryRail
        controller={{ cancel: vi.fn(), togglePlacement: vi.fn() } as never}
        state={{ mode: "idle", placing: null, selection: [] } as never}
        hostRef={{ current: null }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Car" }));
    fireEvent.click(screen.getByRole("button", { name: "Emergency response" }));

    await waitFor(() => {
      expect(screen.getByTestId(`catalog-${carlaObject.catalogId}`)).not.toBeNull();
    });
    expect(screen.getByTestId("catalog-section-emergency-response").textContent)
      .toContain(carlaObject.label);
  });

  it("matches standalone search and bounded recent ordering", () => {
    const prop = CATALOG.find((entry) => entry.class === "construction");
    expect(prop).toBeTruthy();
    const filtered = filterActorCatalog(CATALOG, "all", prop!.label, new Set(), []);
    expect(filtered.map((entry) => entry.id)).toContain(prop!.id);
    expect(filterActorCatalog(CATALOG, "all", "sedan", new Set(), []).some((entry) => entry.class === "vehicle")).toBe(true);
    expect(filterActorCatalog(CATALOG, "all", "pedestrian", new Set(), []).some((entry) => entry.class === "pedestrian")).toBe(true);
    expect(pushActorCatalogRecent(["a", "b", "a"], "a")).toEqual(["a", "b"]);
    expect(pickRandomCar(CATALOG, () => 0)?.id).toBe("vehicle.sedan");
    expect(pickRandomCar([], () => 0)).toBeNull();
  });

  it("arms the authoritative v2 placement command on click or drag", () => {
    const togglePlacement = vi.fn();
    const placeCatalogAtClientPoint = vi.fn(() => true);
    const controller = {
      cancel: vi.fn(),
      beginRotate: vi.fn(),
      togglePlacement,
      placeCatalogAtClientPoint,
    };
    const state = { mode: "idle", placing: null, selection: [] };
    const prop = CATALOG.find((entry) => entry.class === "construction")!;
    const canvasHost = document.createElement("div");
    canvasHost.dataset.tutorial = "canvas";
    const canvas = document.createElement("canvas");
    canvasHost.appendChild(canvas);
    document.body.appendChild(canvasHost);
    const hostRef = { current: canvasHost };
    const { rerender } = render(
      <ActorLibraryRail
        controller={controller as never}
        state={state as never}
        hostRef={hostRef}
      />,
    );

    expect(screen.getAllByRole("button").filter((button) => button.dataset.testid?.startsWith("tool-"))).toHaveLength(13);
    expect(screen.getByTestId("tool-vehicles")).not.toBeNull();
    expect(screen.getByTestId("tool-two-wheelers")).not.toBeNull();
    expect(screen.getByTestId("tool-pedestrians")).not.toBeNull();
    expect(screen.getByTestId('tool-sidewalk-robots')).not.toBeNull();
    expect(screen.getByTestId('tool-humanoid-robots')).not.toBeNull();
    expect(screen.getByTestId('tool-drones')).not.toBeNull();
    expect(screen.getByTestId('tool-animals')).not.toBeNull();
    expect(screen.getByTestId("tool-objects")).not.toBeNull();
    expect(screen.getByTestId("tool-gallery")).not.toBeNull();
    expect(screen.getByTestId("tool-search")).not.toBeNull();
    expect(screen.getByTestId("tool-weather")).not.toBeNull();
    expect(screen.getByTestId("tool-traffic")).not.toBeNull();
    // Parked cars are a scene tool of their own, not a corner of the traffic drawer.
    expect(screen.getByTestId("tool-parked")).not.toBeNull();
    expect(screen.queryByTestId("tool-carla")).toBeNull();
    expect(screen.queryByTestId("tool-sumo")).toBeNull();
    expect(screen.queryByTestId("tool-timeline")).toBeNull();
    const sidebar = screen.getByTestId("editor-tool-sidebar");
    const rail = screen.getByTestId("editor-tool-rail");
    // The sidebar owns no geometry of its own: it is the plain full-height
    // flex box that centres the rail/panel row, and everything it must produce
    // is observable on the rail and the row instead of in its class list.
    expect(sidebar.getAttribute("style")).toBeNull();
    expect(sidebar.contains(rail)).toBe(true);
    expect(rail.style.height).toBe("");
    expect(rail.style.position).toBe("");
    expect(rail.dataset.visualSurface).toBe("glass");
    expect(rail.style.backdropFilter).toBe("blur(72px) saturate(185%) contrast(105%)");
    expect(rail.style.background).toContain("linear-gradient");
    expect(rail.style.width).toBe("48px");
    expect(rail.style.borderRadius).toBe("0 22px 22px 0");
    expect(rail.style.borderLeftWidth).toBe("0px");
    expect(rail.style.marginLeft).toBe("0px");
    expect(rail.style.maxHeight).toBe("100%");
    expect(rail.style.overflowY).toBe("auto");
    expect(rail.style.overscrollBehaviorY).toBe("contain");
    expect(rail.style.scrollbarWidth).toBe("thin");
    expect(rail.style.overflowX).toBe("hidden");
    // Four spaced groups, so twelve glyphs do not read as one undifferentiated
    // run: search, then actors, then props, then the scene itself.
    const groups = [...rail.querySelectorAll("[data-tool-group]")];
    expect(groups.map((group) => group.getAttribute("data-tool-group"))).toEqual([
      "search",
      "actors",
      "props",
      "scene",
    ]);
    expect(groups[1]!.querySelectorAll("button")).toHaveLength(7);
    // Scene group: weather, traffic, parked cars.
    expect(groups[3]!.querySelectorAll("button")).toHaveLength(3);
    // Only the last group forgoes the separating hairline.
    expect(groups[0]!.getAttribute("style")).toContain("border-bottom");
    expect(groups[3]!.getAttribute("style")).not.toContain("border-bottom: 1px");
    const restingRailStyle = rail.getAttribute("style");
    fireEvent.pointerDown(canvas);
    expect(rail.style.opacity).toBe("");
    expect(rail.getAttribute("style")).toBe(restingRailStyle);
    fireEvent.pointerUp(window);
    expect(rail.getAttribute("style")).toBe(restingRailStyle);
    fireEvent.wheel(canvas);
    expect(rail.getAttribute("style")).toBe(restingRailStyle);

    fireEvent.click(screen.getByRole("button", { name: "Car" }));
    const drawer = screen.getByRole("dialog", { name: "Add a car" });
    expect(drawer).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Add a car" })).not.toBeNull();
    // The catalog is the expanded rail itself: same sidebar, immediately right
    // of the icon column, not a floating panel on the opposite screen edge.
    expect(drawer.closest('[data-testid="editor-tool-sidebar"]')).toBe(sidebar);
    expect(drawer.previousElementSibling).toBe(rail);
    expect(drawer.dataset.placement).toBe("left-expanded");
    expect(drawer.dataset.visualSurface).toBe("glass");
    expect(drawer.style.backdropFilter).toBe("blur(72px) saturate(185%) contrast(105%)");
    expect(drawer.style.background).toContain("linear-gradient");
    expect(drawer.style.borderRadius).toBe("0 26px 26px 0");
    expect(drawer.style.borderLeftWidth).toBe("0px");
    expect(drawer.style.flexDirection).toBe("column");
    // In flow inside the sidebar, not a panel floating over the canvas.
    expect(drawer.style.position).toBe("relative");
    // The rail drops its right shoulder so rail and panel read as one rectangle.
    expect(rail.style.borderRadius).not.toBe("0 22px 22px 0");
    expect(rail.style.borderRightWidth).toBe("1px");
    expect(screen.getByRole("searchbox", { name: "Search catalog" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "All" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Favorites" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Recent" })).not.toBeNull();
    expect(screen.getByTestId("catalog-carla-compatible")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Add random car" })).not.toBeNull();
    // Every category is browsable at once; nothing is hidden behind a default.
    const categories = screen.getByRole("group", { name: "Categories" });
    expect(categories.querySelector('[aria-pressed="true"]')!.textContent).toBe("All categories");
    expect(screen.getByTestId("catalog-section-everyday-cars").textContent).toContain("Everyday cars");
    expect(screen.getByTestId("catalog-section-emergency-response").textContent).toContain("Emergency response");
    expect(screen.getByTestId("catalog-vehicle.sedan")).not.toBeNull();
    expect(screen.getByTestId("catalog-vehicle.ambulance")).not.toBeNull();
    const catalogVehicleIds = CATALOG.filter((entry) => entry.class === "vehicle").map((entry) => entry.id);
    expect([...VEHICLE_CATALOG_IDS]).toEqual(catalogVehicleIds);
    const everydayCarIds = ACTOR_CATALOG_SECTIONS.vehicles.find((section) => section.id === "everyday-cars")!.catalogIds;
    for (const id of everydayCarIds) {
      expect(screen.getByTestId(`catalog-${id}`).querySelector(`[data-vehicle-icon="${id}"]`)).not.toBeNull();
    }
    // Every rendered car tile draws its own model, none fall back to a glyph.
    expect(document.querySelectorAll("[data-vehicle-icon]")).toHaveLength(
      document.querySelectorAll('[data-testid^="catalog-vehicle."]').length,
    );
    expect(screen.queryByTestId("catalog-vehicle.motorcycle")).toBeNull();
    expect(screen.queryByTestId("catalog-pedestrian.adult")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Emergency response" }));
    expect(screen.getByRole("button", { name: "Emergency response" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "All categories" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("catalog-section-emergency-response").textContent).toContain("Emergency response");
    expect(screen.getByTestId("catalog-vehicle.ambulance")).not.toBeNull();
    expect(screen.queryByTestId("catalog-vehicle.sedan")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Two-wheelers" }));
    expect(screen.getByRole("dialog", { name: "Add a two-wheeler" })).not.toBeNull();
    const twoWheelerIds = CATALOG.filter(isTwoWheelerCatalogEntry).map((entry) => entry.id);
    for (const id of twoWheelerIds) {
      expect(screen.getByTestId(`catalog-${id}`).querySelector(`[data-vehicle-icon="${id}"]`)).not.toBeNull();
    }
    expect(screen.getByTestId("catalog-vehicle.motorcycle")).not.toBeNull();
    expect(screen.getByTestId("catalog-vehicle.bicycle")).not.toBeNull();
    expect(screen.getByTestId("catalog-vehicle.mobility_scooter")).not.toBeNull();
    expect(screen.queryByTestId("catalog-vehicle.sedan")).toBeNull();
    expect(screen.getByRole("searchbox", { name: "Search catalog" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Add random car" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Pedestrian" }));
    expect(screen.getByRole("dialog", { name: "Add a pedestrian" })).not.toBeNull();
    // The icon set must cover every pedestrian the catalog can author. Sorted
    // because the icon list is ordered for the drawer, not by catalog.
    expect([...PEDESTRIAN_CATALOG_IDS].sort()).toEqual(
      CATALOG.filter((entry) => entry.class === "pedestrian")
        .map((entry) => entry.id)
        .sort(),
    );
    const offeredPedestrianIds = ACTOR_CATALOG_SECTIONS.pedestrians.flatMap(
      (section) => section.catalogIds,
    );
    for (const id of offeredPedestrianIds) {
      expect(screen.getByTestId(`catalog-${id}`).querySelector(`[data-catalog-icon="${id}"]`)).not.toBeNull();
    }
    expect(screen.getByTestId("catalog-pedestrian.adult")).not.toBeNull();
    expect(screen.getByTestId("catalog-pedestrian.child")).not.toBeNull();
    expect(screen.getByTestId("catalog-section-adults").textContent).toContain("Adults");
    expect(screen.getByTestId("catalog-section-children").textContent).toContain("Children");
    expect(screen.queryByTestId("catalog-vehicle.sedan")).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Sidewalk robots' }));
    const sidewalkRobotIds = CATALOG.filter((entry) => entry.class === 'sidewalk_robot' && !isHumanoidRobotCatalogEntry(entry)).map((entry) => entry.id);
    expect(sidewalkRobotIds).toHaveLength(3);
    for (const id of sidewalkRobotIds) {
      expect(screen.getByTestId(`catalog-${id}`).querySelector(`[data-catalog-icon="${id}"]`)).not.toBeNull();
    }
    expect(screen.queryByTestId('catalog-sidewalk_robot.humanoid_general_purpose')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Humanoid robots' }));
    const humanoidRobotIds = CATALOG.filter(isHumanoidRobotCatalogEntry).map((entry) => entry.id);
    expect(humanoidRobotIds).toHaveLength(5);
    for (const id of humanoidRobotIds) {
      expect(screen.getByTestId(`catalog-${id}`).querySelector(`[data-catalog-icon="${id}"]`)).not.toBeNull();
    }
    expect(screen.queryByTestId('catalog-sidewalk_robot.delivery_rover')).toBeNull();

    for (const [tool, catalogClass] of [['Drones', 'drone'], ['Animals', 'animal']] as const) {
      fireEvent.click(screen.getByRole('button', { name: tool }));
      const ids = CATALOG.filter((entry) => entry.class === catalogClass).map((entry) => entry.id);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(screen.getByTestId(`catalog-${id}`).querySelector(`[data-catalog-icon="${id}"]`)).not.toBeNull();
      }
    }
    expect([...DYNAMIC_ACTOR_CATALOG_IDS]).toEqual(
      CATALOG.filter((entry) => ['sidewalk_robot', 'drone', 'animal'].includes(entry.class)).map((entry) => entry.id),
    );

    fireEvent.click(screen.getByRole("button", { name: "Object" }));
    expect(screen.getByRole("dialog", { name: "Add an object" })).not.toBeNull();
    expect(screen.getByTestId("catalog-section-static-cars").textContent).toContain("Static cars");
    for (const id of STATIC_CAR_CATALOG_IDS) {
      expect(screen.getByTestId(`catalog-${id}`).querySelector(`[data-vehicle-icon="${id}"]`)).not.toBeNull();
    }
    expect(
      CATALOG.filter((entry) => !["vehicle", "pedestrian", 'sidewalk_robot', 'drone', 'animal'].includes(entry.class)).map((entry) => entry.id),
    ).toEqual(expect.arrayContaining([...OBJECT_CATALOG_IDS]));
    for (const id of OBJECT_CATALOG_IDS) {
      expect(screen.getByTestId(`catalog-${id}`).querySelector(`[data-catalog-icon="${id}"]`)).not.toBeNull();
    }
    fireEvent.click(screen.getByTestId("catalog-action-vehicle.sedan"));
    expect(togglePlacement).toHaveBeenCalledWith("vehicle.sedan", { freeformStatic: true });
    togglePlacement.mockClear();
    const card = screen.getByTestId(`catalog-action-${prop.id}`);
    const transfer = { effectAllowed: "", setData: vi.fn() };
    fireEvent.dragStart(card, { dataTransfer: transfer });
    expect(togglePlacement).not.toHaveBeenCalled();
    expect(transfer.setData).toHaveBeenCalledWith("application/x-simforge-catalog-id", prop.id);
    // Repeated placement keeps both the source and its catalog visible.
    expect(screen.queryByTestId("catalog-drawer")).not.toBeNull();

    // The live controller snapshot now reflects drag-start arming. Dropping on
    // the real canvas forwards one ordinary placement pointer sequence.
    rerender(
      <ActorLibraryRail
        controller={controller as never}
        state={{ ...state, mode: "placing", placing: prop.id } as never}
        hostRef={hostRef}
      />,
    );
    const dropTransfer = {
      types: ["application/x-simforge-catalog-id"],
      getData: vi.fn(() => prop.id),
      dropEffect: "none",
    };
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperties(drop, {
      clientX: { value: 320 },
      clientY: { value: 240 },
      dataTransfer: { value: dropTransfer },
    });
    fireEvent(canvas, drop);
    expect(placeCatalogAtClientPoint).toHaveBeenCalledWith(prop.id, 320, 240, {
      altKey: false,
      shiftKey: false,
      freeformStatic: false,
    });
    expect(togglePlacement).not.toHaveBeenCalled();
    expect(screen.queryByTestId("catalog-drawer")).not.toBeNull();
    canvasHost.remove();
  });

  it("keeps tool selection pointer-driven and supports keyboard navigation inside the catalog", () => {
    const togglePlacement = vi.fn();
    const controller = { cancel: vi.fn(), togglePlacement };
    render(
      <ActorLibraryRail
        controller={controller as never}
        state={{ mode: "idle", placing: null, selection: [] } as never}
        hostRef={{ current: null }}
      />,
    );

    fireEvent.keyDown(window, { key: "a" });
    expect(screen.queryByTestId("catalog-drawer")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Pedestrian" }));
    const search = screen.getByRole("searchbox", { name: "Search catalog" });
    expect(screen.getByRole("button", { name: "Pedestrian" }).getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(search);

    fireEvent.change(search, { target: { value: "pedestrian.adult" } });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(togglePlacement).toHaveBeenCalledWith("pedestrian.adult");
    expect(screen.queryByTestId("catalog-drawer")).not.toBeNull();

    fireEvent.click(screen.getByTestId("catalog-action-pedestrian.adult"));
    expect(controller.togglePlacement).toHaveBeenCalledWith("pedestrian.adult");
    expect(screen.queryByTestId("catalog-drawer")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Unpin catalog" })).toBeNull();

    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Search catalog" }), { key: "Escape" });
    expect(screen.queryByTestId("catalog-drawer")).toBeNull();
  });

  it("adds a random car from the visible car catalog", () => {
    const togglePlacement = vi.fn();
    const controller = { cancel: vi.fn(), togglePlacement };
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    render(
      <ActorLibraryRail
        controller={controller as never}
        state={{ mode: "idle", placing: null, selection: [] } as never}
        hostRef={{ current: null }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Car" }));
    fireEvent.click(screen.getByRole("button", { name: "Add random car" }));
    // First car of the first visible category, because every category shows.
    expect(togglePlacement).toHaveBeenCalledWith("vehicle.ambulance");
    expect(screen.queryByTestId("catalog-drawer")).not.toBeNull();

    // Narrowing the category narrows the draw.
    fireEvent.click(screen.getByRole("button", { name: "Everyday cars" }));
    fireEvent.click(screen.getByRole("button", { name: "Add random car" }));
    expect(togglePlacement).toHaveBeenLastCalledWith("vehicle.hatchback");
    random.mockRestore();
  });

  it("publishes left drawer occupancy for floating canvas chrome", () => {
    const controller = { cancel: vi.fn() };
    const state = { mode: "idle", placing: null, selection: [] };
    const onExpandedToolChange = vi.fn();
    render(
      <ActorLibraryRail
        controller={controller as never}
        state={state as never}
        hostRef={{ current: null }}
        onExpandedToolChange={onExpandedToolChange}
      />,
    );

    expect(onExpandedToolChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Pedestrian" }));
    expect(onExpandedToolChange).toHaveBeenLastCalledWith("pedestrians");
    fireEvent.click(screen.getByRole("button", { name: "Close catalog" }));
    expect(onExpandedToolChange).toHaveBeenLastCalledWith(null);
  });
  it("marks CARLA-ready models and filters the catalog down to them", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({
        carlaVersion: "0.10.0",
        native: { "vehicle.sedan": { blueprintId: "vehicle.tesla.model3", dimensionalAgreement: "close" } },
        unavailable: {},
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const controller = { cancel: vi.fn(), togglePlacement: vi.fn() };
    render(
      <ActorLibraryRail
        controller={controller as never}
        state={{ mode: "idle", placing: null, selection: [] } as never}
        hostRef={{ current: null }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Car" }));
    // The CARLA mark is the only CARLA signal on a tile: no status pill, no
    // legend, and nothing at all on models CARLA cannot spawn.
    await waitFor(() => {
      expect(screen.getByTestId("catalog-vehicle.sedan").querySelector('[data-carla-compatibility="native"]')).not.toBeNull();
    });
    expect(screen.getByTestId("catalog-vehicle.hatchback").querySelector("[data-carla-compatibility]")).toBeNull();
    expect(screen.queryByText("CARLA ready = measured blueprint")).toBeNull();

    fireEvent.click(screen.getByTestId("catalog-carla-compatible"));
    expect(screen.getByTestId("catalog-vehicle.sedan")).not.toBeNull();
    expect(screen.queryByTestId("catalog-vehicle.hatchback")).toBeNull();
    expect(screen.queryByTestId("catalog-vehicle.ambulance")).toBeNull();
    expect(screen.queryByTestId("catalog-section-emergency-response")).toBeNull();

    fireEvent.click(screen.getByTestId("catalog-carla-compatible"));
    expect(screen.getByTestId("catalog-vehicle.hatchback")).not.toBeNull();
    vi.unstubAllGlobals();
  });

  it("names the hovered rail tool, because the column is glyphs only", () => {
    const controller = { cancel: vi.fn() };
    render(
      <ActorLibraryRail
        controller={controller as never}
        state={{ mode: "idle", placing: null, selection: [] } as never}
        hostRef={{ current: null }}
      />,
    );

    expect(screen.queryByTestId("tool-tooltip")).toBeNull();
    fireEvent.mouseEnter(screen.getByTestId("tool-weather"));
    const tooltip = screen.getByTestId("tool-tooltip");
    expect(tooltip.textContent).toBe("Weather");
    expect(tooltip.getAttribute("role")).toBe("tooltip");
    // `fixed`, so the rail's own clipped rounded frame cannot cut it off.
    expect(tooltip.style.position).toBe("fixed");

    fireEvent.mouseLeave(screen.getByTestId("tool-weather"));
    expect(screen.queryByTestId("tool-tooltip")).toBeNull();

    // Keyboard users get the same label.
    fireEvent.focus(screen.getByTestId("tool-traffic"));
    expect(screen.getByTestId("tool-tooltip").textContent).toBe("Traffic");
  });

  // Opening a tool must not move the rail. The icon column sits in the middle of
  // the viewport, and it used to jump to the top the moment a panel opened —
  // the button you just clicked left the cursor. The clearance for the floating
  // timeline dock therefore caps the pair's row instead of pinning either
  // surface to a computed height.
  it("expands sideways from a centered rail, clear of the floating timeline dock", () => {
    mountTimelineDock(240);
    const controller = { cancel: vi.fn() };
    render(
      <ActorLibraryRail
        controller={controller as never}
        state={{ mode: "idle", placing: null, selection: [] } as never}
        hostRef={{ current: null }}
      />,
    );

    const row = screen.getByTestId("editor-tool-row");
    // The resting icon-only rail reserves the dock too; its last buttons must
    // stay reachable before any catalog is opened.
    expect(row.style.maxHeight).toBe("calc(100% - 270px)");
    fireEvent.click(screen.getByRole("button", { name: "Car" }));
    const drawer = screen.getByTestId("catalog-drawer");
    const rail = screen.getByTestId("editor-tool-rail");
    // 9px top margin + 9px bottom + the 240px dock + 12px clearance.
    expect(row.style.maxHeight).toBe("calc(100% - 270px)");
    // Neither surface pins its own height, so nothing is pushed to the top.
    expect(drawer.style.height).toBe("");
    expect(rail.style.height).toBe("");
    // The rail stays where the cursor left it: the row is capped, not pinned,
    // and the sidebar centres it. Both max-heights above are the observable
    // half of that; neither surface takes a height of its own.
  });

  it("reserves a timeline that streams in after the resting rail mounts", async () => {
    render(
      <ActorLibraryRail
        controller={null}
        state={{ mode: "idle", placing: null, selection: [] } as never}
        hostRef={{ current: null }}
      />,
    );
    const row = screen.getByTestId("editor-tool-row");
    expect(row.style.maxHeight).toBe("calc(100% - 18px)");

    mountTimelineDock(240);

    await waitFor(() => {
      expect(row.style.maxHeight).toBe("calc(100% - 270px)");
    });
  });

  it("edits weather and traffic from the same rail, without a placement controller", () => {
    const setEnvironment = vi.fn();
    const setAmbientTrafficExtension = vi.fn();
    const editorDocument = {
      data: {
        environment: { weather: "clear", timeOfDay: "noon", surfacePatches: [] },
        extensions: {},
      },
      setEnvironment,
      setAmbientTrafficExtension,
    };
    render(
      <ActorLibraryRail
        controller={null}
        document={editorDocument as never}
        state={null}
        hostRef={{ current: null }}
      />,
    );

    // Model tools need the controller; scene tools do not.
    expect(screen.getByTestId("tool-vehicles").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("tool-weather").hasAttribute("disabled")).toBe(false);

    fireEvent.click(screen.getByTestId("tool-weather"));
    expect(screen.getByRole("dialog", { name: "Add weather" })).not.toBeNull();
    expect(screen.getByTestId("add-weather-panel")).not.toBeNull();
    // Same tile gallery as the actors, not a form.
    expect(screen.getByTestId("weather-section-weather")).not.toBeNull();
    fireEvent.click(screen.getByTestId("weather-heavy_rain"));
    expect(setEnvironment).toHaveBeenCalledWith(expect.objectContaining({ weather: "heavy_rain" }));
    // Scene panels have no catalog search or CARLA filter.
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByTestId("catalog-carla-compatible")).toBeNull();

    fireEvent.click(screen.getByTestId("tool-traffic"));
    expect(screen.getByRole("dialog", { name: "Add traffic" })).not.toBeNull();
    fireEvent.click(screen.getByTestId("traffic-source-native"));
    expect(setAmbientTrafficExtension).toHaveBeenCalledWith(
      "studio.ambientTraffic.provider.v1",
      "native",
    );
    fireEvent.click(screen.getByTestId("traffic-density-heavy"));
    expect(setAmbientTrafficExtension).toHaveBeenLastCalledWith(
      "studio.ambientTraffic.profile.v1",
      expect.objectContaining({ preset: "heavy" }),
    );
  });

  it("searches models, weather and traffic from one field", () => {
    const togglePlacement = vi.fn();
    const setEnvironment = vi.fn();
    const controller = { cancel: vi.fn(), togglePlacement };
    const editorDocument = {
      data: {
        environment: { weather: "clear", timeOfDay: "noon", surfacePatches: [] },
        extensions: {},
      },
      setEnvironment,
      setAmbientTrafficExtension: vi.fn(),
    };
    render(
      <ActorLibraryRail
        controller={controller as never}
        document={editorDocument as never}
        state={{ mode: "idle", placing: null, selection: [] } as never}
        hostRef={{ current: null }}
      />,
    );

    fireEvent.click(screen.getByTestId("tool-search"));
    expect(screen.getByRole("dialog", { name: "Search everything" })).not.toBeNull();
    expect(screen.getByTestId("search-prompt")).not.toBeNull();

    const search = screen.getByRole("searchbox", { name: "Search everything" });
    fireEvent.change(search, { target: { value: "rain" } });
    // One query, hits from two different panels.
    expect(screen.getByTestId("search-weather.light_rain")).not.toBeNull();
    expect(screen.getByTestId("search-section-weather")).not.toBeNull();
    fireEvent.click(screen.getByTestId("search-weather.heavy_rain"));
    expect(setEnvironment).toHaveBeenCalledWith(expect.objectContaining({ weather: "heavy_rain" }));

    fireEvent.change(search, { target: { value: "traffic" } });
    expect(screen.getByTestId("search-traffic.source.sumo")).not.toBeNull();

    // Models from every class answer the same field, and still arm placement.
    fireEvent.change(search, { target: { value: "ambulance" } });
    expect(screen.getByTestId("search-section-vehicles")).not.toBeNull();
    fireEvent.click(screen.getByTestId("catalog-action-vehicle.ambulance"));
    expect(togglePlacement).toHaveBeenCalledWith("vehicle.ambulance");

    fireEvent.change(search, { target: { value: "zzzz" } });
    expect(screen.getByTestId("search-empty")).not.toBeNull();
  });
});

