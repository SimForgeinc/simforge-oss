import { describe, expect, it } from "vitest";
import {
  InteractionRelocationActorProvenanceSchema,
  ParkingManeuverSchema,
  PhysicsProfileIdSchema,
  ScenarioEditorActorPlacementModeSchema,
  ScenarioEditorSimulationConfigSchema,
} from "../scenario-editor";

describe("scenario editor behavior contract", () => {
  it("keeps the existing editor placement modes compatible", () => {
    expect(ScenarioEditorActorPlacementModeSchema.options).toEqual([
      "road",
      "path",
      "point",
      "timed_path",
    ]);
    expect(ScenarioEditorActorPlacementModeSchema.safeParse("path").success).toBe(true);
  });

  it("pins exact same-map gate provenance for relocated actors", () => {
    const provenance = {
      schemaVersion: "simforge.interaction-relocation.v1",
      sourceJunctionId: "junction-source",
      targetJunctionId: "junction-target",
      sourceGateId: "junction-source:0:-1--1",
      targetGateId: "junction-target:0:-1--1",
      turnRelation: "Straight",
      topologyXodrSha256: "fixture-sha256",
    };

    expect(InteractionRelocationActorProvenanceSchema.safeParse(provenance).success).toBe(true);
    expect(
      InteractionRelocationActorProvenanceSchema.safeParse({
        ...provenance,
        targetGateId: "",
      }).success,
    ).toBe(false);
  });

  it("defaults and validates scenario physics profiles", () => {
    expect(PhysicsProfileIdSchema.options).toEqual([
      "carla_default",
      "nvidia_aligned",
    ]);
    expect(ScenarioEditorSimulationConfigSchema.parse({})).toMatchObject({
      physics_profile_id: "carla_default",
    });
    expect(
      ScenarioEditorSimulationConfigSchema.parse({
        physics_profile_id: "nvidia_aligned",
      }).physics_profile_id,
    ).toBe("nvidia_aligned");
    expect(ScenarioEditorSimulationConfigSchema.safeParse({
      physics_profile_id: "omniverse",
    }).success).toBe(false);
  });

  it("rejects parking segments with fewer than two waypoints (worker executor contract)", () => {
    // The worker's parse_parking_maneuver raises `degenerate_segment` for a
    // single-waypoint segment and the scenario dies at runtime as
    // `parking.parse_failed` with the ego held in place. The shared schema must
    // therefore refuse what the executor refuses (PR #445 review).
    const wp = (x: number) => ({ x, y: 0, yaw_deg: 0, speed_mps: 1 });
    const maneuver = (waypoints: unknown[]) => ({
      frame: "rear_axle",
      vehicle: {
        wheelbase_m: 2.8,
        front_overhang_m: 0.9,
        rear_overhang_m: 1.0,
        half_width_m: 0.95,
      },
      segments: [{ gear: "forward", waypoints }],
      terminal: { x: 0, y: 0, yaw_deg: 0, hold_s: 2, clearance_m: 0.4, bay_id: "bay-1" },
    });
    expect(ParkingManeuverSchema.safeParse(maneuver([wp(0), wp(1)])).success).toBe(true);
    expect(ParkingManeuverSchema.safeParse(maneuver([wp(0)])).success).toBe(false);
    expect(ParkingManeuverSchema.safeParse(maneuver([])).success).toBe(false);
  });
});
