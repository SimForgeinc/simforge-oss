import { parseXodrRoads, type XodrRoad } from '../ground/xodr-surface.js';
import { evalRecords, type CubicRecord } from './spline.js';
import { child, childrenNamed, scanXml } from './xodr-text.js';

/**
 * Continuity of the OpenDRIVE road surface:
 *
 * - at every road-to-road contact point (predecessor/successor links, which
 *   is how junction connecting roads meet their incoming and outgoing
 *   roads): the surface z at the contact (C0), its slope along the direction
 *   of travel (C1), and the cross-slope tan(superelevation);
 * - inside every road, at each `<elevation>` record boundary (C0 and C1).
 *
 * Contacts whose reference lines do not meet (more than `alongTolM` apart
 * along the road) are geometry problems of the source and are counted, not
 * judged.
 */
export interface ContinuityReport {
  contacts: number;
  /** Contacts skipped because the reference lines do not meet. */
  skipped: number;
  /** Contacts skipped because a road's planView jumps at its end (a source geometry defect), listed. */
  geometryDefects: string[];
  contactMaxDz: number;
  contactMaxDslope: number;
  contactMaxDcross: number;
  /** Worst contacts (by |dz|, then by |dslope|), for the report. */
  worst: { road: string; end: 'start' | 'end'; other: string; otherEnd: 'start' | 'end'; dz: number; dslope: number; dcross: number }[];
  recordBoundaries: number;
  recordMaxStep: number;
  recordMaxKink: number;
}

interface Link { road: string; end: 'start' | 'end'; other: string; otherEnd: 'start' | 'end' }

function links(text: string): Link[] {
  const out: Link[] = [];
  for (const road of childrenNamed(child(scanXml(text), 'OpenDRIVE'), 'road')) {
    const link = child(road, 'link');
    for (const [tag, end] of [['predecessor', 'start'], ['successor', 'end']] as const) {
      const e = child(link, tag);
      if (!e || e.attrs['elementType'] !== 'road') continue;
      const cp = e.attrs['contactPoint'];
      if (cp !== 'start' && cp !== 'end') continue;
      out.push({ road: road.attrs['id']!, end, other: e.attrs['elementId']!, otherEnd: cp });
    }
  }
  return out;
}

/** Slopes are measured over this distance (a vehicle-scale span, so a centimetre-long sliver arc at a road end does not dominate). */
export const CONTACT_SLOPE_SPAN_M = 0.25;
const H = CONTACT_SLOPE_SPAN_M / 2;

/**
 * Surface slope per metre travelled along the line of constant t, at a road
 * end, by a second-order one-sided difference into the road (exact for the
 * quadratic part, so a curved record end does not read as a kink).
 */
function slopeAt(road: XodrRoad, s: number, t: number, inward: 1 | -1): number {
  const at = (ss: number) => { const p = road.reference(ss); return { x: p.x - Math.sin(p.hdg) * t, y: p.y + Math.cos(p.hdg) * t, z: road.surfaceZ(ss, t) }; };
  const h = Math.min(H, road.length / 4);
  const p0 = at(s); const p1 = at(s + inward * h); const p2 = at(s + inward * 2 * h);
  const d1 = Math.hypot(p1.x - p0.x, p1.y - p0.y); const d2 = Math.hypot(p2.x - p0.x, p2.y - p0.y);
  // Quadratic through (0, z0), (d1, z1), (d2, z2): derivative at 0.
  const slope = ((p1.z - p0.z) * d2 * d2 - (p2.z - p0.z) * d1 * d1) / (d1 * d2 * (d2 - d1));
  return slope * inward;
}

export function verifyContinuity(text: string, options: { alongTolM?: number; onlyRoads?: ReadonlySet<string> } = {}): ContinuityReport {
  const alongTol = options.alongTolM ?? 0.5;
  const roads = new Map(parseXodrRoads(text).map((r) => [r.id, r]));
  const report: ContinuityReport = { contacts: 0, skipped: 0, geometryDefects: [], contactMaxDz: 0, contactMaxDslope: 0, contactMaxDcross: 0, worst: [], recordBoundaries: 0, recordMaxStep: 0, recordMaxKink: 0 };
  const seen = new Set<string>();
  for (const l of links(text)) {
    const a = roads.get(l.road); const b = roads.get(l.other);
    if (!a || !b) continue;
    if (options.onlyRoads && !options.onlyRoads.has(l.road) && !options.onlyRoads.has(l.other)) continue;
    const key = [`${l.road}:${l.end}`, `${l.other}:${l.otherEnd}`].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const sa = l.end === 'start' ? 0 : a.length; const sb = l.otherEnd === 'start' ? 0 : b.length;
    const pa = a.reference(sa); const pb = b.reference(sb);
    const dx = pa.x - pb.x; const dy = pa.y - pb.y;
    const along = Math.cos(pb.hdg) * dx + Math.sin(pb.hdg) * dy;
    const tOff = -Math.sin(pb.hdg) * dx + Math.cos(pb.hdg) * dy;
    if (Math.abs(along) > alongTol) { report.skipped += 1; continue; }
    const jumps = (r: XodrRoad, s: number, inward: 1 | -1) => {
      const h = Math.min(2 * H, r.length / 2);
      const p = r.reference(s); const q = r.reference(s + inward * h);
      return Math.hypot(q.x - p.x, q.y - p.y) > 1.5 * h;
    };
    if (jumps(a, sa, l.end === 'start' ? 1 : -1) || jumps(b, sb, l.otherEnd === 'start' ? 1 : -1)) {
      report.geometryDefects.push(`${l.road}:${l.end}~${l.other}:${l.otherEnd}`);
      continue;
    }
    const sigma = Math.cos(pa.hdg - pb.hdg) >= 0 ? 1 : -1;
    const za = a.surfaceZ(sa, 0);
    const zb = b.surfaceZ(sb, tOff);
    // Slopes in a's s direction.
    const ga = slopeAt(a, sa, 0, l.end === 'start' ? 1 : -1);
    const gb = sigma * slopeAt(b, sb, tOff, l.otherEnd === 'start' ? 1 : -1);
    const cross = (r: XodrRoad, s: number) => (r.superelevation.length ? Math.tan(evalRecords(r.superelevation as CubicRecord[], s).value) : 0);
    const dz = za - zb; const dslope = ga - gb; const dcross = cross(a, sa) - sigma * cross(b, sb);
    report.contacts += 1;
    report.contactMaxDz = Math.max(report.contactMaxDz, Math.abs(dz));
    report.contactMaxDslope = Math.max(report.contactMaxDslope, Math.abs(dslope));
    report.contactMaxDcross = Math.max(report.contactMaxDcross, Math.abs(dcross));
    report.worst.push({ road: l.road, end: l.end, other: l.other, otherEnd: l.otherEnd, dz, dslope, dcross });
  }
  const byDz = [...report.worst].sort((x, y) => Math.abs(y.dz) - Math.abs(x.dz)).slice(0, 5);
  const bySlope = [...report.worst].sort((x, y) => Math.abs(y.dslope) - Math.abs(x.dslope)).slice(0, 5);
  report.worst = [...byDz, ...bySlope.filter((w) => !byDz.includes(w))];
  for (const road of roads.values()) {
    if (options.onlyRoads && !options.onlyRoads.has(road.id)) continue;
    const recs = road.elevation;
    for (let i = 1; i < recs.length; i += 1) {
      const p = recs[i - 1]!; const r = recs[i]!;
      const ds = r[0] - p[0];
      if (ds <= 0) continue;
      const end = p[1] + p[2] * ds + p[3] * ds * ds + p[4] * ds * ds * ds;
      const endSlope = p[2] + 2 * p[3] * ds + 3 * p[4] * ds * ds;
      report.recordBoundaries += 1;
      report.recordMaxStep = Math.max(report.recordMaxStep, Math.abs(end - r[1]));
      report.recordMaxKink = Math.max(report.recordMaxKink, Math.abs(endSlope - r[2]));
    }
  }
  return report;
}
