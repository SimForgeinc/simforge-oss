import { describe, expect, it } from 'vitest';

import { decodeAlpamayoTrajectory, egoHistoryAtPose } from '../commands/drive.js';

describe('Alpamayo drive trajectory adapter', () => {
  it('converts ego-frame XYZ waypoints into future timed pursuit points', () => {
    const result = decodeAlpamayoTrajectory([[1, 0, 0], [2, 0.5, 0], [3, 1.5, 0]]);
    expect(result.points.map((point) => point.tS)).toEqual([0.1, 0.2, 0.30000000000000004]);
    expect(result.points[0]).toMatchObject({ x: 1, y: 0, speedMps: 10, headingRad: 0 });
    expect(result.points[1]!.headingRad).toBeCloseTo(Math.atan2(0.5, 1), 12);
    expect(result.points.every((point) => point.tS > 0 && Number.isFinite(point.speedMps))).toBe(true);
    expect(result.display).toEqual([[1, 0], [2, 0.5], [3, 1.5]]);
  });

  it('rebases world positions into the current FLU ego frame', () => {
    const history = egoHistoryAtPose([[10, 0, 0], [10, 1, 0]], { x: 10, y: 1, yawRad: Math.PI / 2 });
    expect(history).toHaveLength(16);
    expect(history.at(-1)).toEqual([0, 0, 0]);
    expect(history[0]![0]).toBeCloseTo(-1, 12);
    expect(history[0]![1]).toBeCloseTo(0, 12);
  });

  it('rejects output that cannot drive a trajectory follower', () => {
    expect(() => decodeAlpamayoTrajectory([[1, 2]])).toThrow(/too few/);
    expect(() => decodeAlpamayoTrajectory([[1, 2], [Number.NaN, 3]])).toThrow(/invalid/);
  });
});
