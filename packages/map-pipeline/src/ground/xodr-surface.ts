/**
 * A complete OpenDRIVE (1.4-1.8) road-surface evaluator, used only to
 * validate the rendered ground mesh at ingest (`ground-report.json`).
 *
 * Unlike the planar topology builder and the retired `xodr-elevation/v1`
 * resolver (reference-line elevation projected onto lane polylines), this
 * evaluates every term that shapes the surface: planView geometry (line,
 * arc, spiral, poly3, paramPoly3), `<elevation>`, `<superelevation>`,
 * `<shape>`, `<laneOffset>`, lane `<width>`/`<border>` and `<height>`
 * (laneHeight). The header `<offset>` is honoured when present.
 */

type Attrs = Record<string, string>;
interface XmlNode { name: string; attrs: Attrs; children: XmlNode[] }

const TAG = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const ATTR = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

/** Minimal element-tree parser (attributes and nesting only; text is ignored). */
export function parseXml(text: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  for (const match of text.matchAll(TAG)) {
    const name = match[2];
    if (!name) continue;
    if (match[1] === '/') {
      if (stack.length > 1 && stack[stack.length - 1]!.name === name) stack.pop();
      continue;
    }
    const attrs: Attrs = {};
    for (const a of (match[3] ?? '').matchAll(ATTR)) attrs[a[1]!] = a[3] ?? a[4] ?? '';
    const node: XmlNode = { name, attrs, children: [] };
    stack[stack.length - 1]!.children.push(node);
    if (match[4] !== '/') stack.push(node);
  }
  return root;
}

const kids = (node: XmlNode | undefined, name: string): XmlNode[] => node?.children.filter((c) => c.name === name) ?? [];
const kid = (node: XmlNode | undefined, name: string): XmlNode | undefined => node?.children.find((c) => c.name === name);
const num = (attrs: Attrs, key: string, fallback?: number): number => {
  const raw = attrs[key];
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`xodr: missing attribute ${key}`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`xodr: attribute ${key}="${raw}" is not a finite number`);
  return value;
};

type Poly = [s: number, a: number, b: number, c: number, d: number];

function evalPoly(records: readonly Poly[], s: number): number {
  if (records.length === 0) return 0;
  let r = records[0]!;
  for (const candidate of records) { if (candidate[0] > s) break; r = candidate; }
  const ds = s - r[0];
  return r[1] + r[2] * ds + r[3] * ds * ds + r[4] * ds * ds * ds;
}

interface Geometry { s: number; x: number; y: number; hdg: number; length: number; kind: string; attrs: Attrs; table?: Float64Array }

export interface XodrLane { id: number; type: string; widths: Poly[]; borders: Poly[]; heights: [number, number, number][] }
export interface XodrSection { s: number; left: XodrLane[]; right: XodrLane[] }

export class XodrRoad {
  readonly id: string;
  readonly length: number;
  readonly junction: string;
  readonly geometries: Geometry[];
  readonly elevation: Poly[];
  readonly superelevation: Poly[];
  readonly shape: [s: number, t: number, a: number, b: number, c: number, d: number][];
  readonly laneOffset: Poly[];
  readonly sections: XodrSection[];

  constructor(node: XmlNode, private readonly offset: { x: number; y: number; z: number; hdg: number }) {
    this.id = node.attrs['id'] ?? '';
    this.length = num(node.attrs, 'length');
    this.junction = node.attrs['junction'] ?? '-1';
    this.geometries = kids(kid(node, 'planView'), 'geometry').map((g) => {
      const shape = g.children[0];
      if (!shape) throw new Error(`xodr: road ${this.id} geometry without a shape`);
      return { s: num(g.attrs, 's'), x: num(g.attrs, 'x'), y: num(g.attrs, 'y'), hdg: num(g.attrs, 'hdg'), length: num(g.attrs, 'length'), kind: shape.name, attrs: shape.attrs };
    }).sort((a, b) => a.s - b.s);
    const polys = (parent: XmlNode | undefined, tag: string): Poly[] => kids(parent, tag)
      .map((e) => [num(e.attrs, 's', num(e.attrs, 'sOffset', 0)), num(e.attrs, 'a'), num(e.attrs, 'b'), num(e.attrs, 'c'), num(e.attrs, 'd')] as Poly)
      .sort((a, b) => a[0] - b[0]);
    this.elevation = polys(kid(node, 'elevationProfile'), 'elevation');
    const lateral = kid(node, 'lateralProfile');
    this.superelevation = polys(lateral, 'superelevation');
    this.shape = kids(lateral, 'shape').map((e) => [num(e.attrs, 's'), num(e.attrs, 't'), num(e.attrs, 'a'), num(e.attrs, 'b'), num(e.attrs, 'c'), num(e.attrs, 'd')] as [number, number, number, number, number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const lanes = kid(node, 'lanes');
    this.laneOffset = polys(lanes, 'laneOffset');
    this.sections = kids(lanes, 'laneSection').map((section) => {
      const side = (name: string): XodrLane[] => kids(kid(section, name), 'lane').map((lane) => ({
        id: num(lane.attrs, 'id'),
        type: lane.attrs['type'] ?? 'none',
        widths: kids(lane, 'width').map((w) => [num(w.attrs, 'sOffset'), num(w.attrs, 'a'), num(w.attrs, 'b'), num(w.attrs, 'c'), num(w.attrs, 'd')] as Poly).sort((a, b) => a[0] - b[0]),
        borders: kids(lane, 'border').map((w) => [num(w.attrs, 'sOffset'), num(w.attrs, 'a'), num(w.attrs, 'b'), num(w.attrs, 'c'), num(w.attrs, 'd')] as Poly).sort((a, b) => a[0] - b[0]),
        heights: kids(lane, 'height').map((h) => [num(h.attrs, 'sOffset'), num(h.attrs, 'inner'), num(h.attrs, 'outer')] as [number, number, number]).sort((a, b) => a[0] - b[0]),
      })).sort((a, b) => Math.abs(a.id) - Math.abs(b.id));
      return { s: num(section.attrs, 's'), left: side('left'), right: side('right') };
    }).sort((a, b) => a.s - b.s);
  }

  /** Reference-line pose at road `s` (header offset applied). */
  reference(s: number): { x: number; y: number; hdg: number } {
    const sc = Math.min(Math.max(s, 0), this.length);
    let g = this.geometries[0];
    if (!g) throw new Error(`xodr: road ${this.id} has no planView geometry`);
    for (const candidate of this.geometries) { if (candidate.s > sc) break; g = candidate; }
    const ds = Math.min(Math.max(sc - g.s, 0), g.length);
    let u: number; let v: number; let th: number;
    switch (g.kind) {
      case 'line': u = ds; v = 0; th = 0; break;
      case 'arc': {
        const k = num(g.attrs, 'curvature');
        if (Math.abs(k) < 1e-15) { u = ds; v = 0; th = 0; } else { u = Math.sin(k * ds) / k; v = (1 - Math.cos(k * ds)) / k; th = k * ds; }
        break;
      }
      case 'spiral': ({ u, v, th } = spiral(g, ds)); break;
      case 'poly3': {
        const a = num(g.attrs, 'a'); const b = num(g.attrs, 'b'); const c = num(g.attrs, 'c'); const d = num(g.attrs, 'd');
        u = ds; v = a + b * u + c * u * u + d * u * u * u; th = Math.atan(b + 2 * c * u + 3 * d * u * u);
        break;
      }
      case 'paramPoly3': {
        const p = (g.attrs['pRange'] ?? 'normalized') === 'normalized' ? ds / g.length : ds;
        const c = (k: string) => num(g.attrs, k);
        u = c('aU') + c('bU') * p + c('cU') * p * p + c('dU') * p * p * p;
        v = c('aV') + c('bV') * p + c('cV') * p * p + c('dV') * p * p * p;
        th = Math.atan2(c('bV') + 2 * c('cV') * p + 3 * c('dV') * p * p, c('bU') + 2 * c('cU') * p + 3 * c('dU') * p * p);
        break;
      }
      default: throw new Error(`xodr: road ${this.id} has unsupported geometry <${g.kind}>`);
    }
    const cos = Math.cos(g.hdg); const sin = Math.sin(g.hdg);
    const x = g.x + cos * u - sin * v; const y = g.y + sin * u + cos * v;
    const oc = Math.cos(this.offset.hdg); const os = Math.sin(this.offset.hdg);
    return { x: this.offset.x + oc * x - os * y, y: this.offset.y + os * x + oc * y, hdg: g.hdg + th + this.offset.hdg };
  }

  /** Surface z at (s, t) from elevation + superelevation + shape (no lane height). */
  surfaceZ(s: number, t: number): number {
    let z = evalPoly(this.elevation, s) + this.offset.z;
    if (this.superelevation.length > 0) z += t * Math.tan(evalPoly(this.superelevation, s));
    if (this.shape.length > 0) {
      let s0 = this.shape[0]![0];
      for (const r of this.shape) { if (r[0] > s) break; s0 = r[0]; }
      const rows = this.shape.filter((r) => r[0] === s0);
      let r = rows[0]!;
      for (const candidate of rows) { if (candidate[1] > t) break; r = candidate; }
      const dt = t - r[1];
      z += r[2] + r[3] * dt + r[4] * dt * dt + r[5] * dt * dt * dt;
    }
    return z;
  }

  /** `[inner t, outer t]` of every lane on one side of `section` at road s. */
  laneBounds(section: XodrSection, side: 'left' | 'right', s: number): { lane: XodrLane; tIn: number; tOut: number; ds: number }[] {
    const ds = s - section.s;
    const sign = side === 'left' ? 1 : -1;
    let acc = evalPoly(this.laneOffset, s);
    const out = [];
    const center = acc;
    for (const lane of section[side]) {
      if (lane.borders.length > 0 && lane.widths.length === 0) {
        const outer = center + sign * evalPoly(lane.borders, ds);
        out.push({ lane, tIn: acc, tOut: outer, ds });
        acc = outer;
        continue;
      }
      const w = evalPoly(lane.widths, ds);
      out.push({ lane, tIn: acc, tOut: acc + sign * w, ds });
      acc += sign * w;
    }
    return out;
  }
}

function spiral(g: Geometry, ds: number): { u: number; v: number; th: number } {
  const c0 = num(g.attrs, 'curvStart'); const c1 = num(g.attrs, 'curvEnd');
  const cd = g.length > 0 ? (c1 - c0) / g.length : 0;
  const theta = (s: number) => c0 * s + 0.5 * cd * s * s;
  if (!g.table) {
    // Trapezoidal integration table at <= 2 cm steps.
    const n = Math.max(2, Math.ceil(g.length / 0.02) + 1);
    const table = new Float64Array(n * 3);
    const h = g.length / (n - 1);
    for (let i = 1; i < n; i += 1) {
      const s0 = (i - 1) * h; const s1 = i * h;
      table[i * 3] = s1;
      table[i * 3 + 1] = table[(i - 1) * 3 + 1]! + 0.5 * h * (Math.cos(theta(s0)) + Math.cos(theta(s1)));
      table[i * 3 + 2] = table[(i - 1) * 3 + 2]! + 0.5 * h * (Math.sin(theta(s0)) + Math.sin(theta(s1)));
    }
    g.table = table;
  }
  const table = g.table;
  const n = table.length / 3;
  const h = g.length / (n - 1);
  const i = Math.min(n - 2, Math.max(0, Math.floor(ds / h)));
  const f = h > 0 ? (ds - i * h) / h : 0;
  const u = table[i * 3 + 1]! + f * (table[(i + 1) * 3 + 1]! - table[i * 3 + 1]!);
  const v = table[i * 3 + 2]! + f * (table[(i + 1) * 3 + 2]! - table[i * 3 + 2]!);
  return { u, v, th: theta(ds) };
}

export function parseXodrRoads(text: string): XodrRoad[] {
  const root = parseXml(text);
  const drive = kid(root, 'OpenDRIVE');
  if (!drive) throw new Error('xodr: no <OpenDRIVE> element');
  const header = kid(drive, 'header');
  const off = kid(header, 'offset');
  const offset = off ? { x: num(off.attrs, 'x', 0), y: num(off.attrs, 'y', 0), z: num(off.attrs, 'z', 0), hdg: num(off.attrs, 'hdg', 0) } : { x: 0, y: 0, z: 0, hdg: 0 };
  return kids(drive, 'road').map((road) => new XodrRoad(road, offset));
}

/** Lane types a vehicle drives on (the validation's primary population). */
export const DRIVABLE_LANE_TYPES = new Set(['driving', 'biking', 'parking', 'shoulder', 'bidirectional', 'entry', 'exit', 'onRamp', 'offRamp', 'connectingRamp', 'stop']);

export interface LaneSurfaceSample {
  road: string;
  junction: boolean;
  section: number;
  lane: number;
  laneType: string;
  s: number;
  x: number;
  y: number;
  /** Full XODR surface z at the lane centre (elevation + superelevation + shape + laneHeight). */
  z: number;
  /** Half the lane width, metres. */
  halfWidth: number;
  /** Unit left normal of the reference line at this sample. */
  leftX: number;
  leftY: number;
}

/** Lane-centre samples every `stepM` metres of road s on every lane at least `minWidthM` wide. */
export function sampleLaneCentres(roads: readonly XodrRoad[], stepM = 0.5, minWidthM = 0.3): LaneSurfaceSample[] {
  const out: LaneSurfaceSample[] = [];
  for (const road of roads) {
    road.sections.forEach((section, index) => {
      const end = road.sections[index + 1]?.s ?? road.length;
      if (end - section.s < 1e-6) return;
      const n = Math.max(2, Math.ceil((end - section.s) / stepM) + 1);
      for (let k = 0; k < n; k += 1) {
        const s = k === n - 1 ? (index + 1 < road.sections.length ? end - 1e-6 : end) : section.s + ((end - section.s) * k) / (n - 1);
        const ref = road.reference(s);
        for (const side of ['left', 'right'] as const) {
          for (const { lane, tIn, tOut, ds } of road.laneBounds(section, side, s)) {
            if (Math.abs(tOut - tIn) < minWidthM) continue;
            const t = (tIn + tOut) / 2;
            let height = 0;
            if (lane.heights.length > 0) {
              let h = lane.heights[0]!;
              for (const candidate of lane.heights) { if (candidate[0] > ds) break; h = candidate; }
              height = (h[1] + h[2]) / 2;
            }
            out.push({
              road: road.id, junction: road.junction !== '-1', section: index, lane: lane.id, laneType: lane.type, s,
              x: ref.x - Math.sin(ref.hdg) * t, y: ref.y + Math.cos(ref.hdg) * t,
              z: road.surfaceZ(s, t) + height,
              halfWidth: Math.abs(tOut - tIn) / 2,
              leftX: -Math.sin(ref.hdg), leftY: Math.cos(ref.hdg),
            });
          }
        }
      }
    });
  }
  return out;
}
