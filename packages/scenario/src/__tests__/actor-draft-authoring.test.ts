import { describe, expect, it } from 'vitest';

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
} from '../contracts.js';

describe('studio actor-draft authoring contracts', () => {
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
