import { describe, expect, it, vi } from "vitest";
import type { ActorRecord, EditorController, EditorDocument } from "@simforge-oss/editor"
import type { Interaction } from "@simforge-oss/scenario"
import { buildClipboardPayload,
executePaste,
parseClipboardPayload,
pastePlacementActors,
pastedRoutePoints,
planPaste,
selectionCentroid,
SIMFORGE_CLIPBOARD_SCHEMA,
type UniScenarioClipboardPayload, } from "../../../../src/scenario/editor/clipboard/actor-clipboard"

function actor(overrides: Partial<ActorRecord> & Pick<ActorRecord, "id" | "x" | "z">): ActorRecord {
  return {
    source: "role",
    kind: "vehicle",
    catalogId: "vehicle.sedan" as ActorRecord["catalogId"],
    label: undefined,
    y: 0,
    headingRad: 0,
    laneRef: undefined,
    dims: { l: 4.7, w: 1.8, h: 1.5 },
    bodyColor: undefined,
    sensors: [],
    ...overrides,
  } as ActorRecord;
}

const timedRoute = (actorId: string, points: Array<{ timeS: number; x: number; z: number }>): Interaction => ({
  id: `route_${actorId}`,
  actor: actorId,
  verb: "route",
  trigger: { kind: "at", t: 0 },
  until: { kind: "at", t: 20 },
  target: { mode: "customTimedRoute", points },
}) as Interaction;

describe("selectionCentroid", () => {
  it("averages positions and tolerates an empty set", () => {
    expect(selectionCentroid([{ x: 10, z: 0 }, { x: 30, z: 20 }])).toEqual({ x: 20, z: 10 });
    expect(selectionCentroid([])).toEqual({ x: 0, z: 0 });
  });
});

describe("buildClipboardPayload", () => {
  it("anchors at the group centroid and stores offsets + owned route clips", () => {
    const a = actor({ id: "a", x: 10, z: 0, laneRef: { roadId: "r", section: 0, laneId: -1, s: 5, t: 0.4, headingOffsetRad: 0 } });
    const b = actor({ id: "b", x: 30, z: 20, kind: "pedestrian", catalogId: "pedestrian.adult" as ActorRecord["catalogId"] });
    const foreign = timedRoute("someone-else", [{ timeS: 0, x: 0, z: 0 }]);
    const owned = timedRoute("a", [{ timeS: 0, x: 10, z: 0 }, { timeS: 1, x: 14, z: 0 }]);
    const payload = buildClipboardPayload({
      actors: [a, b],
      interactions: [foreign, owned],
      sourceMapId: "map-1",
      sourceDocumentId: "doc-1",
    })!;
    expect(payload.schema).toBe(SIMFORGE_CLIPBOARD_SCHEMA);
    expect(payload.anchor).toEqual({ x: 20, z: 10 });
    expect(payload.actors[0]).toMatchObject({ dx: -10, dz: -10, lateralT: 0.4 });
    expect(payload.actors[1]).toMatchObject({ dx: 10, dz: 10 });
    // Only the clip owned by "a" travels, expressed anchor-relative.
    expect(payload.actors[0]!.routes).toHaveLength(1);
    expect(payload.actors[0]!.routes[0]!.points).toEqual([
      { timeS: 0, dx: -10, dz: -10 },
      { timeS: 1, dx: -6, dz: -10 },
    ]);
    expect(payload.actors[1]!.routes).toHaveLength(0);
  });

  it("returns null for an empty selection", () => {
    expect(buildClipboardPayload({ actors: [], interactions: [], sourceMapId: "m" })).toBeNull();
  });
});

describe("parseClipboardPayload", () => {
  it("round-trips its own payloads", () => {
    const payload = buildClipboardPayload({
      actors: [actor({ id: "a", x: 1, z: 2 })],
      interactions: [timedRoute("a", [{ timeS: 0, x: 1, z: 2 }])],
      sourceMapId: "map-1",
    })!;
    expect(parseClipboardPayload(JSON.stringify(payload))).toEqual(payload);
  });

  it("rejects foreign clipboard content", () => {
    expect(parseClipboardPayload("not json")).toBeNull();
    expect(parseClipboardPayload("42")).toBeNull();
    expect(parseClipboardPayload(JSON.stringify({ schema: "something-else" }))).toBeNull();
    expect(parseClipboardPayload(JSON.stringify({
      schema: SIMFORGE_CLIPBOARD_SCHEMA,
      sourceMapId: "m",
      anchor: { x: 0, z: 0 },
      actors: [{ catalogId: 42 }],
    }))).toBeNull();
  });
});

describe("planPaste", () => {
  it("preserves group-relative layout around the target anchor", () => {
    const payload = buildClipboardPayload({
      actors: [actor({ id: "a", x: 10, z: 0 }), actor({ id: "b", x: 30, z: 20 })],
      interactions: [],
      sourceMapId: "map-1",
    })!;
    const planned = planPaste(payload, { x: 100, z: 50 });
    expect(planned.map((plan) => ({ x: plan.x, z: plan.z }))).toEqual([
      { x: 90, z: 40 },
      { x: 110, z: 60 },
    ]);
    // Pairwise geometry is exactly the copied geometry.
    expect(planned[1]!.x - planned[0]!.x).toBeCloseTo(20, 6);
    expect(planned[1]!.z - planned[0]!.z).toBeCloseTo(20, 6);
  });
});

describe("pastedRoutePoints", () => {
  it("translates rigidly by the resolved displacement and pins the timed start", () => {
    const source = {
      catalogId: "vehicle.sedan",
      dx: 5,
      dz: 0,
      y: 0,
      headingRad: 0,
      routes: [],
    };
    const route = {
      mode: "customTimedRoute" as const,
      points: [
        { timeS: 0, dx: 5, dz: 0 },
        { timeS: 1, dx: 9, dz: 0 },
        { timeS: 2, dx: 9, dz: 4 },
      ],
    };
    // The resolver snapped the actor to (103, 1) instead of the translated (105, 0).
    const points = pastedRoutePoints(route, source, { x: 103, z: 1 });
    expect(points[0]).toEqual({ timeS: 0, x: 103, z: 1 });
    // Later points keep the authored shape relative to the actor.
    expect(points[1]).toEqual({ timeS: 1, x: 107, z: 1 });
    expect(points[2]).toEqual({ timeS: 2, x: 107, z: 5 });
  });

  it("does not pin the first point of an untimed route", () => {
    const source = { catalogId: "vehicle.sedan", dx: 0, dz: 0, y: 0, headingRad: 0, routes: [] };
    const route = { mode: "customRoute" as const, points: [{ dx: 0, dz: 0 }, { dx: 4, dz: 0 }] };
    const points = pastedRoutePoints(route, source, { x: 50, z: 0 });
    expect(points).toEqual([{ x: 50, z: 0 }, { x: 54, z: 0 }]);
  });
});

describe("executePaste", () => {
  function fakes() {
    let nextId = 0;
    const addWithInteractions = vi.fn(
      (inputs: ReadonlyArray<{ id?: string }>, interactions: readonly Interaction[]) => {
        void interactions;
        return inputs.map((input) => input.id!);
      },
    );
    const setSelection = vi.fn();
    const document = {
      data: { choreography: { clipSeconds: 20 } },
      allocateActorId: vi.fn(() => `new_${nextId++}`),
      addWithInteractions,
    } as unknown as EditorDocument;
    const controller = { setSelection } as unknown as EditorController;
    return { controller, document, addWithInteractions, setSelection };
  }

  const payload = (): UniScenarioClipboardPayload => ({
    schema: SIMFORGE_CLIPBOARD_SCHEMA,
    sourceMapId: "map-1",
    sourceDocumentId: null,
    anchor: { x: 0, z: 0 },
    actors: [
      {
        catalogId: "vehicle.sedan",
        dx: -5,
        dz: 0,
        y: 0,
        headingRad: 0.5,
        lateralT: 0.25,
        initialSpeedKph: 48,
        routes: [{
          mode: "customTimedRoute",
          points: [{ timeS: 0, dx: -5, dz: 0 }, { timeS: 1, dx: -1, dz: 0 }],
        }],
      },
      { catalogId: "pedestrian.adult", dx: 5, dz: 0, y: 0, headingRad: 0, routes: [] },
    ],
  });

  it("commits the exact free-form preview poses as one gesture", () => {
    const { controller, document, addWithInteractions, setSelection } = fakes();
    const placements = [
      { ...pastePlacementActors(payload())[0]!, x: 95, y: 0.2, z: 40 },
      { ...pastePlacementActors(payload())[1]!, x: 105, y: 0.1, z: 40 },
    ];
    const result = executePaste({ controller, document, payload: payload(), placements });

    expect(result.ids).toEqual(["new_0", "new_1"]);
    expect(result.unanchored).toBe(1);
    expect(addWithInteractions).toHaveBeenCalledTimes(1);
    const [inputs, interactions] = addWithInteractions.mock.calls[0]!;
    // Fresh ids everywhere; poses are byte-for-byte the accepted ghost preview.
    expect(inputs[0]).toMatchObject({ id: "new_0", x: 95, y: 0.2, z: 40, headingRad: 0.5 });
    expect(inputs[0]).not.toHaveProperty("laneRef");
    expect(inputs[1]).toMatchObject({ id: "new_1", x: 105, y: 0.1, z: 40 });
    // The cloned clip follows its actor's fresh id and is full-width exclusive.
    expect(interactions).toHaveLength(1);
    expect(interactions[0]).toMatchObject({
      actor: "new_0",
      verb: "route",
      trigger: { kind: "at", t: 0 },
      until: { kind: "at", t: 20 },
      target: {
        mode: "customTimedRoute",
        points: [
          { timeS: 0, x: 95, z: 40 },
          { timeS: 1, x: 99, z: 40 },
        ],
      },
    });
    expect(setSelection).toHaveBeenCalledWith(["new_0", "new_1"]);
  });

  it("describes the payload as a cursor-relative free-form group", () => {
    expect(pastePlacementActors(payload())).toEqual([
      {
        catalogId: "vehicle.sedan",
        dx: -5,
        dz: 0,
        fallbackY: 0,
        headingRad: 0.5,
      },
      {
        catalogId: "pedestrian.adult",
        dx: 5,
        dz: 0,
        fallbackY: 0,
        headingRad: 0,
      },
    ]);
  });
});
