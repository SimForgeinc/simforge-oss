import type { GroundMesh } from './format.js';

/**
 * TypeScript mirror of `GroundSurface::surfaces_at` (simforge-core
 * `map/ground.rs`) for the ingest report. The simulation never uses this:
 * bodies are grounded by the Rust implementation. Semantics are identical
 * (same seam tolerance, same dedupe, highest first).
 */
export const SEAM_TOLERANCE_M = 0.05;
const SAME_SURFACE_M = 1e-4;
const CELL_MM = 4000;

export interface SurfaceSample { z: number; cls: number; triangle: number }

export class GroundQuery {
  private readonly gx0: number;
  private readonly gy0: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly start: Uint32Array;
  private readonly items: Uint32Array;

  constructor(private readonly mesh: GroundMesh) {
    const v = mesh.vertices;
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (let i = 0; i < v.length; i += 3) {
      minX = Math.min(minX, v[i]!); maxX = Math.max(maxX, v[i]!);
      minY = Math.min(minY, v[i + 1]!); maxY = Math.max(maxY, v[i + 1]!);
    }
    const pad = Math.floor(SEAM_TOLERANCE_M * 1000) + 1;
    const cell = (value: number) => Math.floor(value / CELL_MM);
    this.gx0 = cell(minX - pad); this.gy0 = cell(minY - pad);
    this.nx = cell(maxX + pad) - this.gx0 + 1; this.ny = cell(maxY + pad) - this.gy0 + 1;
    const triangleCount = mesh.triangles.length / 3;
    const spans = new Int32Array(triangleCount * 4);
    const counts = new Uint32Array(this.nx * this.ny + 1);
    for (let t = 0; t < triangleCount; t += 1) {
      let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
      for (let k = 0; k < 3; k += 1) {
        const i = mesh.triangles[t * 3 + k]! * 3;
        x0 = Math.min(x0, v[i]!); x1 = Math.max(x1, v[i]!); y0 = Math.min(y0, v[i + 1]!); y1 = Math.max(y1, v[i + 1]!);
      }
      const cx0 = cell(x0 - pad) - this.gx0; const cx1 = cell(x1 + pad) - this.gx0;
      const cy0 = cell(y0 - pad) - this.gy0; const cy1 = cell(y1 + pad) - this.gy0;
      spans.set([cx0, cx1, cy0, cy1], t * 4);
      for (let cy = cy0; cy <= cy1; cy += 1) for (let cx = cx0; cx <= cx1; cx += 1) counts[cy * this.nx + cx + 1]! += 1;
    }
    for (let i = 1; i < counts.length; i += 1) counts[i]! += counts[i - 1]!;
    const fill = counts.slice();
    const items = new Uint32Array(counts[counts.length - 1]!);
    for (let t = 0; t < triangleCount; t += 1) {
      const [cx0, cx1, cy0, cy1] = spans.subarray(t * 4, t * 4 + 4) as unknown as [number, number, number, number];
      for (let cy = cy0; cy <= cy1; cy += 1) for (let cx = cx0; cx <= cx1; cx += 1) items[fill[cy * this.nx + cx]!++] = t;
    }
    this.start = counts;
    this.items = items;
  }

  private triangleHeight(t: number, x: number, y: number): number | null {
    const { vertices: v, triangles: tr } = this.mesh;
    const a = tr[t * 3]! * 3; const b = tr[t * 3 + 1]! * 3; const c = tr[t * 3 + 2]! * 3;
    const ax = v[a]! / 1000; const ay = v[a + 1]! / 1000; const az = v[a + 2]! / 1000;
    const bx = v[b]! / 1000; const by = v[b + 1]! / 1000; const bz = v[b + 2]! / 1000;
    const cx = v[c]! / 1000; const cy = v[c + 1]! / 1000; const cz = v[c + 2]! / 1000;
    const e0x = bx - ax; const e0y = by - ay; const e1x = cx - ax; const e1y = cy - ay;
    const den = e0x * e1y - e1x * e0y;
    if (Math.abs(den) < 1e-9) return null;
    const px = x - ax; const py = y - ay;
    const vv = (px * e1y - e1x * py) / den;
    const ww = (e0x * py - px * e0y) / den;
    const uu = 1 - vv - ww;
    if (uu >= -1e-12 && vv >= -1e-12 && ww >= -1e-12) return uu * az + vv * bz + ww * cz;
    const d2 = Math.min(seg2(x, y, ax, ay, bx, by), seg2(x, y, bx, by, cx, cy), seg2(x, y, cx, cy, ax, ay));
    if (d2 <= SEAM_TOLERANCE_M * SEAM_TOLERANCE_M) {
      const u = Math.max(uu, 0); const w1 = Math.max(vv, 0); const w2 = Math.max(ww, 0);
      return (u * az + w1 * bz + w2 * cz) / (u + w1 + w2);
    }
    return null;
  }

  /** Every distinct surface under (x, y), highest first. */
  surfacesAt(x: number, y: number): SurfaceSample[] {
    const cx = Math.floor(Math.floor(x * 1000) / CELL_MM) - this.gx0;
    const cy = Math.floor(Math.floor(y * 1000) / CELL_MM) - this.gy0;
    if (cx < 0 || cy < 0 || cx >= this.nx || cy >= this.ny) return [];
    const cell = cy * this.nx + cx;
    const hits: SurfaceSample[] = [];
    for (let k = this.start[cell]!; k < this.start[cell + 1]!; k += 1) {
      const t = this.items[k]!;
      const z = this.triangleHeight(t, x, y);
      if (z !== null) hits.push({ z, cls: this.mesh.classes[t]!, triangle: t });
    }
    hits.sort((a, b) => b.z - a.z || a.cls - b.cls || a.triangle - b.triangle);
    const out: SurfaceSample[] = [];
    for (const hit of hits) if (out.length === 0 || Math.abs(out[out.length - 1]!.z - hit.z) > SAME_SURFACE_M) out.push(hit);
    return out;
  }

  /** The surface nearest `zHint` (spawn deck choice), or null when there is none. */
  nearest(x: number, y: number, zHint: number): SurfaceSample | null {
    let best: SurfaceSample | null = null;
    for (const hit of this.surfacesAt(x, y)) {
      if (!best || Math.abs(hit.z - zHint) < Math.abs(best.z - zHint)) best = hit;
    }
    return best;
  }
}

function seg2(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax; const dy = by - ay; const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
  const px = ax + t * dx - x; const py = ay + t * dy - y;
  return px * px + py * py;
}
