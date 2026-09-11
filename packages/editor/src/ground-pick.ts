import type { Vector3 } from 'three';

/** Ground height in scene metres at a world XZ, or `null` where nothing is known. */
export type HeightSampler = (x: number, z: number) => number | null;

/** Longest ray the pick will follow, metres: past any viewer far plane, and at most ~5k samples. */
const MAX_DISTANCE_M = 5_000;
/** Smallest march step, metres. */
const MIN_STEP_M = 1;
/** Largest march step, metres: narrower than any road, so a grazing ray never steps over one. */
const MAX_STEP_M = 2;
/** Bisection passes once a crossing is bracketed; 2^-20 of a step is well under a millimetre. */
const REFINE_PASSES = 20;

/**
 * Where a ray first meets a height field.
 *
 * The ground is a height *field*, so intersecting it is a one-dimensional
 * search along the ray for the first parameter at which the ray drops below
 * the sampled surface. The march steps by the current clearance (a ray `c`
 * metres above flat ground cannot reach it sooner than `c / |dy|`), clamped
 * to under a road's width so a grazing ray never steps over one, then bisects
 * the bracket to sub-millimetre precision. A few thousand index samples at
 * worst, ~1 ms.
 *
 * Iterating a horizontal plane to the sampled height — the obvious shortcut —
 * converges to *some* intersection, not the first: at a grazing angle over a
 * road standing above the surrounding datum it lands past the road, metres
 * from the pixel the user pointed at.
 *
 * @returns the hit written into `out`, or `null` when the ray points at or
 * above the horizon, starts below ground, or never meets a sampled surface.
 */
export function pickHeightField(origin: Vector3, direction: Vector3, sample: HeightSampler, out: Vector3): Vector3 | null {
  if (direction.y >= -1e-6) return null;
  const heightAt = (t: number) => sample(origin.x + direction.x * t, origin.z + direction.z * t);
  let t = 0;
  let above = heightAt(0);
  if (above !== null && origin.y <= above) return null;
  let tHit = -1;
  while (t < MAX_DISTANCE_M) {
    const rayY = origin.y + direction.y * t;
    const clearance = above === null ? MAX_STEP_M : (rayY - above) / -direction.y * 0.5;
    const next = t + Math.min(MAX_STEP_M, Math.max(MIN_STEP_M, clearance));
    const ground = heightAt(next);
    if (ground !== null && origin.y + direction.y * next <= ground) {
      tHit = next;
      break;
    }
    t = next;
    above = ground;
  }
  if (tHit < 0) return null;

  let lo = t;
  let hi = tHit;
  for (let i = 0; i < REFINE_PASSES; i++) {
    const mid = (lo + hi) / 2;
    const ground = heightAt(mid);
    if (ground !== null && origin.y + direction.y * mid <= ground) hi = mid;
    else lo = mid;
  }
  out.set(origin.x + direction.x * hi, 0, origin.z + direction.z * hi);
  out.y = sample(out.x, out.z) ?? origin.y + direction.y * hi;
  return out;
}
