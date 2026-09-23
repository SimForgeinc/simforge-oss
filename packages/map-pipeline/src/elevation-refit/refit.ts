/**
 * Automatic OpenDRIVE elevation refit against the rendered road mesh.
 *
 * RoadRunner exports the rendered road mesh (GLB) and the OpenDRIVE of the
 * same scene, but their road surfaces disagree (docs/engineering/ground-height.md):
 * junction connecting roads bump and dip by 10-90 cm, some roads are offset
 * along their whole length, shoulder/parking/bike lanes carry a laneHeight
 * the mesh does not have, and a few profiles contain outright data errors.
 * The mesh is what cameras see and what bodies stand on (`derived/ground`),
 * so this refit rewrites the OpenDRIVE surface to follow it, touching only
 * `<elevationProfile>`, `<lateralProfile>` and lane `<height>`:
 *
 * 1. Sample the mesh (the ground derivative's {@link GroundQuery}, the same
 *    surface the simulation grounds bodies on) across every lane every 0.5 m,
 *    choosing on stacked decks the one nearest the road's current z (a bridge
 *    is never snapped to the road below it).
 * 2. Per road, fit `z(s, t) = E(s) + t tan(phi(s))` by robust least squares
 *    with C1 cubic Hermite splines (adaptive knots), E = `<elevation>`,
 *    phi = `<superelevation>`.
 * 3. Continuity: non-junction roads first, pinned (value and slope of E and
 *    phi) to unchanged neighbours or to a consensus with changed ones; then
 *    junction connecting roads, pinned at both contact points to the final
 *    incoming and outgoing road surfaces. That is what removes the
 *    intersection bumps.
 * 4. laneHeight: per lane, the residual offset from the fitted surface
 *    (piecewise constant in s, inner/outer across the lane); removed where
 *    the mesh has no offset.
 * 5. Where the mesh has no surface (holes) the original OpenDRIVE surface is
 *    kept (it is fed to the fit as the observation) and listed.
 *
 * Roads whose original surface already matches the mesh are left untouched.
 */

import { createHash } from 'node:crypto';

import { SURFACE_CLASSES } from '../ground/format.js';
import { GroundQuery } from '../ground/query.js';
import { DRIVABLE_LANE_TYPES, parseXodrRoads, type XodrLane, type XodrRoad } from '../ground/xodr-surface.js';
import {
  elevationRecords,
  evalComponent,
  evalRecords,
  fitSpline2,
  mergeRecords,
  superelevationRecords,
  unknownIndex,
  type CubicRecord,
  type Observation,
  type Pin,
  type Spline2,
} from './spline.js';
import { CONTACT_SLOPE_SPAN_M } from './verify.js';
import { applyEdits, child, childrenNamed, formatNumber, indentAt, lineRange, newlineOf, scanXml, type TextEdit, type XmlElement } from './xodr-text.js';

/** Bump when identical inputs would produce a different corrected XODR. */
export const REFIT_REVISION = 1;

export const REFIT_PARAMS = {
  /** Station spacing along s. */
  stepM: 0.5,
  /** Lateral sample positions across each lane (0 = inner border, 1 = outer). */
  fractions: [0.2, 0.5, 0.8] as const,
  /** Lanes narrower than this are not sampled. */
  minLaneWidthM: 0.3,
  /** A road keeps its original elevation/lateral profile when its lane-centre p95/max |dz| are within these. */
  keepP95M: 0.015,
  keepMaxM: 0.03,
  /** A lane keeps its original laneHeight when its residual is within this at 95 % of samples. */
  keepHeightM: 0.015,
  /** A surface within this of the road's current z is its deck (a seed for deck tracking). */
  seedM: 0.3,
  /** A lone surface within this of the road's current z is also a seed. */
  deckJumpM: 2.0,
  /** Deck tracking: the most the surface may change between consecutive 0.5 m samples. */
  continuityStepM: 0.2,
  /** Grades above this in the original elevation are data errors (no real road is this steep). */
  dataErrorGrade: 0.3,
  /** laneHeight magnitudes above this are data errors. */
  dataErrorLaneHeightM: 1.0,
  /** Initial knot spacing and the smallest interval adaptive refinement may create. */
  knotSpacingM: 8,
  minKnotSpacingM: 1,
  /** Refine an interval while a station's mean or cross-slope residual exceeds this. */
  refineTolM: 0.008,
  refineRounds: 6,
  /** Huber threshold of the robust fit. */
  huberM: 0.02,
  irlsIterations: 4,
  smoothE: 1e-2,
  smoothG: 1e-1,
  ridgeG: 0.5,
  /** Lateral span of carriageway samples needed to fit a cross-slope. */
  minLateralSpreadM: 2,
  /** Largest believable |tan(superelevation)|. */
  maxCrossSlope: 0.12,
  /** Below this share of paved carriageway samples, a road's plane is fitted to terrain/kerb surfaces instead. */
  minPavedShare: 0.2,
  /** laneHeight: segment tolerance along s, lateral-variation threshold, zero threshold, shortest record. */
  heightSegmentTolM: 0.01,
  heightTiltM: 0.02,
  heightTiltMaxM: 0.25,
  heightZeroM: 0.005,
  heightMinRecordM: 1,
  /** A laneHeight step larger than this is real (a kerb) and never merged away. */
  heightStepM: 0.05,
  /** A lane section needs this share of stations covered by the mesh to refit its laneHeight. */
  heightMinCoverage: 0.5,
  /** Contact points further apart than this along the road are not pinned (reported). */
  contactAlongTolM: 0.5,
  /** An unchanged junction road is refit when a refit neighbour no longer meets it within these. */
  contactTolM: 0.0005,
  contactSlopeTol: 0.001,
  contactLateralMaxM: 25,
} as const;

/** Lane types whose surface drives the E/phi fit (the carriageway). */
const PRIMARY_TYPES = new Set(['driving', 'bidirectional', 'entry', 'exit', 'onRamp', 'offRamp', 'connectingRamp', 'stop']);
/** Lane types whose laneHeight is refitted. */
const HEIGHT_TYPES = new Set([...DRIVABLE_LANE_TYPES, 'sidewalk', 'walking']);
/** Surfaces that are not carriageway paving: kerb and sidewalk tops, and terrain (verges). They go to laneHeight, not to E/phi. */
const RAISED_CLASSES = new Set<number>([SURFACE_CLASSES.curb, SURFACE_CLASSES.sidewalk, SURFACE_CLASSES.terrain]);

export const REFIT_FINGERPRINT = createHash('sha256').update(JSON.stringify({ revision: REFIT_REVISION, params: REFIT_PARAMS })).digest('hex');

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

type SampleFlag = 'ok' | 'hole' | 'raised' | 'no-deck';

interface LaneRef { section: number; side: 'left' | 'right'; lane: XodrLane }

interface RoadSamples {
  lanes: LaneRef[];
  /** Struct of arrays, one entry per sample. */
  lane: Int32Array; // index into lanes
  station: Int32Array;
  s: Float64Array;
  ds: Float64Array; // s - section start
  t: Float64Array;
  frac: Float64Array;
  x: Float64Array;
  y: Float64Array;
  /** Original OpenDRIVE surface (elevation + superelevation + shape), no laneHeight. */
  zOrig: Float64Array;
  /** Original laneHeight at the sample's lateral fraction. */
  hOrig: Float64Array;
  mesh: Float64Array; // NaN when no usable deck
  flag: Uint8Array; // index into FLAGS
  /** 1 when the chosen deck is a kerb or sidewalk top (never used for the carriageway plane). */
  raised: Uint8Array;
}
const FLAGS: SampleFlag[] = ['ok', 'hole', 'raised', 'no-deck'];

function laneHeightAt(lane: XodrLane, ds: number, frac: number): number {
  if (lane.heights.length === 0) return 0;
  let h = lane.heights[0]!;
  for (const candidate of lane.heights) { if (candidate[0] > ds) break; h = candidate; }
  return h[1] + (h[2] - h[1]) * frac;
}

function sampleRoad(road: XodrRoad): Omit<RoadSamples, 'mesh' | 'flag' | 'raised'> {
  const lanes: LaneRef[] = [];
  const laneIndex = new Map<string, number>();
  const cols: number[][] = [[], [], [], [], [], [], [], [], [], [], []];
  let station = 0;
  road.sections.forEach((section, index) => {
    const end = road.sections[index + 1]?.s ?? road.length;
    if (end - section.s < 1e-6) return;
    const n = Math.max(2, Math.ceil((end - section.s) / REFIT_PARAMS.stepM) + 1);
    for (let k = 0; k < n; k += 1) {
      const s = k === n - 1 ? (index + 1 < road.sections.length ? end - 1e-6 : end) : section.s + ((end - section.s) * k) / (n - 1);
      const ref = road.reference(s);
      const sin = Math.sin(ref.hdg); const cos = Math.cos(ref.hdg);
      for (const side of ['left', 'right'] as const) {
        for (const { lane, tIn, tOut, ds } of road.laneBounds(section, side, s)) {
          if (Math.abs(tOut - tIn) < REFIT_PARAMS.minLaneWidthM) continue;
          const key = `${index}:${lane.id}`;
          let li = laneIndex.get(key);
          if (li === undefined) { li = lanes.length; lanes.push({ section: index, side, lane }); laneIndex.set(key, li); }
          for (const frac of REFIT_PARAMS.fractions) {
            const t = tIn + (tOut - tIn) * frac;
            cols[0]!.push(li); cols[1]!.push(station); cols[2]!.push(s); cols[3]!.push(ds); cols[4]!.push(t); cols[5]!.push(frac);
            cols[6]!.push(ref.x - sin * t); cols[7]!.push(ref.y + cos * t);
            cols[8]!.push(road.surfaceZ(s, t)); cols[9]!.push(laneHeightAt(lane, ds, frac));
          }
        }
      }
      station += 1;
    }
  });
  return {
    lanes,
    lane: Int32Array.from(cols[0]!), station: Int32Array.from(cols[1]!), s: Float64Array.from(cols[2]!), ds: Float64Array.from(cols[3]!),
    t: Float64Array.from(cols[4]!), frac: Float64Array.from(cols[5]!), x: Float64Array.from(cols[6]!), y: Float64Array.from(cols[7]!),
    zOrig: Float64Array.from(cols[8]!), hOrig: Float64Array.from(cols[9]!),
  };
}

/**
 * Choose the mesh deck under every sample by following each lane line
 * (one lane, one lateral fraction) along s:
 *
 * - seeds are samples with a surface within {@link REFIT_PARAMS.seedM} of the
 *   hint (the road's current z), or with exactly one surface within
 *   {@link REFIT_PARAMS.deckJumpM};
 * - from every seed the line is followed forwards and backwards, taking the
 *   surface nearest the previous one, as long as consecutive samples stay
 *   within {@link REFIT_PARAMS.continuityStepM} (a road surface is
 *   continuous).
 *
 * So a bridge keeps its deck even where the ground below is nearer the old
 * z, a road whose OpenDRIVE profile has a spurious bump follows the one
 * continuous surface under it, and a bridge whose deck is missing from the
 * mesh does not snap to the ground: the jump breaks continuity and the
 * samples become `no-deck` (the original OpenDRIVE is kept there).
 * Carriageway lanes ignore kerb and sidewalk tops when a road-class surface
 * exists.
 */
function selectDecks(query: GroundQuery, samples: Omit<RoadSamples, 'mesh' | 'flag' | 'raised'>, hint: (i: number) => number, primaryLane: readonly boolean[]): { mesh: Float64Array; flag: Uint8Array; raised: Uint8Array } {
  const n = samples.s.length;
  const mesh = new Float64Array(n).fill(NaN);
  const flag = new Uint8Array(n);
  const raised = new Uint8Array(n);
  const layers: Float64Array[] = new Array(n);
  const layerRaised: Uint8Array[] = new Array(n);
  const seed = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const surfaces = query.surfacesAt(samples.x[i]!, samples.y[i]!);
    let usable = surfaces;
    if (primaryLane[samples.lane[i]!]) {
      const flat = surfaces.filter((sf) => !RAISED_CLASSES.has(sf.cls));
      if (flat.length > 0) usable = flat;
    }
    layers[i] = Float64Array.from(usable.map((sf) => sf.z));
    layerRaised[i] = Uint8Array.from(usable.map((sf) => (RAISED_CLASSES.has(sf.cls) ? 1 : 0)));
    if (usable.length === 0) { flag[i] = 1; continue; }
    const h = hint(i);
    let best = NaN; let bestD = Infinity;
    let bestK = -1;
    layers[i]!.forEach((z, k) => { const d = Math.abs(z - h); if (d < bestD) { bestD = d; best = z; bestK = k; } });
    if (bestD <= REFIT_PARAMS.seedM || (usable.length === 1 && bestD <= REFIT_PARAMS.deckJumpM)) { seed[i] = 1; mesh[i] = best; raised[i] = layerRaised[i]![bestK]!; }
  }
  // Lines: samples of one lane and fraction, in s order (sampling is station-major).
  const lines = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const key = samples.lane[i]! * 16 + REFIT_PARAMS.fractions.indexOf(samples.frac[i] as 0.2 | 0.5 | 0.8);
    let line = lines.get(key);
    if (!line) { line = []; lines.set(key, line); }
    line.push(i);
  }
  const follow = (line: number[], order: number[]) => {
    let prev = NaN; let prevS = NaN;
    for (const k of order) {
      const i = line[k]!;
      if (seed[i]) { prev = mesh[i]!; prevS = samples.s[i]!; continue; }
      if (Number.isNaN(prev) || layers[i]!.length === 0) { prev = NaN; continue; }
      let best = NaN; let bestD = Infinity; let bestK = -1;
      layers[i]!.forEach((z, k) => { const d = Math.abs(z - prev); if (d < bestD) { bestD = d; best = z; bestK = k; } });
      const step = REFIT_PARAMS.continuityStepM * Math.max(1, Math.abs(samples.s[i]! - prevS) / REFIT_PARAMS.stepM);
      if (bestD > step) { prev = NaN; continue; }
      if (Number.isNaN(mesh[i]!)) { mesh[i] = best; raised[i] = layerRaised[i]![bestK]!; }
      prev = best; prevS = samples.s[i]!;
    }
  };
  for (const line of lines.values()) {
    const idx = line.map((_, k) => k);
    follow(line, idx);
    follow(line, idx.reverse());
  }
  for (let i = 0; i < n; i += 1) if (flag[i] === 0 && Number.isNaN(mesh[i]!)) flag[i] = 3;
  return { mesh, flag, raised };
}

// ---------------------------------------------------------------------------
// Surface models
// ---------------------------------------------------------------------------

/** E/phi of a road: either its original records or a fitted spline. */
interface SurfaceModel {
  kind: 'original' | 'fitted';
  elevation: CubicRecord[];
  superelevation: CubicRecord[];
  /** Original shape stays only on unchanged roads. */
  keepShape: boolean;
  spline?: Spline2;
}

function modelEval(road: XodrRoad, model: SurfaceModel, s: number, t: number): number {
  if (model.kind === 'original') return road.surfaceZ(s, t);
  const e = evalRecords(model.elevation, s).value;
  const phi = evalRecords(model.superelevation, s).value;
  return e + t * Math.tan(phi);
}

/** E, E', G = tan(phi), G' at s (reference line). */
function modelState(model: SurfaceModel, s: number): { e: number; de: number; g: number; dg: number } {
  const e = evalRecords(model.elevation, s);
  const p = evalRecords(model.superelevation, s);
  const g = Math.tan(p.value);
  return { e: e.value, de: e.slope, g, dg: p.slope * (1 + g * g) };
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

interface Contact {
  /** This road's end. */
  end: 'start' | 'end';
  other: string;
  otherEnd: 'start' | 'end';
}

function parseContacts(tree: XmlElement): Map<string, Contact[]> {
  const out = new Map<string, Contact[]>();
  const drive = child(tree, 'OpenDRIVE');
  for (const road of childrenNamed(drive, 'road')) {
    const id = road.attrs['id']!;
    const list: Contact[] = [];
    const link = child(road, 'link');
    for (const [tag, end] of [['predecessor', 'start'], ['successor', 'end']] as const) {
      const e = child(link, tag);
      if (!e || e.attrs['elementType'] !== 'road') continue;
      const cp = e.attrs['contactPoint'];
      if (cp !== 'start' && cp !== 'end') continue;
      list.push({ end, other: e.attrs['elementId']!, otherEnd: cp });
    }
    out.set(id, list);
  }
  return out;
}

interface ContactGeometry {
  sigma: 1 | -1;
  tOff: number;
  along: number;
  sSelf: number;
  sOther: number;
  /**
   * Metric of the other road's (s, t) frame at the contact: arc length per
   * unit s along the line t = tOff, i.e. 1 - curvature * tOff. Slopes per
   * unit s of the other road become slopes per metre by dividing by it.
   */
  metric: number;
}

function contactGeometry(self: XodrRoad, other: XodrRoad, c: Contact): ContactGeometry {
  const sSelf = c.end === 'start' ? 0 : self.length;
  const sOther = c.otherEnd === 'start' ? 0 : other.length;
  const p = self.reference(sSelf);
  const q = other.reference(sOther);
  const dx = p.x - q.x; const dy = p.y - q.y;
  const tOff = -Math.sin(q.hdg) * dx + Math.cos(q.hdg) * dy;
  const h = Math.min(CONTACT_SLOPE_SPAN_M, other.length / 2);
  const s2 = c.otherEnd === 'start' ? sOther + h : sOther - h;
  const q2 = other.reference(s2);
  const at = (r: { x: number; y: number; hdg: number }) => [r.x - Math.sin(r.hdg) * tOff, r.y + Math.cos(r.hdg) * tOff];
  const [ax, ay] = at(q); const [bx, by] = at(q2);
  const metric = h > 0 ? Math.hypot(bx! - ax!, by! - ay!) / h : 1;
  return {
    sigma: Math.cos(p.hdg - q.hdg) >= 0 ? 1 : -1,
    tOff,
    along: Math.cos(q.hdg) * dx + Math.sin(q.hdg) * dy,
    sSelf,
    sOther,
    metric: metric > 1e-6 ? metric : 1,
  };
}

// ---------------------------------------------------------------------------
// Per-road fit
// ---------------------------------------------------------------------------

interface RoadWork {
  road: XodrRoad;
  samples: RoadSamples;
  junction: boolean;
  primary: Uint8Array; // sample is on a primary (E/phi) lane
  dataError: string[];
  /** Original surface disagreement on drivable lane centres. */
  before: RoadStats;
  needsFit: boolean;
  reason: string[];
  /** Which surface defined the carriageway plane in the last fit. */
  carriageway?: 'paved' | 'unpaved' | 'none' | 'interpolated';
  /** The road has carriageway-type lanes (driving, ramps, ...). */
  hasCarriageway: boolean;
}

export interface RoadStats { samples: number; p95: number; max: number; mean: number }

function stats(values: number[]): RoadStats {
  if (values.length === 0) return { samples: 0, p95: 0, max: 0, mean: 0 };
  const abs = values.map(Math.abs).sort((a, b) => a - b);
  return {
    samples: values.length,
    p95: abs[Math.min(abs.length - 1, Math.floor(0.95 * (abs.length - 1)))]!,
    max: abs[abs.length - 1]!,
    mean: values.reduce((a, b) => a + b, 0) / values.length,
  };
}

function detectDataErrors(road: XodrRoad): string[] {
  const out: string[] = [];
  for (let i = 0; i < road.elevation.length; i += 1) {
    const r = road.elevation[i]!;
    const end = road.elevation[i + 1]?.[0] ?? road.length;
    for (let k = 0; k <= 16; k += 1) {
      const ds = ((end - r[0]) * k) / 16;
      const grade = r[2] + 2 * r[3] * ds + 3 * r[4] * ds * ds;
      if (Math.abs(grade) > REFIT_PARAMS.dataErrorGrade) {
        out.push(`elevation grade ${(grade * 100).toFixed(0)} % at s ${(r[0] + ds).toFixed(1)} m`);
        break;
      }
    }
  }
  for (let i = 1; i < road.elevation.length; i += 1) {
    const p = road.elevation[i - 1]!; const r = road.elevation[i]!;
    const ds = r[0] - p[0];
    const end = p[1] + p[2] * ds + p[3] * ds * ds + p[4] * ds * ds * ds;
    if (Math.abs(end - r[1]) > 0.05) out.push(`elevation step ${((r[1] - end) * 100).toFixed(0)} cm at s ${r[0].toFixed(1)} m`);
  }
  for (const section of road.sections) {
    for (const lane of [...section.left, ...section.right]) {
      for (const h of lane.heights) {
        if (Math.max(Math.abs(h[1]), Math.abs(h[2])) > REFIT_PARAMS.dataErrorLaneHeightM) out.push(`lane ${lane.id} laneHeight ${h[1].toFixed(2)}/${h[2].toFixed(2)} m at section s ${section.s.toFixed(1)}`);
      }
    }
  }
  return out;
}

function makeKnots(length: number, spacing: number): number[] {
  const n = Math.max(1, Math.ceil(length / spacing - 1e-9));
  return Array.from({ length: n + 1 }, (_, i) => (i === n ? length : (length * i) / n));
}

interface EndPins { start?: { e: number; de: number; g: number; dg: number }; end?: { e: number; de: number; g: number; dg: number } }

interface FitOutcome { spline: Spline2; fitLateral: boolean }

/**
 * Fit E/G for one road on its primary-lane samples (holes observe the
 * original surface), with adaptive knots and IRLS.
 */
function fitRoad(work: RoadWork, pins: EndPins, originalModel: SurfaceModel): FitOutcome {
  const { road, samples } = work;
  const n = samples.s.length;
  const obs: Observation[] = [];
  const obsStation: number[] = [];
  let tMin = Infinity; let tMax = -Infinity;
  // Paved samples define the carriageway plane. A road with (almost) no
  // paved surface under its lanes (drawn as terrain) uses what there is.
  let paved = 0; let unpaved = 0;
  for (let i = 0; i < n; i += 1) {
    if (!work.primary[i] || FLAGS[samples.flag[i]!] !== 'ok') continue;
    if (samples.raised[i]) unpaved += 1; else paved += 1;
  }
  const usePaved = paved >= REFIT_PARAMS.minPavedShare * (paved + unpaved);
  work.carriageway = paved + unpaved === 0 ? 'none' : usePaved ? 'paved' : 'unpaved';
  // A shoulder/sidewalk-only connecting road between two contacts carries no
  // carriageway: its reference profile joins the two contacts smoothly and
  // the verge/kerb levels under its lanes go to laneHeight.
  const interpolate = !work.hasCarriageway && pins.start !== undefined && pins.end !== undefined;
  if (interpolate) work.carriageway = 'interpolated';
  for (let i = 0; i < n; i += 1) {
    if (interpolate) break;
    if (!work.primary[i]) continue;
    const f = FLAGS[samples.flag[i]!]!;
    let z: number;
    if (f === 'ok') {
      // Kerb and sidewalk tops belong in laneHeight, not in the carriageway plane.
      if (usePaved && samples.raised[i]) continue;
      z = samples.mesh[i]!;
    }
    else if (f === 'hole' || f === 'no-deck') z = samples.zOrig[i]!;
    else continue; // raised: a kerb top under a driving lane is not the road
    obs.push({ s: samples.s[i]!, t: samples.t[i]!, z, w: 1 });
    obsStation.push(samples.station[i]!);
    tMin = Math.min(tMin, samples.t[i]!); tMax = Math.max(tMax, samples.t[i]!);
  }
  // Cross-slope is identifiable only across a real lateral span; on narrow
  // (shoulder-only) roads G stays at the pinned contact values and 0 between.
  let fitLateral = tMax - tMin >= REFIT_PARAMS.minLateralSpreadM;
  let knots = makeKnots(road.length, Math.min(REFIT_PARAMS.knotSpacingM, road.length));
  const pinList = (K: number): Pin[] => {
    const out: Pin[] = [];
    const add = (k: number, p: { e: number; de: number; g: number; dg: number }) => {
      out.push({ index: unknownIndex(k, 0, 0), value: p.e }, { index: unknownIndex(k, 0, 1), value: p.de });
      out.push({ index: unknownIndex(k, 1, 0), value: p.g }, { index: unknownIndex(k, 1, 1), value: p.dg });
    };
    if (pins.start) add(0, pins.start);
    if (pins.end) add(K - 1, pins.end);
    return out;
  };
  let options = { smoothE: REFIT_PARAMS.smoothE, smoothG: REFIT_PARAMS.smoothG, ridgeG: REFIT_PARAMS.ridgeG, fitLateral };
  if (obs.length === 0 && pins.start === undefined && pins.end === undefined) {
    // No carriageway samples and nothing to meet: reproduce the original profile.
    for (let k = 0; k <= 64; k += 1) {
      const s = (road.length * k) / 64;
      obs.push({ s, t: 0, z: modelEval(road, originalModel, s, 0), w: 1 });
      obsStation.push(-1);
    }
  }
  let spline: Spline2 = fitSpline2(Float64Array.from(knots), obs, pinList(knots.length), options);
  const refine = (): void => {
  for (let round = 0; round <= REFIT_PARAMS.refineRounds; round += 1) {
    // IRLS
    for (let it = 0; it < REFIT_PARAMS.irlsIterations; it += 1) {
      for (const o of obs) {
        const e = evalComponent(spline, 0, o.s).value; const g = options.fitLateral ? evalComponent(spline, 1, o.s).value : 0;
        const r = Math.abs(o.z - (e + o.t * g));
        o.w = r <= REFIT_PARAMS.huberM ? 1 : REFIT_PARAMS.huberM / r;
      }
      spline = fitSpline2(Float64Array.from(knots), obs, pinList(knots.length), options);
    }
    if (round === REFIT_PARAMS.refineRounds) break;
    // Station residuals: mean (along-s misfit) and lateral slope (cross-slope misfit).
    const bad = new Set<number>();
    const perStation = new Map<number, { s: number; r: number[]; t: number[] }>();
    obs.forEach((o, j) => {
      const e = evalComponent(spline, 0, o.s).value; const g = options.fitLateral ? evalComponent(spline, 1, o.s).value : 0;
      let st = perStation.get(obsStation[j]!);
      if (!st) { st = { s: o.s, r: [], t: [] }; perStation.set(obsStation[j]!, st); }
      st.r.push(o.z - (e + o.t * g)); st.t.push(o.t);
    });
    for (const st of perStation.values()) {
      const med = [...st.r].sort((a, b) => a - b)[st.r.length >> 1]!;
      let tilt = 0;
      if (st.t.length >= 3) {
        const tm = st.t.reduce((a, b) => a + b, 0) / st.t.length; const rm = st.r.reduce((a, b) => a + b, 0) / st.r.length;
        let num = 0; let den = 0;
        st.t.forEach((t, i) => { num += (t - tm) * (st.r[i]! - rm); den += (t - tm) ** 2; });
        if (den > 1e-6) tilt = Math.abs(num / den) * (Math.max(...st.t) - Math.min(...st.t)) / 2;
      }
      if (Math.abs(med) > REFIT_PARAMS.refineTolM || (fitLateral && tilt > REFIT_PARAMS.refineTolM)) {
        const k = knots.findIndex((kv, i) => i + 1 < knots.length && st.s >= kv && st.s <= knots[i + 1]!);
        if (k >= 0 && knots[k + 1]! - knots[k]! >= 2 * REFIT_PARAMS.minKnotSpacingM) bad.add(k);
      }
    }
    if (bad.size === 0) break;
    const next: number[] = [];
    for (let k = 0; k < knots.length; k += 1) {
      next.push(knots[k]!);
      if (bad.has(k)) next.push((knots[k]! + knots[k + 1]!) / 2);
    }
    knots = next;
    spline = fitSpline2(Float64Array.from(knots), obs, pinList(knots.length), options);
  }
  };
  refine();
  // A cross-slope beyond any real road's superelevation means the E/G split is
  // ill-conditioned (lanes far from the reference line): fit E alone.
  const maxG = () => Math.max(...Array.from({ length: spline.knots.length }, (_, k) => Math.abs(spline.coef[unknownIndex(k, 1, 0)]!)));
  if (fitLateral && maxG() > REFIT_PARAMS.maxCrossSlope) {
    fitLateral = false;
    options = { ...options, fitLateral };
    for (const o of obs) o.w = 1;
    knots = makeKnots(road.length, Math.min(REFIT_PARAMS.knotSpacingM, road.length));
    spline = fitSpline2(Float64Array.from(knots), obs, pinList(knots.length), options);
    refine();
  }
  return { spline, fitLateral };
}

function splineModel(spline: Spline2, length: number): SurfaceModel {
  return {
    kind: 'fitted',
    elevation: mergeRecords(elevationRecords(spline), length, 1e-6),
    superelevation: mergeRecords(superelevationRecords(spline), length, 1e-7),
    keepShape: false,
    spline,
  };
}

// ---------------------------------------------------------------------------
// laneHeight
// ---------------------------------------------------------------------------

export type HeightRecord = [sOffset: number, inner: number, outer: number];

interface LaneHeightResult {
  section: number;
  laneId: number;
  laneType: string;
  action: 'kept' | 'refit' | 'removed' | 'hole-kept';
  before: HeightRecord[];
  after: HeightRecord[];
  coverage: number;
}

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[s.length >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN; };
const round3 = (v: number) => Math.round(v * 1000) / 1000;

function refitLaneHeights(work: RoadWork, model: SurfaceModel): LaneHeightResult[] {
  const { road, samples } = work;
  const out: LaneHeightResult[] = [];
  const byLane = new Map<number, number[]>();
  for (let i = 0; i < samples.s.length; i += 1) {
    const li = samples.lane[i]!;
    let list = byLane.get(li);
    if (!list) { list = []; byLane.set(li, list); }
    list.push(i);
  }
  samples.lanes.forEach((ref, li) => {
    const { lane } = ref;
    if (!HEIGHT_TYPES.has(lane.type)) return;
    const idx = byLane.get(li) ?? [];
    const section = road.sections[ref.section]!;
    const residual = (i: number) => samples.mesh[i]! - modelEval(road, model, samples.s[i]!, samples.t[i]!);
    const stations = new Map<number, { ds: number; r: Map<number, number> }>();
    let covered = 0;
    for (const i of idx) {
      let st = stations.get(samples.station[i]!);
      if (!st) { st = { ds: samples.ds[i]!, r: new Map() }; stations.set(samples.station[i]!, st); }
      if (FLAGS[samples.flag[i]!] === 'ok') st.r.set(samples.frac[i]!, residual(i));
    }
    const list = [...stations.values()].sort((a, b) => a.ds - b.ds);
    for (const st of list) if (st.r.has(0.5)) covered += 1;
    const coverage = list.length ? covered / list.length : 0;
    const before: HeightRecord[] = lane.heights.map((h) => [h[0], h[1], h[2]]);
    const base = { section: ref.section, laneId: lane.id, laneType: lane.type, before, coverage };
    if (coverage < REFIT_PARAMS.heightMinCoverage) { out.push({ ...base, action: 'hole-kept', after: before }); return; }
    // Does the original laneHeight already match?
    const dev: number[] = [];
    for (const i of idx) if (FLAGS[samples.flag[i]!] === 'ok') dev.push(Math.abs(residual(i) - samples.hOrig[i]!));
    dev.sort((a, b) => a - b);
    const p95 = dev[Math.min(dev.length - 1, Math.floor(0.95 * (dev.length - 1)))] ?? 0;
    const dataError = lane.heights.some((h) => Math.max(Math.abs(h[1]), Math.abs(h[2])) > REFIT_PARAMS.dataErrorLaneHeightM);
    if (p95 <= REFIT_PARAMS.keepHeightM && !dataError) { out.push({ ...base, action: 'kept', after: before }); return; }
    // Segment along s: centre offset c and full-lane tilt.
    type Seg = { ds0: number; ds1: number; c: number[]; tilt: number[] };
    const segs: Seg[] = [];
    let cur: Seg | null = null;
    for (const st of list) {
      const c = st.r.get(0.5);
      if (c === undefined) continue;
      const lo = st.r.get(0.2); const hi = st.r.get(0.8);
      const tilt = lo !== undefined && hi !== undefined ? (hi - lo) / 0.6 : 0;
      if (cur) {
        const cs = [...cur.c, c];
        if (Math.max(...cs) - Math.min(...cs) <= 2 * REFIT_PARAMS.heightSegmentTolM) { cur.c.push(c); cur.tilt.push(tilt); cur.ds1 = st.ds; continue; }
      }
      cur = { ds0: st.ds, ds1: st.ds, c: [c], tilt: [tilt] };
      segs.push(cur);
    }
    // Merge short segments (a seam or a single odd sample) into the adjacent
    // segment with the closer level, unless the step is real (> heightStepM).
    const level = (sg: Seg) => median(sg.c);
    const length = (k: number, list: Seg[]) => list[k]!.ds1 - list[k]!.ds0 + REFIT_PARAMS.stepM;
    let merged: Seg[] = segs.map((sg) => ({ ds0: sg.ds0, ds1: sg.ds1, c: [...sg.c], tilt: [...sg.tilt] }));
    for (let changed = true; changed && merged.length > 1;) {
      changed = false;
      for (let k = 0; k < merged.length; k += 1) {
        if (length(k, merged) >= REFIT_PARAMS.heightMinRecordM) continue;
        const here = level(merged[k]!);
        const prev = merged[k - 1]; const next = merged[k + 1];
        const dPrev = prev ? Math.abs(level(prev) - here) : Infinity;
        const dNext = next ? Math.abs(level(next) - here) : Infinity;
        if (Math.min(dPrev, dNext) > REFIT_PARAMS.heightStepM) continue;
        if (dPrev <= dNext) { prev!.c.push(...merged[k]!.c); prev!.tilt.push(...merged[k]!.tilt); prev!.ds1 = merged[k]!.ds1; }
        else { next!.ds0 = merged[k]!.ds0; next!.c.unshift(...merged[k]!.c); next!.tilt.unshift(...merged[k]!.tilt); }
        merged.splice(k, 1);
        changed = true;
        break;
      }
    }
    merged = merged.filter((sg) => sg.c.length > 0);
    const records: HeightRecord[] = [];
    merged.forEach((sg, k) => {
      const c = median(sg.c); const tilt = median(sg.tilt);
      let inner = c; let outer = c;
      // A cross-lane tilt is kept only when it is a plausible lateral slope (a
      // kerb ramp or gutter), not an edge sample that fell off the lane.
      if (Math.abs(tilt) >= REFIT_PARAMS.heightTiltM && Math.abs(tilt) <= REFIT_PARAMS.heightTiltMaxM) { inner = c - tilt / 2; outer = c + tilt / 2; }
      inner = round3(inner); outer = round3(outer);
      if (Math.abs(inner) < REFIT_PARAMS.heightZeroM && Math.abs(outer) < REFIT_PARAMS.heightZeroM) { inner = 0; outer = 0; }
      // A record starts midway between the last station of the previous level
      // and the first of this one, so every station reads its own level.
      const ds0 = k === 0 ? 0 : round3((merged[k - 1]!.ds1 + sg.ds0) / 2);
      const prev = records[records.length - 1];
      if (prev && prev[1] === inner && prev[2] === outer) return;
      records.push([ds0, inner, outer]);
    });
    void section;
    const allZero = records.every((r) => r[1] === 0 && r[2] === 0);
    out.push({ ...base, action: allZero ? 'removed' : 'refit', after: allZero ? [] : records });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Map refit
// ---------------------------------------------------------------------------

export interface RoadChange {
  road: string;
  junction: boolean;
  profile: 'kept' | 'refit';
  reasons: string[];
  dataErrors: string[];
  /** Max |new - old| of the reference-line elevation (m). */
  maxElevationChangeM: number;
  /** Max |new - old| of the full surface at drivable lane centres, including laneHeight (m). */
  maxSurfaceChangeM: number;
  knots: number;
  elevationRecords: number;
  superelevationMaxRad: number;
  shapeZeroed: boolean;
  /** Surface the carriageway plane was fitted to ('unpaved': the road is drawn as terrain/kerb). */
  carriageway: 'paved' | 'unpaved' | 'none' | 'interpolated' | 'not-fitted';
  pinned: string[];
  lanes: LaneHeightResult[];
  holes: { samples: number; noDeck: number; sRanges: [number, number][] };
  before: RoadStats;
}

export interface RefitResult {
  correctedText: string;
  roads: RoadChange[];
  warnings: string[];
  fingerprint: string;
}

export interface RefitOptions {
  /** Called with progress lines (stderr in the CLI). */
  log?: (line: string) => void;
}

function sRanges(values: number[]): [number, number][] {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s - last[1] <= REFIT_PARAMS.stepM * 1.5) last[1] = s; else out.push([s, s]);
  }
  return out.map(([a, b]) => [Math.round(a * 10) / 10, Math.round(b * 10) / 10]);
}

export function refitXodrElevation(xodrText: string, query: GroundQuery, options: RefitOptions = {}): RefitResult {
  const log = options.log ?? (() => {});
  const tree = scanXml(xodrText);
  const roads = parseXodrRoads(xodrText);
  const byId = new Map(roads.map((r) => [r.id, r]));
  if (byId.size !== roads.length) throw new Error('xodr: duplicate road ids');
  const contacts = parseContacts(tree);
  const warnings: string[] = [];

  // 1. Samples, deck choice against the original surface, original disagreement.
  const works = new Map<string, RoadWork>();
  const originalModels = new Map<string, SurfaceModel>();
  const laneMasks = new Map<string, { primaryLane: boolean[]; drivableLane: boolean[] }>();
  /** Deck hint: drivable lanes follow the carriageway (a bogus laneHeight must not pick a kerb top); others keep their laneHeight. */
  const hintFor = (road: XodrRoad, samples: Omit<RoadSamples, 'mesh' | 'flag' | 'raised'>, model: SurfaceModel) => (i: number) => {
    const base = modelEval(road, model, samples.s[i]!, samples.t[i]!);
    return DRIVABLE_LANE_TYPES.has(samples.lanes[samples.lane[i]!]!.lane.type) ? base : base + Math.max(-0.5, Math.min(0.5, samples.hOrig[i]!));
  };
  const assess = (road: XodrRoad, samples: RoadSamples, dataError: string[]): RoadWork => {
    const { primaryLane, drivableLane } = laneMasks.get(road.id)!;
    const anyPrimary = primaryLane.some(Boolean);
    const primary = new Uint8Array(samples.s.length);
    const residuals: number[] = [];
    const carriageway: number[] = [];
    for (let i = 0; i < samples.s.length; i += 1) {
      const li = samples.lane[i]!;
      primary[i] = (anyPrimary ? primaryLane[li] : drivableLane[li]) ? 1 : 0;
      if (samples.frac[i] !== 0.5 || FLAGS[samples.flag[i]!] !== 'ok') continue;
      const dz = samples.zOrig[i]! + samples.hOrig[i]! - samples.mesh[i]!;
      if (drivableLane[li]) residuals.push(dz);
      // Carriageway-only disagreement decides whether E/phi need a refit (laneHeight is handled per lane).
      if (primary[i]) carriageway.push(dz);
    }
    const cw = stats(carriageway);
    const reason: string[] = [];
    if (cw.p95 > REFIT_PARAMS.keepP95M) reason.push(`carriageway p95 ${(cw.p95 * 100).toFixed(1)} cm`);
    if (cw.max > REFIT_PARAMS.keepMaxM) reason.push(`carriageway max ${(cw.max * 100).toFixed(1)} cm`);
    if (dataError.length) reason.push('data error');
    return { road, samples, junction: road.junction !== '-1', primary, dataError, before: stats(residuals), needsFit: carriageway.length > 0 && reason.length > 0, reason, hasCarriageway: anyPrimary };
  };
  let done = 0;
  for (const road of roads) {
    const base = sampleRoad(road);
    const dataError = detectDataErrors(road);
    const original: SurfaceModel = {
      kind: 'original',
      elevation: road.elevation.map((r) => [...r] as CubicRecord),
      superelevation: road.superelevation.map((r) => [...r] as CubicRecord),
      keepShape: true,
    };
    originalModels.set(road.id, original);
    const primaryLane = base.lanes.map((l) => PRIMARY_TYPES.has(l.lane.type));
    const drivableLane = base.lanes.map((l) => DRIVABLE_LANE_TYPES.has(l.lane.type));
    const anyPrimary = primaryLane.some(Boolean);
    laneMasks.set(road.id, { primaryLane, drivableLane });
    const decks = selectDecks(query, base, hintFor(road, base, original), anyPrimary ? primaryLane : drivableLane);
    works.set(road.id, assess(road, { ...base, ...decks }, dataError));
    done += 1;
    if (done % 1000 === 0) log(`sampled ${done}/${roads.length} roads`);
  }

  const pinnedLog = new Map<string, string[]>();
  // 2. Tiered continuous fit, twice: the second round re-selects decks
  //    against the first round's surface (settles closely stacked decks).
  let final = fitAll();
  for (const w of works.values()) {
    const { primaryLane, drivableLane } = laneMasks.get(w.road.id)!;
    const decks = selectDecks(query, w.samples, hintFor(w.road, w.samples, final.get(w.road.id)!), primaryLane.some(Boolean) ? primaryLane : drivableLane);
    works.set(w.road.id, assess(w.road, { ...w.samples, ...decks }, w.dataError));
  }
  log('round 2: decks re-selected against the round-1 surface');
  final = fitAll();

  function fitAll(): Map<string, SurfaceModel> {
  const final = new Map<string, SurfaceModel>();
  pinnedLog.clear();
  const tiers: ((w: RoadWork) => boolean)[] = [(w) => !w.junction, (w) => w.junction];

  for (let tier = 0; tier < tiers.length; tier += 1) {
    const inTier = [...works.values()].filter(tiers[tier]!);
    // Unchanged roads of this tier are final immediately; a junction road
    // becomes "changed" when a changed neighbour no longer meets it.
    for (const w of inTier) {
      if (w.needsFit) continue;
      if (tier === 1) {
        for (const c of contacts.get(w.road.id) ?? []) {
          const other = byId.get(c.other); const om = final.get(c.other);
          if (!other || !om || om.kind !== 'fitted') continue;
          const g = contactGeometry(w.road, other, c);
          const mine = modelState(originalModels.get(w.road.id)!, g.sSelf);
          const theirs = modelState(om, g.sOther);
          const z = theirs.e + g.tOff * theirs.g;
          if (Math.abs(mine.e - z) > REFIT_PARAMS.contactTolM || Math.abs(mine.de - (g.sigma * (theirs.de + g.tOff * theirs.dg)) / g.metric) > REFIT_PARAMS.contactSlopeTol || Math.abs(mine.g - g.sigma * theirs.g) > REFIT_PARAMS.contactSlopeTol) {
            w.needsFit = true;
            w.reason.push(`neighbour ${c.other} refit`);
          }
        }
      }
      if (!w.needsFit) final.set(w.road.id, originalModels.get(w.road.id)!);
    }
    const changing = inTier.filter((w) => w.needsFit);
    const changingIds = new Set(changing.map((w) => w.road.id));
    // Pass 1: final neighbours pin; same-tier changing neighbours are free.
    const pinsFor = (w: RoadWork, consensus: Map<string, { e: number; de: number; g: number; dg: number }>): EndPins => {
      const pins: EndPins = {};
      const notes: string[] = [];
      for (const c of contacts.get(w.road.id) ?? []) {
        const other = byId.get(c.other);
        if (!other) { warnings.push(`road ${w.road.id}: link to missing road ${c.other}`); continue; }
        const g = contactGeometry(w.road, other, c);
        if (Math.abs(g.along) > REFIT_PARAMS.contactAlongTolM || Math.abs(g.tOff) > REFIT_PARAMS.contactLateralMaxM) {
          warnings.push(`road ${w.road.id} ${c.end}: contact with road ${c.other} ${c.otherEnd} is ${g.along.toFixed(2)} m along / ${g.tOff.toFixed(2)} m across, not pinned`);
          continue;
        }
        let pin: { e: number; de: number; g: number; dg: number } | undefined;
        const om = final.get(c.other);
        if (om) {
          const st = modelState(om, g.sOther);
          const surface = om.kind === 'original' ? other.surfaceZ(g.sOther, g.tOff) : st.e + g.tOff * st.g;
          pin = { e: surface, de: (g.sigma * (st.de + g.tOff * st.dg)) / g.metric, g: g.sigma * st.g, dg: st.dg / g.metric };
          notes.push(`${c.end}→${c.other}:${c.otherEnd}`);
        } else if (changingIds.has(c.other)) {
          pin = consensus.get(`${w.road.id}:${c.end}`);
          if (pin) notes.push(`${c.end}↔${c.other}:${c.otherEnd}`);
        }
        if (!pin) continue;
        // Contact values are expressed for this road's end; the slope sign is
        // in this road's s direction.
        if (c.end === 'start') pins.start = pin; else pins.end = pin;
      }
      pinnedLog.set(w.road.id, notes);
      return pins;
    };
    const pass1 = new Map<string, SurfaceModel>();
    for (const w of changing) {
      const fit = fitRoad(w, pinsFor(w, new Map()), originalModels.get(w.road.id)!);
      pass1.set(w.road.id, splineModel(fit.spline, w.road.length));
    }
    // Consensus at contacts between two changing roads of this tier.
    const consensus = new Map<string, { e: number; de: number; g: number; dg: number }>();
    for (const w of changing) {
      for (const c of contacts.get(w.road.id) ?? []) {
        if (!changingIds.has(c.other) || final.has(c.other)) continue;
        const key = `${w.road.id}:${c.end}`;
        if (consensus.has(key)) continue;
        const other = byId.get(c.other)!;
        const g = contactGeometry(w.road, other, c);
        if (Math.abs(g.along) > REFIT_PARAMS.contactAlongTolM || Math.abs(g.tOff) > REFIT_PARAMS.contactLateralMaxM) continue;
        const a = modelState(pass1.get(c.other)!, g.sOther); // neighbour, its frame
        const b = modelState(pass1.get(w.road.id)!, g.sSelf); // this road, its frame
        const zA = a.e + g.tOff * a.g;
        // Node values in this road's frame (slopes per metre of this road).
        const node = {
          e: (zA + b.e) / 2,
          de: ((g.sigma * (a.de + g.tOff * a.dg)) / g.metric + b.de) / 2,
          g: (g.sigma * a.g + b.g) / 2,
          dg: (a.dg / g.metric + b.dg) / 2,
        };
        consensus.set(key, node);
        // The neighbour's pin at its own end, in its own frame.
        const otherG = g.sigma * node.g; const otherDg = node.dg * g.metric;
        consensus.set(`${c.other}:${c.otherEnd}`, {
          e: node.e - g.tOff * otherG,
          de: g.sigma * node.de * g.metric - g.tOff * otherDg,
          g: otherG,
          dg: otherDg,
        });
      }
    }
    // Pass 2: everything pinned.
    for (const w of changing) {
      const fit = fitRoad(w, pinsFor(w, consensus), originalModels.get(w.road.id)!);
      final.set(w.road.id, splineModel(fit.spline, w.road.length));
    }
    log(`tier ${tier === 0 ? 'roads' : 'junction connecting roads'}: ${changing.length}/${inTier.length} refit`);
  }
  return final;
  }

  // Re-select decks against the refit surface (settles close stacks) and fit laneHeight.
  const changes: RoadChange[] = [];
  const edits: TextEdit[] = [];
  const nl = newlineOf(xodrText);
  const roadNodes = new Map(childrenNamed(child(tree, 'OpenDRIVE'), 'road').map((r) => [r.attrs['id']!, r]));
  for (const w of works.values()) {
    const model = final.get(w.road.id)!;
    const { samples } = w;
    const masks = laneMasks.get(w.road.id)!;
    const reselect = selectDecks(query, samples, hintFor(w.road, samples, model), masks.primaryLane.some(Boolean) ? masks.primaryLane : masks.drivableLane);
    samples.mesh = reselect.mesh; samples.flag = reselect.flag; samples.raised = reselect.raised;
    const lanes = refitLaneHeights(w, model);
    let maxE = 0;
    if (model.kind === 'fitted') {
      for (let k = 0; k <= 200; k += 1) {
        const s = (w.road.length * k) / 200;
        maxE = Math.max(maxE, Math.abs(evalRecords(model.elevation, s).value - evalRecords(originalModels.get(w.road.id)!.elevation, s).value));
      }
    }
    const holeS: number[] = []; let holes = 0; let noDeck = 0;
    for (let i = 0; i < samples.s.length; i += 1) {
      const f = FLAGS[samples.flag[i]!];
      if (!DRIVABLE_LANE_TYPES.has(samples.lanes[samples.lane[i]!]!.lane.type) || samples.frac[i] !== 0.5) continue;
      if (f === 'hole') { holes += 1; holeS.push(samples.s[i]!); }
      if (f === 'no-deck') { noDeck += 1; holeS.push(samples.s[i]!); }
    }
    // Surface change at drivable lane centres (including laneHeight).
    let maxSurface = 0;
    const heightOf = new Map(lanes.map((l) => [`${l.section}:${l.laneId}`, l.after]));
    for (let i = 0; i < samples.s.length; i += 1) {
      const ref = samples.lanes[samples.lane[i]!]!;
      if (samples.frac[i] !== 0.5 || !DRIVABLE_LANE_TYPES.has(ref.lane.type)) continue;
      const after = heightOf.get(`${ref.section}:${ref.lane.id}`);
      const hNew = after ? laneHeightAt({ ...ref.lane, heights: after }, samples.ds[i]!, 0.5) : samples.hOrig[i]!;
      maxSurface = Math.max(maxSurface, Math.abs(modelEval(w.road, model, samples.s[i]!, samples.t[i]!) + hNew - samples.zOrig[i]! - samples.hOrig[i]!));
    }
    const shapeNonZero = w.road.shape.some((r) => r[2] !== 0 || r[3] !== 0 || r[4] !== 0 || r[5] !== 0);
    changes.push({
      road: w.road.id,
      junction: w.junction,
      profile: model.kind === 'fitted' ? 'refit' : 'kept',
      reasons: w.reason,
      dataErrors: w.dataError,
      maxElevationChangeM: maxE,
      maxSurfaceChangeM: maxSurface,
      knots: model.spline?.knots.length ?? 0,
      elevationRecords: model.elevation.length,
      superelevationMaxRad: Math.max(0, ...model.superelevation.map((r) => Math.abs(r[1]))),
      shapeZeroed: model.kind === 'fitted' && shapeNonZero,
      carriageway: model.kind === 'fitted' ? (w.carriageway ?? 'none') : 'not-fitted',
      pinned: pinnedLog.get(w.road.id) ?? [],
      lanes: lanes.filter((l) => l.action !== 'kept'),
      holes: { samples: holes, noDeck, sRanges: sRanges(holeS) },
      before: w.before,
    });
    // Text edits.
    const node = roadNodes.get(w.road.id)!;
    if (model.kind === 'fitted') edits.push(...profileEdits(xodrText, node, model, nl));
    for (const l of lanes) {
      if (l.action !== 'refit' && l.action !== 'removed') continue;
      edits.push(...heightEdits(xodrText, node, l, nl));
    }
  }
  return { correctedText: applyEdits(xodrText, edits), roads: changes, warnings, fingerprint: REFIT_FINGERPRINT };
}

// ---------------------------------------------------------------------------
// Text edits
// ---------------------------------------------------------------------------

function childIndent(text: string, parent: XmlElement, fallbackStep = '    '): string {
  const first = parent.children[0];
  if (first) return indentAt(text, first.start);
  return indentAt(text, parent.start) + fallbackStep;
}

function recordLine(name: string, r: CubicRecord): string {
  return `<${name} s="${formatNumber(r[0])}" a="${formatNumber(r[1])}" b="${formatNumber(r[2])}" c="${formatNumber(r[3])}" d="${formatNumber(r[4])}"/>`;
}

function profileEdits(text: string, road: XmlElement, model: SurfaceModel, nl: string): TextEdit[] {
  const edits: TextEdit[] = [];
  const elevation = child(road, 'elevationProfile');
  const lateral = child(road, 'lateralProfile');
  const planView = child(road, 'planView');
  if (!planView) throw new Error(`xodr: road ${road.attrs['id']} has no planView`);
  const roadIndent = indentAt(text, (elevation ?? planView).start);
  const inner = elevation && elevation.children.length ? indentAt(text, elevation.children[0]!.start) : roadIndent + '    ';
  const elevText = [`<elevationProfile>`, ...model.elevation.map((r) => `${inner}${recordLine('elevation', r)}`), `${roadIndent}</elevationProfile>`].join(nl);
  // Lateral profile: superelevation records, then shape. The fit replaces the
  // whole lateral shape; an all-zero shape (RoadRunner writes one per road) is
  // kept verbatim, a non-zero one becomes a single zero record.
  const latInner = lateral && lateral.children.length ? indentAt(text, lateral.children[0]!.start) : inner;
  const lines = model.superelevation.map((r) => `${latInner}${recordLine('superelevation', r)}`);
  const shapes = childrenNamed(lateral, 'shape');
  const shapeZero = shapes.every((s) => ['a', 'b', 'c', 'd'].every((k) => Number(s.attrs[k] ?? '0') === 0));
  if (childrenNamed(lateral, 'crossfall').length > 0) throw new Error(`xodr: road ${road.attrs['id']} uses <crossfall>, which the refit does not model`);
  if (shapes.length > 0) {
    if (shapeZero) for (const s of shapes) lines.push(`${latInner}${text.slice(s.start, s.end)}`);
    else lines.push(`${latInner}<shape s="${formatNumber(0)}" t="${shapes[0]!.attrs['t'] ?? formatNumber(0)}" a="${formatNumber(0)}" b="${formatNumber(0)}" c="${formatNumber(0)}" d="${formatNumber(0)}"/>`);
  }
  const latText = [`<lateralProfile>`, ...lines, `${roadIndent}</lateralProfile>`].join(nl);
  // Schema order: planView, elevationProfile, lateralProfile, lanes.
  if (lateral) {
    if (elevation) edits.push({ start: elevation.start, end: elevation.end, text: elevText });
    else edits.push({ start: planView.end, end: planView.end, text: `${nl}${roadIndent}${elevText}` });
    edits.push({ start: lateral.start, end: lateral.end, text: latText });
  } else if (elevation) {
    edits.push({ start: elevation.start, end: elevation.end, text: `${elevText}${nl}${roadIndent}${latText}` });
  } else {
    edits.push({ start: planView.end, end: planView.end, text: `${nl}${roadIndent}${elevText}${nl}${roadIndent}${latText}` });
  }
  return edits;
}

const LANE_CHILDREN_BEFORE_HEIGHT = new Set(['link', 'width', 'border', 'roadMark', 'material', 'visibility', 'speed', 'access']);

function heightEdits(text: string, road: XmlElement, result: LaneHeightResult, nl: string): TextEdit[] {
  const sections = childrenNamed(child(road, 'lanes'), 'laneSection');
  const section = sections[result.section];
  if (!section) throw new Error(`xodr: road ${road.attrs['id']} has no laneSection #${result.section}`);
  const side = result.laneId > 0 ? 'left' : 'right';
  const lane = childrenNamed(child(section, side), 'lane').find((l) => Number(l.attrs['id']) === result.laneId);
  if (!lane) throw new Error(`xodr: road ${road.attrs['id']} section #${result.section} has no lane ${result.laneId}`);
  const existing = childrenNamed(lane, 'height');
  const indent = childIndent(text, lane);
  const lines = result.after.map((h) => `${indent}<height sOffset="${formatNumber(h[0])}" inner="${formatNumber(h[1])}" outer="${formatNumber(h[2])}"/>`);
  if (existing.length > 0) {
    const first = lineRange(text, existing[0]!.start, existing[0]!.end);
    const last = lineRange(text, existing[existing.length - 1]!.start, existing[existing.length - 1]!.end);
    // Heights are contiguous siblings in every export we read; refuse otherwise.
    const between = text.slice(first.start, last.end);
    if (scanXml(between).children.some((c) => c.name !== 'height')) throw new Error(`xodr: road ${road.attrs['id']} lane ${result.laneId}: <height> elements are not contiguous`);
    return [{ start: first.start, end: last.end, text: lines.map((l) => `${l}${nl}`).join('') }];
  }
  if (lines.length === 0) return [];
  // Insert after the last child that the schema orders before <height>.
  let anchor: XmlElement | undefined;
  for (const c of lane.children) if (LANE_CHILDREN_BEFORE_HEIGHT.has(c.name)) anchor = c;
  if (anchor) {
    const r = lineRange(text, anchor.start, anchor.end);
    return [{ start: r.end, end: r.end, text: lines.map((l) => `${l}${nl}`).join('') }];
  }
  const firstChild = lane.children[0];
  if (firstChild) {
    const r = lineRange(text, firstChild.start, firstChild.end);
    return [{ start: r.start, end: r.start, text: lines.map((l) => `${l}${nl}`).join('') }];
  }
  throw new Error(`xodr: road ${road.attrs['id']} lane ${result.laneId} is empty; cannot place <height>`);
}
