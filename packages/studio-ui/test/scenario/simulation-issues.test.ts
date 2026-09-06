import { describe, expect, it } from "vitest";
import { collectSimulationIssues } from "../../src/scenario/editor/simulation-issues"
import { buildReadinessSummary } from "../../src/scenario/editor/readiness/readiness-model"
import type { CarlaCompatibilityTable } from "../../src/lib/scenario/carla-compatibility"
import type { Interaction } from "@simforge-oss/scenario"

describe("collectSimulationIssues", () => {
  it("keeps normal preparation out of the issue drawer", () => {
    expect(
      collectSimulationIssues({
        preparationMessage: "Preparing scenario preview…",
      }),
    ).toEqual([]);
  });

  it("collects preparation, playback, duration, and transport failures", () => {
    const issues = collectSimulationIssues({
      preparationMessage: "Preview unavailable: compile failed",
      playbackError: "Trace timestamps are invalid",
      bundle: { startTime: 4, endTime: 4 },
      transportError: "Animation clock failed",
    });

    expect(issues.map((issue) => issue.id)).toEqual([
      "preview",
      "playback",
      "duration",
      "transport",
    ]);
    expect(issues.filter((issue) => issue.severity === "error")).toHaveLength(4);
    expect(issues.filter((issue) => issue.severity === "warning")).toHaveLength(0);
    expect(issues.every((issue) => Boolean(issue.solution))).toBe(true);
  });

  it.each([
    [0, ["timed-route-empty:route"]],
    [1, []],
    [2, []],
  ] as const)("classifies a custom timed route with %i points without throwing", (pointCount, expectedIds) => {
    const interaction = {
      id: "route",
      actor: "ego",
      trigger: { kind: "at", t: 0 },
      until: { kind: "at", t: 10 },
      verb: "route",
      target: {
        mode: "customTimedRoute",
        points: Array.from({ length: pointCount }, (_, index) => ({
          timeS: index,
          x: index,
          z: 0,
        })),
      },
    } as Interaction;

    expect(collectSimulationIssues({
      actorNames: { ego: "Ego vehicle" },
      interactions: [interaction],
    }).map((issue) => issue.id)).toEqual(expectedIds);
  });

  it("reports interactions dropped during scenario materialization", () => {
    const issues = collectSimulationIssues({
      bundle: { startTime: 0, endTime: 20 },
      materializationNotes: [
        {
          path: "choreography.interactions.lane-change",
          reason: "no adjacent lane was available; interaction dropped",
        },
        {
          path: "mapSignalPlans",
          reason: "signal plans compiled",
          impact: "informational",
        },
      ],
    });

    expect(issues).toEqual([
      expect.objectContaining({
        id: "materialization-note-0",
        severity: "warning",
        title: "Interaction was not included",
      }),
    ]);
  });

  it("surfaces impossible timed-route demands as editor warnings", () => {
    const issues = collectSimulationIssues({
      bundle: { startTime: 0, endTime: 5 },
      engineIssues: [{
        code: "timed_route_turn_unreachable",
        path: "interactions.route.target",
        reason: "timed waypoint 2 exceeds the car turning envelope; widen the turn or add more time",
        severity: "warning",
      }],
    });

    expect(issues).toEqual([expect.objectContaining({
      severity: "warning",
      title: "Actor may be moving too fast",
      detail: "Add a point in between or give the actor more time.",
      solution: expect.stringContaining("Give the actor more time"),
    })]);
  });

  it("hides the expected freeform traffic-control warning only in simple mode", () => {
    const engineIssues = [{
      code: "traffic_control_route_unbound",
      path: "actors.pedestrian-1.behavior.route",
      reason: "This vehicle has a freeform route, so map stop signs and traffic signals cannot be applied.",
      severity: "warning" as const,
    }];

    expect(collectSimulationIssues({ experience: "simple", engineIssues })).toEqual([]);
    expect(collectSimulationIssues({ experience: "advanced", engineIssues })).toEqual([
      expect.objectContaining({ title: "Check the scenario" }),
    ]);
  });

  it("uses actor names and hides timed-route feasibility warnings in simple mode", () => {
    const engineIssues = [{
      code: "target_timing_infeasible",
      path: "interactions.simple_timed_route_walker.target",
      reason: "timed waypoint requires excessive acceleration",
      severity: "warning" as const,
    }];

    expect(collectSimulationIssues({
      experience: "simple",
      actorNames: { walker: "Crossing pedestrian" },
      engineIssues,
    })).toEqual([]);
    expect(collectSimulationIssues({
      experience: "advanced",
      actorNames: { walker: "Crossing pedestrian" },
      engineIssues,
    })).toEqual([expect.objectContaining({
      title: "Crossing pedestrian may be moving too fast",
      detail: "Add a point in between or give the actor more time.",
    })]);
  });

  it("does not report CARLA readiness before the compatibility table loads", () => {
    expect(collectSimulationIssues({
      placedActors: [{
        id: "motorcycle-1",
        label: "Lead motorcycle",
        catalogId: "vehicle.motorcycle",
      }],
    })).toEqual([]);
  });

  it("groups incompatible placed actors and routes their readiness items to export", () => {
    const table = {
      carlaVersion: "0.10.0",
      native: {
        "vehicle.sedan": {
          blueprintId: "vehicle.lincoln.mkz_2020",
          dimensionalAgreement: "close",
        },
      },
      unavailable: {
        "vehicle.motorcycle": "motorcycle runtime geometry is not bundled",
      },
    } satisfies CarlaCompatibilityTable;

    const issues = collectSimulationIssues({
      carlaCompatibilityTable: table,
      placedActors: [
        { id: "sedan-1", label: "Ego sedan", catalogId: "vehicle.sedan" },
        {
          id: "motorcycle-1",
          label: "Courier motorcycle",
          catalogId: "vehicle.motorcycle",
        },
        {
          id: "gallery-1",
          label: "Uploaded delivery van",
          catalogId: "gallery.delivery-van.v1",
        },
      ],
    });

    expect(issues).toHaveLength(3);
    expect(issues.map((issue) => issue.id)).toEqual([
      "carla_compatibility_summary",
      "carla_incompatible:vehicle.motorcycle",
      "carla_incompatible:gallery.delivery-van.v1",
    ]);
    expect(issues[0]).toEqual(expect.objectContaining({
      severity: "warning",
      title: "1 of 3 actors are CARLA ready",
    }));
    expect(issues[1]).toEqual(expect.objectContaining({
      severity: "warning",
      detail: expect.stringContaining("Courier motorcycle"),
      solution: expect.stringContaining("generated runtime pack"),
    }));
    expect(issues[2]).toEqual(expect.objectContaining({
      severity: "warning",
      detail: expect.stringContaining("Uploaded delivery van"),
      solution: expect.stringContaining("no CARLA blueprint"),
    }));

    const readiness = buildReadinessSummary(issues);
    expect(readiness.groups.export.map((item) => item.issue.id)).toEqual(
      issues.map((issue) => issue.id),
    );
    expect(readiness.groups.behavior).toEqual([]);
    expect(readiness.groups.realism).toEqual([]);
  });

  it("limits grouped actor names to four", () => {
    const issues = collectSimulationIssues({
      carlaCompatibilityTable: {
        carlaVersion: "0.10.0",
        native: {},
        unavailable: {
          "vehicle.motorcycle": "motorcycle runtime geometry is not bundled",
        },
      },
      placedActors: Array.from({ length: 6 }, (_, index) => ({
        id: `motorcycle-${index + 1}`,
        label: `Motorcycle ${index + 1}`,
        catalogId: "vehicle.motorcycle",
      })),
    });

    expect(issues[1]?.detail).toContain(
      "Motorcycle 1, Motorcycle 2, Motorcycle 3, Motorcycle 4, +2 more",
    );
  });
});
