import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ACTOR_AUTHORING_POLICY,
  COLLISION_INFERENCE_MAX_CLOSEST_APPROACH_M,
  DEFAULT_AUTHORED_VEHICLE_SPEED_KPH,
  DEFAULT_AUTHORED_VEHICLE_SPEED_MPS,
  isCollisionInferenceCandidate,
  DEFAULT_CREEP_SPEED_KPH,
  DEFAULT_FOLLOWING_DISTANCE_M,
  DEFAULT_REVERSE_SPEED_KPH,
  DEFAULT_SWERVE_OFFSET_M,
  DEFAULT_WALKER_CONFLICT_TRIGGER_DISTANCE_M,
  ScenarioEditorRoadAnchorSchema,
} from '../contracts.js';

describe('studio actor-draft authoring contracts', () => {

  /**
   * The contracts in `studio-contracts/` exist to be composed by a host into
   * ITS schemas. A classic discriminated union reads each option through
   * `instanceof`, so it only composes within one physical copy of zod — and an
   * npm host resolves an aliased dependency to a second copy even when the
   * versions match. This fails the moment a contract is moved onto the
   * package's aliased zod 4 (`zod-v4`), which is the mistake that made two
   * hosts unable to parse anything. See `docs/engineering/zod-instances.md`.
   */
  it('composes into a host union built from the plain zod dependency', () => {
    const union = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('road'), anchor: ScenarioEditorRoadAnchorSchema }),
      z.object({ kind: z.literal('free'), x: z.number() }),
    ]);
    const parsed = union.parse({
      kind: 'road',
      anchor: { road_id: '17', s_fraction: 0.25, lane_id: -1 },
    });
    expect(parsed).toMatchObject({ kind: 'road', anchor: { road_id: '17', s_fraction: 0.25 } });
  });
  it('pins the worker defaults both hosts fall back to', () => {
    expect([
      DEFAULT_CREEP_SPEED_KPH,
      DEFAULT_REVERSE_SPEED_KPH,
      DEFAULT_FOLLOWING_DISTANCE_M,
      DEFAULT_WALKER_CONFLICT_TRIGGER_DISTANCE_M,
      DEFAULT_SWERVE_OFFSET_M,
    ]).toEqual([5, 10, 5, 15, -1]);
  });

  it('publishes actor and collision authoring policy from the same barrel', () => {
    expect(ACTOR_AUTHORING_POLICY).toMatchObject({
      vehicleSpeedCapKph: 240,
      walkerSpeedCapKph: 25,
      defaultAutopilot: false,
      defaultVehicleColor: '230,200,40',
    });
    expect(DEFAULT_AUTHORED_VEHICLE_SPEED_KPH).toBe(48.28032);
    expect(DEFAULT_AUTHORED_VEHICLE_SPEED_MPS).toBe(13.4112);
    expect(COLLISION_INFERENCE_MAX_CLOSEST_APPROACH_M).toBe(8);
    expect(isCollisionInferenceCandidate(8)).toBe(true);
    expect(isCollisionInferenceCandidate(8.001)).toBe(false);
  });
});
