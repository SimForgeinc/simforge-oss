/**
 * Repair of zero-length / non-finite vertex NORMAL and TANGENT attributes in
 * a map master (an ingest fix, listed in `master-report.json`).
 *
 * Source exports leave some vertices without a direction: nearly all on
 * sliver triangles of RoadRunner roads, sidewalks and terrain, where the
 * exporter could not compute one (mesh-repair evidence: none visible in a
 * render). A zero tangent with w = +-1 is still hazardous: the engine
 * normalizes it in the vertex shader, which yields NaN, and on a
 * normal-mapped material that sliver would print black.
 *
 * - NORMAL: the area-weighted sum of the face normals of the vertex's
 *   triangles (every primitive that shares the accessor), normalized.
 * - TANGENT: the per-face UV tangent (MikkTSpace's per-triangle term), summed
 *   over the vertex's triangles, made orthogonal to the normal; the sign `w`
 *   is kept (+1 when it was invalid too). A vertex whose triangles all have
 *   degenerate UVs has no defined tangent direction (the normal map is
 *   constant across it): it gets a unit tangent orthogonal to the normal,
 *   counted as `tangentsArbitrary`.
 *
 * Fails loudly (`vertex_frame_unrepairable`) when a vertex that some
 * triangle with area draws has no face normal to take (its triangles'
 * normals cancel). A vertex only degenerate triangles use, or none, is never
 * rasterized: it gets +Y and is counted as `normalsUndrawn`.
 */
import type { Accessor, Document, Primitive } from '@gltf-transform/core';

export interface VertexFrameReport {
  /** Vertices whose normal was replaced. */
  normals: number;
  /** ... of which no triangle with area draws (set to +Y). */
  normalsUndrawn: number;
  /** Vertices whose tangent was replaced. */
  tangents: number;
  /** ... of which all triangles have degenerate UVs (any orthogonal tangent is exact). */
  tangentsArbitrary: number;
  /** Replaced vertices by mesh name. */
  byMesh: Record<string, { normals: number; tangents: number }>;
}

export class VertexFrameError extends Error {
  readonly code = 'vertex_frame_unrepairable';
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a: V3): number => Math.sqrt(dot(a, a));
const bad = (v: readonly number[]): boolean => !v.slice(0, 3).every(Number.isFinite) || Math.hypot(v[0]!, v[1]!, v[2]!) < 1e-6;
const AREA_EPS = 1e-12;

function triangles(primitive: Primitive): number[][] {
  const indices = primitive.getIndices();
  const count = indices ? indices.getCount() : primitive.getAttribute('POSITION')!.getCount();
  const out: number[][] = [];
  if (primitive.getMode() !== 4) return out; // TRIANGLES only; strips and fans are not in map exports
  for (let i = 0; i + 2 < count; i += 3) out.push(indices ? [indices.getScalar(i), indices.getScalar(i + 1), indices.getScalar(i + 2)] : [i, i + 1, i + 2]);
  return out;
}

/** Repair every NORMAL and TANGENT accessor of `document` in place. */
export function repairVertexFrames(document: Document): VertexFrameReport {
  const report: VertexFrameReport = { normals: 0, normalsUndrawn: 0, tangents: 0, tangentsArbitrary: 0, byMesh: {} };
  // Accessors can be shared (dedup): gather every primitive per accessor.
  const users = new Map<Accessor, { primitive: Primitive; mesh: string }[]>();
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      for (const semantic of ['NORMAL', 'TANGENT']) {
        const accessor = primitive.getAttribute(semantic);
        if (!accessor) continue;
        const list = users.get(accessor) ?? [];
        list.push({ primitive, mesh: mesh.getName() });
        users.set(accessor, list);
      }
    }
  }
  const tally = (mesh: string, key: 'normals' | 'tangents') => {
    const entry = report.byMesh[mesh] ?? (report.byMesh[mesh] = { normals: 0, tangents: 0 });
    entry[key] += 1;
  };
  const el: number[] = [];
  const read = (accessor: Accessor, i: number): number[] => [...accessor.getElement(i, el)];

  // Normals first: tangents are made orthogonal to the repaired normals.
  for (const [accessor, list] of users) {
    if (list[0]!.primitive.getAttribute('NORMAL') !== accessor) continue;
    const badRows: number[] = [];
    for (let i = 0; i < accessor.getCount(); i++) if (bad(read(accessor, i))) badRows.push(i);
    if (badRows.length === 0) continue;
    const wanted = new Set(badRows);
    const sum = new Map<number, V3>();
    const drawn = new Set<number>();
    for (const { primitive } of list) {
      const position = primitive.getAttribute('POSITION')!;
      for (const [a, b, c] of triangles(primitive)) {
        if (!wanted.has(a!) && !wanted.has(b!) && !wanted.has(c!)) continue;
        const pa = read(position, a!) as V3, pb = read(position, b!) as V3, pc = read(position, c!) as V3;
        const face = cross(sub(pb, pa), sub(pc, pa)); // |face| = 2 * area: area weighting
        const area = length(face);
        for (const v of [a!, b!, c!]) {
          if (!wanted.has(v)) continue;
          if (area > AREA_EPS) drawn.add(v);
          const s = sum.get(v) ?? [0, 0, 0];
          sum.set(v, [s[0] + face[0], s[1] + face[1], s[2] + face[2]]);
        }
      }
    }
    for (const v of badRows) {
      const s = sum.get(v) ?? [0, 0, 0];
      const l = length(s);
      if (l > AREA_EPS) {
        accessor.setElement(v, [s[0] / l, s[1] / l, s[2] / l]);
      } else if (drawn.has(v)) {
        throw new VertexFrameError(`vertex_frame_unrepairable: mesh ${JSON.stringify(list[0]!.mesh)} vertex ${v} is drawn but its face normals cancel`);
      } else {
        accessor.setElement(v, [0, 1, 0]);
        report.normalsUndrawn += 1;
      }
      report.normals += 1;
      tally(list[0]!.mesh, 'normals');
    }
  }

  for (const [accessor, list] of users) {
    if (list[0]!.primitive.getAttribute('TANGENT') !== accessor) continue;
    const badRows: number[] = [];
    for (let i = 0; i < accessor.getCount(); i++) if (bad(read(accessor, i))) badRows.push(i);
    if (badRows.length === 0) continue;
    const wanted = new Set(badRows);
    const sum = new Map<number, V3>();
    for (const { primitive } of list) {
      const position = primitive.getAttribute('POSITION')!;
      const uv = primitive.getAttribute('TEXCOORD_0');
      if (!uv) continue;
      for (const [a, b, c] of triangles(primitive)) {
        if (!wanted.has(a!) && !wanted.has(b!) && !wanted.has(c!)) continue;
        const pa = read(position, a!) as V3, pb = read(position, b!) as V3, pc = read(position, c!) as V3;
        const ua = read(uv, a!), ub = read(uv, b!), uc = read(uv, c!);
        const e1 = sub(pb, pa), e2 = sub(pc, pa);
        const du1 = [ub[0]! - ua[0]!, ub[1]! - ua[1]!], du2 = [uc[0]! - ua[0]!, uc[1]! - ua[1]!];
        const det = du1[0]! * du2[1]! - du2[0]! * du1[1]!;
        if (Math.abs(det) < AREA_EPS) continue;
        const t: V3 = [(e1[0] * du2[1]! - e2[0] * du1[1]!) / det, (e1[1] * du2[1]! - e2[1] * du1[1]!) / det, (e1[2] * du2[1]! - e2[2] * du1[1]!) / det];
        for (const v of [a!, b!, c!]) {
          if (!wanted.has(v)) continue;
          const s = sum.get(v) ?? [0, 0, 0];
          sum.set(v, [s[0] + t[0], s[1] + t[1], s[2] + t[2]]);
        }
      }
    }
    const normal = list[0]!.primitive.getAttribute('NORMAL');
    for (const v of badRows) {
      const old = read(accessor, v);
      let n: V3 = normal ? (read(normal, v) as V3) : [0, 1, 0];
      const nl = length(n);
      n = nl > 0 ? [n[0] / nl, n[1] / nl, n[2] / nl] : [0, 1, 0];
      const s = sum.get(v) ?? [0, 0, 0];
      let t: V3 = sub(s, [n[0] * dot(n, s), n[1] * dot(n, s), n[2] * dot(n, s)]);
      if (length(t) < 1e-9) {
        const axis: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
        t = sub(axis, [n[0] * dot(n, axis), n[1] * dot(n, axis), n[2] * dot(n, axis)]);
        report.tangentsArbitrary += 1;
      }
      const tl = length(t);
      const w = old[3] === 1 || old[3] === -1 ? old[3] : 1;
      accessor.setElement(v, [t[0] / tl, t[1] / tl, t[2] / tl, w]);
      report.tangents += 1;
      tally(list[0]!.mesh, 'tangents');
    }
  }
  return report;
}
