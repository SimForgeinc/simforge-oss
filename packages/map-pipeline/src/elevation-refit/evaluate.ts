import { createHash } from 'node:crypto';

import { validateGround, type GroundValidation } from '../ground/build.js';
import { GroundQuery } from '../ground/query.js';
import { DRIVABLE_LANE_TYPES, parseXodrRoads, sampleLaneCentres } from '../ground/xodr-surface.js';

/**
 * The survey the ground derivative runs at ingest (`validateGround`: every
 * drivable lane centre every 0.5 m, full OpenDRIVE surface vs the mesh deck
 * nearest it), plus driving-lane-only quantiles and the per-sample rows the
 * heatmaps draw. The refit is judged by exactly this survey, so "matches
 * the mesh" means the same thing to the refit and to the ground derivative.
 */
export interface SurfaceSurvey {
  xodrSha256: string;
  validation: GroundValidation;
  /** |dz| quantiles over `driving` lanes only (m). */
  driving: { samples: number; p50: number; p95: number; p99: number; max: number };
  /** |dz| quantiles over all drivable lanes (m). */
  drivable: { samples: number; p50: number; p95: number; p99: number; max: number; over3cm: number; over5cm: number };
  /** Per-road drivable |dz| p95/max (m). */
  roads: Map<string, { junction: boolean; samples: number; p95: number; max: number }>;
  /** Rows [road, junction, lane, s, x, y, xodrZ, meshZ, topZ, driving] (NaN meshZ = hole), the ground survey's `-dz.f64` layout. */
  rows: Float64Array;
}

function q(sorted: number[], p: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]! : 0;
}

export function surveySurface(xodrText: string, query: GroundQuery): SurfaceSurvey {
  const sha = createHash('sha256').update(xodrText).digest('hex');
  const samples = sampleLaneCentres(parseXodrRoads(xodrText), 0.5);
  const validation = validateGround(query, samples, sha);
  const rows: number[] = [];
  const driving: number[] = []; const drivable: number[] = [];
  const perRoad = new Map<string, { junction: boolean; abs: number[] }>();
  for (const sample of samples) {
    if (!DRIVABLE_LANE_TYPES.has(sample.laneType)) continue;
    const hit = query.nearest(sample.x, sample.y, sample.z);
    const top = query.surfacesAt(sample.x, sample.y)[0];
    rows.push(Number(sample.road), sample.junction ? 1 : 0, sample.lane, sample.s, sample.x, sample.y, sample.z, hit ? hit.z : NaN, top ? top.z : NaN, sample.laneType === 'driving' ? 1 : 0);
    if (!hit) continue;
    const a = Math.abs(sample.z - hit.z);
    drivable.push(a);
    if (sample.laneType === 'driving') driving.push(a);
    let r = perRoad.get(sample.road);
    if (!r) { r = { junction: sample.junction, abs: [] }; perRoad.set(sample.road, r); }
    r.abs.push(a);
  }
  driving.sort((a, b) => a - b); drivable.sort((a, b) => a - b);
  const roads = new Map<string, { junction: boolean; samples: number; p95: number; max: number }>();
  for (const [id, r] of perRoad) {
    r.abs.sort((a, b) => a - b);
    roads.set(id, { junction: r.junction, samples: r.abs.length, p95: q(r.abs, 0.95), max: r.abs[r.abs.length - 1] ?? 0 });
  }
  return {
    xodrSha256: sha,
    validation,
    driving: { samples: driving.length, p50: q(driving, 0.5), p95: q(driving, 0.95), p99: q(driving, 0.99), max: driving[driving.length - 1] ?? 0 },
    drivable: {
      samples: drivable.length, p50: q(drivable, 0.5), p95: q(drivable, 0.95), p99: q(drivable, 0.99), max: drivable[drivable.length - 1] ?? 0,
      over3cm: drivable.filter((v) => v > 0.03).length / Math.max(1, drivable.length),
      over5cm: drivable.filter((v) => v > 0.05).length / Math.max(1, drivable.length),
    },
    roads,
    rows: Float64Array.from(rows),
  };
}
