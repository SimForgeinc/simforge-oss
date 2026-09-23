import { asLocationId } from '../../types/ids.js';
import { centroid, type Point2 } from '../../geometry/vec.js';
import { anchorFacts, anchorOnLane, round } from '../anchor-lift.js';
import { type BuildContext, roadNameFor } from '../context.js';
import type { LocationDraft } from '../draft.js';
import { makeLocationIdString } from '../hash.js';
import { slugify } from '../slug.js';
import { parkingFootprint } from './parking-spaces.js';
import { compareStrings } from '../compare.js';

interface Bay { id: string; ring: Point2[]; s: number; offset: number; minS: number; maxS: number }

/** Finite sight segment versus the source parking footprint, not its bounding circle. */
function blocks(a: Point2, b: Point2, ring: Point2[]): boolean {
  const cross = (p: Point2, q: Point2, r: Point2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return ring.some((p, i) => {
    const q = ring[(i + 1) % ring.length]!;
    return cross(a, b, p) * cross(a, b, q) < 0 && cross(p, q, a) * cross(p, q, b) < 0;
  });
}

/** Parking occupancy potential: actual actors, heights and reveal timing are admission's job. */
export function densifyOcclusionZones(ctx: BuildContext): LocationDraft[] {
  const groups = new Map<string, Bay[]>();
  for (const feature of ctx.sources.mapGeojson?.features ?? []) {
    if (feature.properties.Type?.toLowerCase() !== 'parkingspace' || !feature.properties.Id) continue;
    const ring = parkingFootprint(ctx, feature);
    if (!ring) continue;
    const centre = centroid(ring);
    const hit = ctx.graph.nearestLane(centre, { laneTypes: ['driving'], excludeJunctionInternal: true, maxDistanceM: 12 });
    if (!hit || Math.abs(hit.offsetM) < hit.lane.widthM / 2 + 0.5) continue;
    const c = Math.cos(hit.headingRad), s = Math.sin(hit.headingRad);
    const stations = ring.map((p) => hit.s + (p.x - hit.point.x) * c + (p.y - hit.point.y) * s);
    const key = `${hit.rsl}/${Math.sign(hit.offsetM)}`;
    const bay = { id: feature.properties.Id, ring, s: hit.s, offset: hit.offsetM, minS: Math.min(...stations), maxS: Math.max(...stations) };
    const existing = groups.get(key);
    if (existing) existing.push(bay); else groups.set(key, [bay]);
  }
  const out: LocationDraft[] = [];
  for (const [key, bays] of [...groups].sort(([a], [b]) => compareStrings(a, b))) {
    const [rsl, sideText] = key.split('/'), side = Number(sideText);
    bays.sort((a, b) => a.s - b.s || compareStrings(a.id, b.id));
    const rows: Bay[][] = [];
    for (const bay of bays) {
      const row = rows.at(-1), previous = row?.at(-1);
      if (previous && bay.minS - previous.maxS <= 8 && Math.abs(bay.offset - previous.offset) <= 3) row!.push(bay);
      else rows.push([bay]);
    }
    for (const row of rows) {
      if (row.length < 2) continue;
      const minS = Math.min(...row.map((bay) => bay.minS)), maxS = Math.max(...row.map((bay) => bay.maxS));
      if (maxS - minS < 8) continue;
      const lane = ctx.graph.get(rsl!)!;
      const station = Math.min(maxS + 1, lane.lengthM - 1);
      const middle = ctx.graph.poseAt(rsl!, (minS + maxS) / 2);
      const observer = ctx.graph.poseAt(rsl!, Math.max(0, minS - 25));
      const exit = ctx.graph.poseAt(rsl!, station);
      if (!middle || !observer || !exit || station <= minS) continue;
      const offset = side * (Math.max(...row.map((bay) => Math.abs(bay.offset))) + 2);
      const target = { x: middle.point.x - Math.sin(middle.headingRad) * offset, y: middle.point.y + Math.cos(middle.headingRad) * offset };
      const clearTarget = { x: exit.point.x - Math.sin(exit.headingRad) * offset, y: exit.point.y + Math.cos(exit.headingRad) * offset };
      if (!row.some((bay) => blocks(observer.point, target, bay.ring)) || row.some((bay) => blocks(exit.point, clearTarget, bay.ring))) continue;
      const lift = anchorOnLane(ctx, rsl!, station, offset);
      if (!lift) continue;
      const ids = row.map((bay) => bay.id).sort(), identityKey = `parked-row:${rsl}:${ids.join(',')}`;
      const roadName = roadNameFor(ctx, rsl!);
      out.push({
        id: asLocationId(makeLocationIdString(ctx.sources.mapId as string, 'occlusion_zone', identityKey)),
        name: `Parked-row sight restriction${roadName ? ` on ${roadName}` : ''}`,
        type: 'occlusion_zone', subtype: 'parked-row', tags: ['OCCLUSION_PARKING_VRU', 'PEDESTRIAN_DARTOUT'],
        anchor: lift.anchor, affordances: ['occluder', 'parkedVehicle', 'pedestrianSpawn', 'propPlacement'],
        facts: { ...anchorFacts(lift.anchor), parking_bay_count: row.length, parking_length_m: round(maxS - minS, 2), row_start_s_m: round(minS, 2), row_end_s_m: round(maxS, 2), sightline_blocked: true, row_exit_sightline_clear: true, occupancy_required: true, source_parking_ids: ids },
        provenance: ids.map((ref) => ({ source: 'map-geojson', ref, confidence: 1 })),
        quality: { anchor: 'exact', confidence: 0.85 },
        naming: { stems: [slugify(roadName ? `${roadName}-parked-row` : 'parked-row')], roadNames: roadName ? [roadName] : [] }, identityKey,
      });
    }
  }
  return out;
}
