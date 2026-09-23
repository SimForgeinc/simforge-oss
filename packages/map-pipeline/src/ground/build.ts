import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from '../closure.js';
import {
  encodeGroundMesh,
  GROUND_MANIFEST_FILE,
  GROUND_MESH_FILE,
  GROUND_REPORT_FILE,
  GROUND_SCHEMA,
  SURFACE_CLASS_NAMES,
  SURFACE_CLASSES,
  type SurfaceClassName,
} from './format.js';
import { DECAL_ON_SURFACE_M, extractGroundSurface, MIN_UP_NORMAL_Z, type ExtractedSurface } from './extract.js';
import { GroundQuery, SEAM_TOLERANCE_M } from './query.js';
import { DRIVABLE_LANE_TYPES, parseXodrRoads, sampleLaneCentres, type LaneSurfaceSample } from './xodr-surface.js';

/**
 * The ground derivative: `derived/ground/{ground-mesh.bin, ground-manifest.json, ground-report.json}`.
 *
 * One authoritative ground-contact surface for the simulation, the render
 * timeline and every renderer, derived from the rendered road/ground mesh so
 * wheels touch what cameras see, and validated against OpenDRIVE at ingest
 * (docs/engineering/ground-height.md).
 *
 * Bump {@link GROUND_REVISION} whenever identical inputs would produce
 * different bytes; it is part of {@link GROUND_FINGERPRINT}, which the
 * master stage folds into its key, so a bump rebuilds every map.
 */
export const GROUND_REVISION = 1;

/** Validation thresholds (part of the fingerprint). */
export const GROUND_GATES = {
  /** Mesh vs OpenDRIVE lane-centre |dz| above this is a disagreement. */
  agreementToleranceM: 0.05,
  /** Share of `driving`-lane samples that must have a mesh surface under them. */
  minDrivingCoverage: 0.97,
  /** Per-road p95 |dz| above this flags the road (and the map) `xodr-disagrees`. */
  roadFlagP95M: 0.05,
  /** Lane samples every this many metres of road s. */
  sampleStepM: 0.5,
  /**
   * Beyond each driving-lane edge the rendered surface must continue this
   * far: overhanging wheels of long and wide vehicles (a truck's U-turn
   * sweep) stand there. Uncovered points are reported as holes and flag the
   * map; a body whose wheels reach one fails in the engine.
   */
  laneBufferM: 2.5,
  /** Holes are clustered on this grid for the report. */
  holeClusterM: 5,
} as const;

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export const GROUND_FINGERPRINT = sha256(canonicalJson({
  schema: GROUND_SCHEMA,
  revision: GROUND_REVISION,
  minUpNormalZ: MIN_UP_NORMAL_Z,
  decalOnSurfaceM: DECAL_ON_SURFACE_M,
  seamToleranceM: SEAM_TOLERANCE_M,
  classes: SURFACE_CLASSES,
  gates: GROUND_GATES,
}));

export type GroundStatus = 'ok' | 'flagged' | 'no-xodr';
/** Why a map is flagged: OpenDRIVE elevation disagrees with the rendered road, or the rendered surface has holes where vehicles reach. */
export type GroundFlag = 'xodr-disagrees' | 'surface-holes';

export interface GroundRoadDisagreement {
  road: string;
  junction: boolean;
  samples: number;
  p95AbsM: number;
  maxAbsM: number;
  meanM: number;
  /** Share of this road's samples beyond the agreement tolerance. */
  overToleranceShare: number;
  worst: { s: number; lane: number; x: number; y: number; xodrZ: number; meshZ: number; dzM: number };
}

export interface GroundValidation {
  xodrSha256: string;
  laneSamples: number;
  drivableSamples: number;
  /** Share of drivable-lane samples with a mesh surface under them. */
  drivableCoverage: number;
  drivingCoverage: number;
  /** |xodr - mesh| over drivable samples with a surface (mesh deck nearest the XODR z). */
  dzAbsM: { p50: number; p95: number; p99: number; max: number };
  overToleranceShare: number;
  /** Roads whose p95 |dz| exceeds the flag threshold, worst first. */
  flaggedRoads: GroundRoadDisagreement[];
  /** Driving-lane samples with no surface (first 200), and their count. */
  holes: { count: number; first: { road: string; lane: number; s: number; x: number; y: number }[] };
  /**
   * Points within {@link GROUND_GATES.laneBufferM} beyond a driving lane's
   * edges with no rendered surface, clustered: where an overhanging wheel
   * would stand over nothing. Largest clusters first.
   */
  bufferHoles: { points: number; clusters: { x: number; y: number; points: number; roads: string[] }[] };
}

export interface GroundReport {
  schema: 'simforge.map-ground-report.v1';
  mapId: string;
  status: GroundStatus;
  flags: GroundFlag[];
  warnings: string[];
  mesh: {
    vertices: number;
    triangles: number;
    classTriangles: Record<SurfaceClassName, number>;
    droppedNotUpward: number;
    droppedDegenerate: number;
    droppedRedundantDecals: number;
    meshNodes: number;
    boundsM: [number, number, number, number, number, number];
  };
  validation: GroundValidation | null;
}

export interface GroundManifest {
  schema: typeof GROUND_SCHEMA;
  buildKey: string;
  builder: { name: 'simforge-map-ground'; revision: number; fingerprint: string };
  mapId: string;
  source: {
    master: { path: string; sha256: string };
    buffers: { path: string; sha256: string }[];
    xodr: { path: string; sha256: string } | null;
  };
  status: GroundStatus;
  flags: GroundFlag[];
  /** One line per problem the map descriptor must show. */
  warnings: string[];
  mesh: { path: string; sha256: string; bytes: number; vertices: number; triangles: number };
  report: { path: string; sha256: string };
  conventions: Record<string, string>;
}

export class GroundBuildError extends Error {
  constructor(message: string, readonly report: GroundReport) {
    super(message);
    this.name = 'GroundBuildError';
  }
}

export interface BuildGroundDerivativeOptions {
  /** Directory holding `master.gltf` and its buffers. */
  masterDir: string;
  /** The map's OpenDRIVE; without one the surface is built but not validated (`no-xodr`). */
  xodrPath?: string;
  mapId: string;
  /** Output directory (conventionally `<master>/derived/ground`). */
  outputDir: string;
}

export interface GroundBuildResult {
  manifest: GroundManifest;
  report: GroundReport;
  meshBytes: Uint8Array;
}

function quantile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]!;
}

const round = (v: number, digits = 4) => Number(v.toFixed(digits));

export function validateGround(query: GroundQuery, samples: readonly LaneSurfaceSample[], xodrSha256: string): GroundValidation {
  const drivable = samples.filter((sample) => DRIVABLE_LANE_TYPES.has(sample.laneType));
  const perRoad = new Map<string, { junction: boolean; dz: number[]; worst: GroundRoadDisagreement['worst'] | null }>();
  const abs: number[] = [];
  let covered = 0; let driving = 0; let drivingCovered = 0;
  const holes: GroundValidation['holes']['first'] = [];
  let holeCount = 0;
  for (const sample of drivable) {
    const hit = query.nearest(sample.x, sample.y, sample.z);
    const isDriving = sample.laneType === 'driving';
    if (isDriving) driving += 1;
    if (!hit) {
      if (isDriving) {
        holeCount += 1;
        if (holes.length < 200) holes.push({ road: sample.road, lane: sample.lane, s: round(sample.s, 2), x: round(sample.x, 2), y: round(sample.y, 2) });
      }
      continue;
    }
    covered += 1;
    if (isDriving) drivingCovered += 1;
    const dz = sample.z - hit.z;
    abs.push(Math.abs(dz));
    let road = perRoad.get(sample.road);
    if (!road) { road = { junction: sample.junction, dz: [], worst: null }; perRoad.set(sample.road, road); }
    road.dz.push(dz);
    if (!road.worst || Math.abs(dz) > Math.abs(road.worst.dzM)) {
      road.worst = { s: round(sample.s, 2), lane: sample.lane, x: round(sample.x, 6), y: round(sample.y, 6), xodrZ: round(sample.z), meshZ: round(hit.z), dzM: round(dz) };
    }
  }
  // The overhang buffer beyond each driving-lane edge.
  const bufferClusters = new Map<string, { x: number; y: number; points: number; roads: Set<string> }>();
  let bufferPoints = 0;
  for (const sample of drivable) {
    if (sample.laneType !== 'driving') continue;
    for (const side of [1, -1]) {
      for (const beyond of [GROUND_GATES.laneBufferM / 2, GROUND_GATES.laneBufferM]) {
        const offset = side * (sample.halfWidth + beyond);
        const x = sample.x + sample.leftX * offset;
        const y = sample.y + sample.leftY * offset;
        if (query.surfacesAt(x, y).length > 0) continue;
        bufferPoints += 1;
        const cell = GROUND_GATES.holeClusterM;
        const key = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
        const cluster = bufferClusters.get(key) ?? { x: 0, y: 0, points: 0, roads: new Set<string>() };
        cluster.x += x; cluster.y += y; cluster.points += 1; cluster.roads.add(sample.road);
        bufferClusters.set(key, cluster);
      }
    }
  }
  const sortedAbs = Float64Array.from(abs).sort();
  const flaggedRoads: GroundRoadDisagreement[] = [];
  for (const [road, stats] of perRoad) {
    const roadAbs = Float64Array.from(stats.dz.map(Math.abs)).sort();
    const p95 = quantile(roadAbs, 0.95);
    if (p95 <= GROUND_GATES.roadFlagP95M) continue;
    flaggedRoads.push({
      road,
      junction: stats.junction,
      samples: stats.dz.length,
      p95AbsM: round(p95),
      maxAbsM: round(roadAbs[roadAbs.length - 1]!),
      meanM: round(stats.dz.reduce((sum, v) => sum + v, 0) / stats.dz.length),
      overToleranceShare: round(stats.dz.filter((v) => Math.abs(v) > GROUND_GATES.agreementToleranceM).length / stats.dz.length, 3),
      worst: stats.worst!,
    });
  }
  flaggedRoads.sort((a, b) => b.maxAbsM - a.maxAbsM || a.road.localeCompare(b.road));
  return {
    xodrSha256,
    laneSamples: samples.length,
    drivableSamples: drivable.length,
    drivableCoverage: round(drivable.length ? covered / drivable.length : 1),
    drivingCoverage: round(driving ? drivingCovered / driving : 1),
    dzAbsM: { p50: round(quantile(sortedAbs, 0.5)), p95: round(quantile(sortedAbs, 0.95)), p99: round(quantile(sortedAbs, 0.99)), max: round(sortedAbs[sortedAbs.length - 1] ?? 0) },
    overToleranceShare: round(abs.filter((v) => v > GROUND_GATES.agreementToleranceM).length / Math.max(1, abs.length), 4),
    flaggedRoads,
    holes: { count: holeCount, first: holes },
    bufferHoles: {
      points: bufferPoints,
      clusters: [...bufferClusters.values()]
        .map((c) => ({ x: round(c.x / c.points, 2), y: round(c.y / c.points, 2), points: c.points, roads: [...c.roads].sort((a, b) => a.localeCompare(b)) }))
        .sort((a, b) => b.points - a.points || a.x - b.x || a.y - b.y)
        .slice(0, 500),
    },
  };
}

function bounds(surface: ExtractedSurface): GroundReport['mesh']['boundsM'] {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const v = surface.vertices;
  for (let i = 0; i < v.length; i += 3) {
    for (let k = 0; k < 3; k += 1) { b[k] = Math.min(b[k]!, v[i + k]!); b[k + 3] = Math.max(b[k + 3]!, v[i + k]!); }
  }
  return b.map((value) => value / 1000) as GroundReport['mesh']['boundsM'];
}

/**
 * Build, validate and write `derived/ground/*`. Throws {@link GroundBuildError}
 * (after writing only `failed-ground-report.json`) when drivable lanes are not
 * covered by the rendered mesh: a map whose road surface has holes cannot
 * ground its bodies. OpenDRIVE disagreement does not fail the build (the mesh
 * is authoritative); it sets `status: 'xodr-disagrees'` and a warning the map
 * descriptor surfaces.
 */
async function groundSource(options: Pick<BuildGroundDerivativeOptions, 'masterDir' | 'xodrPath' | 'mapId'>): Promise<{ source: GroundManifest['source']; buildKey: string; xodrText: Buffer | null }> {
  const masterBytes = await readFile(path.join(options.masterDir, 'master.gltf'));
  const gltf = JSON.parse(masterBytes.toString('utf8')) as { buffers: { uri?: string }[] };
  const buffers = await Promise.all(gltf.buffers.map(async (buffer) => {
    const file = decodeURIComponent(buffer.uri ?? '');
    return { path: file, sha256: sha256(await readFile(path.join(options.masterDir, file))) };
  }));
  const xodrText = options.xodrPath ? await readFile(options.xodrPath) : null;
  const source: GroundManifest['source'] = {
    master: { path: 'master.gltf', sha256: sha256(masterBytes) },
    buffers,
    xodr: xodrText ? { path: path.basename(options.xodrPath!), sha256: sha256(xodrText) } : null,
  };
  return { source, buildKey: sha256(canonicalJson({ schema: GROUND_SCHEMA, mapId: options.mapId, source, fingerprint: GROUND_FINGERPRINT })), xodrText };
}

/** Whether `outputDir` holds the derivative the current builder would write for these sources. */
export async function inspectGroundDerivative(options: BuildGroundDerivativeOptions): Promise<{ state: 'current' | 'stale' | 'missing'; expectedKey: string; manifest: GroundManifest | null }> {
  const { buildKey } = await groundSource(options);
  let manifest: GroundManifest | null = null;
  try {
    manifest = JSON.parse(await readFile(path.join(options.outputDir, GROUND_MANIFEST_FILE), 'utf8')) as GroundManifest;
  } catch {
    return { state: 'missing', expectedKey: buildKey, manifest: null };
  }
  if (manifest.buildKey !== buildKey) return { state: 'stale', expectedKey: buildKey, manifest };
  const mesh = await readFile(path.join(options.outputDir, manifest.mesh.path)).catch(() => null);
  return { state: mesh && sha256(mesh) === manifest.mesh.sha256 ? 'current' : 'stale', expectedKey: buildKey, manifest };
}

export async function buildGroundDerivative(options: BuildGroundDerivativeOptions): Promise<GroundBuildResult> {
  const { source, buildKey, xodrText } = await groundSource(options);

  const surface = await extractGroundSurface(options.masterDir);
  const meshBytes = encodeGroundMesh(surface);
  const warnings: string[] = [];
  let validation: GroundValidation | null = null;
  if (xodrText) {
    const roads = parseXodrRoads(xodrText.toString('utf8'));
    const samples = sampleLaneCentres(roads, GROUND_GATES.sampleStepM);
    validation = validateGround(new GroundQuery(surface), samples, source.xodr!.sha256);
    if (validation.flaggedRoads.length > 0) {
      const worst = validation.flaggedRoads.slice(0, 8).map((road) => `${road.road} (${road.worst.dzM > 0 ? '+' : ''}${Math.round(road.worst.dzM * 100)} cm)`).join(', ');
      warnings.push(`OpenDRIVE elevation disagrees with the rendered road mesh on ${validation.flaggedRoads.length} road(s) (p95 |dz| ${Math.round(validation.dzAbsM.p95 * 100)} cm, max ${Math.round(validation.dzAbsM.max * 100)} cm; worst: ${worst}). Bodies follow the rendered mesh; OpenDRIVE-derived grades are unreliable until the map is re-exported.`);
    }
    if (validation.bufferHoles.clusters.length > 0) {
      const where = validation.bufferHoles.clusters.slice(0, 6).map((c) => `(${c.x}, ${c.y}) near road ${c.roads.join('/')}`).join(', ');
      warnings.push(`The rendered surface has ${validation.bufferHoles.clusters.length} hole(s) within ${GROUND_GATES.laneBufferM} m of driving lanes, where overhanging wheels stand (${where}). A vehicle whose wheels reach one fails simulation.`);
    }
  } else {
    warnings.push('No OpenDRIVE: the ground surface is unvalidated.');
  }
  const flags: GroundFlag[] = [];
  if (validation && validation.flaggedRoads.length > 0) flags.push('xodr-disagrees');
  if (validation && validation.bufferHoles.clusters.length > 0) flags.push('surface-holes');
  const status: GroundStatus = !validation ? 'no-xodr' : flags.length > 0 ? 'flagged' : 'ok';
  const report: GroundReport = {
    schema: 'simforge.map-ground-report.v1',
    mapId: options.mapId,
    status,
    flags,
    warnings,
    mesh: {
      vertices: surface.vertices.length / 3,
      triangles: surface.triangles.length / 3,
      classTriangles: Object.fromEntries(SURFACE_CLASS_NAMES.map((name) => [name, surface.classTriangles[name]])) as Record<SurfaceClassName, number>,
      droppedNotUpward: surface.droppedNotUpward,
      droppedDegenerate: surface.droppedDegenerate,
      droppedRedundantDecals: surface.droppedRedundantDecals,
      meshNodes: surface.meshNodes,
      boundsM: bounds(surface),
    },
    validation,
  };
  const reportText = `${canonicalJson(report)}\n`;
  await mkdir(options.outputDir, { recursive: true });
  if (validation && validation.drivingCoverage < GROUND_GATES.minDrivingCoverage) {
    await writeFile(path.join(options.outputDir, `failed-${GROUND_REPORT_FILE}`), reportText);
    throw new GroundBuildError(
      `ground: only ${(validation.drivingCoverage * 100).toFixed(2)}% of driving-lane samples have a rendered road surface (gate ${GROUND_GATES.minDrivingCoverage * 100}%); ${validation.holes.count} holes, first at road ${validation.holes.first[0]?.road} (${validation.holes.first[0]?.x}, ${validation.holes.first[0]?.y})`,
      report,
    );
  }
  const manifest: GroundManifest = {
    schema: GROUND_SCHEMA,
    buildKey,
    builder: { name: 'simforge-map-ground', revision: GROUND_REVISION, fingerprint: GROUND_FINGERPRINT },
    mapId: options.mapId,
    source,
    status,
    flags,
    warnings,
    mesh: { path: GROUND_MESH_FILE, sha256: sha256(meshBytes), bytes: meshBytes.length, vertices: report.mesh.vertices, triangles: report.mesh.triangles },
    report: { path: GROUND_REPORT_FILE, sha256: sha256(reportText) },
    conventions: {
      frame: 'xodr-local: x east, y north, z up, metres; vertices are integer millimetres',
      surface: 'upward-facing triangles of the rendered Roads_*/Terrain_*/Prop_Marking layers of master.gltf',
      contact: 'a body stands on the highest surface at most stepUp above its previous contact (simforge-core map::ground::GroundSurface::contact); a miss is an error',
      seamToleranceM: String(SEAM_TOLERANCE_M),
    },
  };
  // Write atomically: a reader never sees a manifest without its members.
  const staging = `${options.outputDir}.tmp-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(staging, GROUND_MESH_FILE), meshBytes);
  await writeFile(path.join(staging, GROUND_REPORT_FILE), reportText);
  await writeFile(path.join(staging, GROUND_MANIFEST_FILE), `${canonicalJson(manifest)}\n`);
  await rm(options.outputDir, { recursive: true, force: true });
  await rename(staging, options.outputDir);
  return { manifest, report, meshBytes };
}
