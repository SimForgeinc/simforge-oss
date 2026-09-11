import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { pickHeightField } from './ground-pick';

/** A road two metres above a flat datum, spanning x ∈ [10, 14]. */
const roadOverDatum = (x: number) => (x >= 10 && x <= 14 ? 2 : 0);

describe('pickHeightField', () => {
  it('returns the first surface the ray meets, not the one a plane iteration settles on', () => {
    // From (0, 3) sloping 1 m down per 11 m: 2 m high at x = 11, on the road.
    // Continued, the same ray reaches the datum at x = 33 - the hit a
    // horizontal-plane iteration seeded at datum height converges to.
    const direction = new Vector3(11, -1, 0).normalize();
    const hit = pickHeightField(new Vector3(0, 3, 0), direction, roadOverDatum, new Vector3());
    expect(hit).not.toBeNull();
    expect(hit!.x).toBeCloseTo(11, 3);
    expect(hit!.y).toBe(2);
  });

  it('lands on the datum when the ray clears the road', () => {
    // 3 m down per 11 m: 0.09 m above the road's near edge, meets the datum at x = 11.
    const direction = new Vector3(11, -3, 0).normalize();
    const hit = pickHeightField(new Vector3(0, 3, 0), direction, (x) => (x >= 11.5 && x <= 14 ? 2 : 0), new Vector3());
    expect(hit!.x).toBeCloseTo(11, 3);
    expect(hit!.y).toBe(0);
  });

  it('gives up at the horizon, under ground, and where nothing is sampled', () => {
    const out = new Vector3();
    expect(pickHeightField(new Vector3(0, 3, 0), new Vector3(1, 0, 0), roadOverDatum, out)).toBeNull();
    expect(pickHeightField(new Vector3(12, 1, 0), new Vector3(1, -1, 0).normalize(), roadOverDatum, out)).toBeNull();
    expect(pickHeightField(new Vector3(0, 3, 0), new Vector3(1, -1, 0).normalize(), () => null, out)).toBeNull();
  });
});
