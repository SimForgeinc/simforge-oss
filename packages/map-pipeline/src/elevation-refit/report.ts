import { createHash } from 'node:crypto';

import type { GroundQuery } from '../ground/query.js';
import { surveySurface, type SurfaceSurvey } from './evaluate.js';
import { REFIT_FINGERPRINT, REFIT_PARAMS, REFIT_REVISION, refitXodrElevation, type RoadChange } from './refit.js';
import { verifyContinuity, type ContinuityReport } from './verify.js';
import { structuralDiff } from './xodr-text.js';

/**
 * Acceptance gates for a corrected XODR. A map that misses one is a failed
 * refit (the CLI exits non-zero and nothing is published); there is no
 * partial or best-effort output.
 */
export const REFIT_GATES = {
  /** Drivable lane-centre |dz| p95 against the mesh, after (mesh holes excluded). */
  drivableP95M: 0.03,
  /** Surface C0 at every road-to-road contact. */
  contactDzM: 0.001,
  /** Surface slope difference at every contact (over CONTACT_SLOPE_SPAN_M). */
  contactSlope: 0.01,
  /** Elevation record boundaries: C0 step and C1 kink. */
  recordStepM: 1e-4,
  recordKink: 1e-4,
} as const;

export interface SurveySummary {
  xodrSha256: string;
  drivable: SurfaceSurvey['drivable'];
  driving: SurfaceSurvey['driving'];
  coverage: { drivable: number; driving: number; holes: number };
  flaggedRoads: number;
}

export interface MapRefitReport {
  schema: 'simforge.xodr-elevation-refit.v1';
  mapId: string;
  tool: { revision: number; fingerprint: string; gitSha: string | null; params: typeof REFIT_PARAMS };
  source: { xodrSha256: string; bytes: number };
  corrected: { xodrSha256: string; bytes: number };
  groundMesh: { sha256: string; source: string };
  before: SurveySummary;
  after: SurveySummary;
  continuity: { before: ContinuityReport; after: ContinuityReport };
  structuralDiff: { forbidden: number; bytesOutsideAllowedIdentical: boolean; changedElements: { elevationProfile: number; lateralProfile: number; laneHeight: number } };
  totals: {
    roads: number;
    roadsRefit: number;
    junctionRoadsRefit: number;
    lanesHeightRefit: number;
    lanesHeightRemoved: number;
    maxElevationChangeM: number;
    maxSurfaceChangeM: number;
    dataErrorRoads: string[];
    holeRoads: { road: string; samples: number; noDeck: number; sRanges: [number, number][] }[];
    shapeZeroedRoads: string[];
  };
  gates: { name: string; ok: boolean; value: number | boolean; limit: number | boolean }[];
  ok: boolean;
  warnings: string[];
  roads: (RoadChange & { after: { p95: number; max: number; samples: number } | null })[];
}

function summary(s: SurfaceSurvey): SurveySummary {
  return {
    xodrSha256: s.xodrSha256,
    drivable: s.drivable,
    driving: s.driving,
    coverage: { drivable: s.validation.drivableCoverage, driving: s.validation.drivingCoverage, holes: s.validation.holes.count },
    flaggedRoads: s.validation.flaggedRoads.length,
  };
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

export interface RunRefitResult {
  report: MapRefitReport;
  correctedText: string;
  before: SurfaceSurvey;
  after: SurfaceSurvey;
}

/** Refit, survey before/after with the ground derivative's validator, verify, gate. */
export function runRefit(options: { mapId: string; xodrText: string; query: GroundQuery; groundMesh: { sha256: string; source: string }; gitSha?: string | null; log?: (line: string) => void }): RunRefitResult {
  const { xodrText, query } = options;
  const result = refitXodrElevation(xodrText, query, { log: options.log });
  const corrected = result.correctedText;
  const before = surveySurface(xodrText, query);
  const after = surveySurface(corrected, query);
  const changed = new Set(result.roads.filter((r) => r.profile === 'refit').map((r) => r.road));
  const continuity = { before: verifyContinuity(xodrText, { onlyRoads: changed }), after: verifyContinuity(corrected, { onlyRoads: changed }) };
  const diff = structuralDiff(xodrText, corrected);
  const roads = result.roads
    .filter((r) => r.profile === 'refit' || r.lanes.some((l) => l.action === 'refit' || l.action === 'removed') || r.holes.samples + r.holes.noDeck > 0)
    .map((r) => {
      const a = after.roads.get(r.road);
      return { ...r, after: a ? { p95: a.p95, max: a.max, samples: a.samples } : null };
    })
    .sort((x, y) => y.maxSurfaceChangeM - x.maxSurfaceChangeM || Number(x.road) - Number(y.road));
  const gates: MapRefitReport['gates'] = [
    { name: 'structural diff: only elevationProfile / lateralProfile / lane height changed', ok: diff.forbidden.length === 0, value: diff.forbidden.length, limit: 0 },
    { name: 'bytes outside those elements identical', ok: diff.bytesOutsideAllowedIdentical, value: diff.bytesOutsideAllowedIdentical, limit: true },
    { name: 'drivable lane-centre p95 |dz| vs mesh (m)', ok: after.drivable.p95 <= REFIT_GATES.drivableP95M, value: after.drivable.p95, limit: REFIT_GATES.drivableP95M },
    { name: 'contact C0 max |dz| (m)', ok: continuity.after.contactMaxDz <= REFIT_GATES.contactDzM, value: continuity.after.contactMaxDz, limit: REFIT_GATES.contactDzM },
    { name: 'contact C1 max |dslope|', ok: continuity.after.contactMaxDslope <= REFIT_GATES.contactSlope, value: continuity.after.contactMaxDslope, limit: REFIT_GATES.contactSlope },
    { name: 'elevation record C0 step (m)', ok: continuity.after.recordMaxStep <= REFIT_GATES.recordStepM, value: continuity.after.recordMaxStep, limit: REFIT_GATES.recordStepM },
    { name: 'elevation record C1 kink', ok: continuity.after.recordMaxKink <= REFIT_GATES.recordKink, value: continuity.after.recordMaxKink, limit: REFIT_GATES.recordKink },
  ];
  const all = result.roads;
  const report: MapRefitReport = {
    schema: 'simforge.xodr-elevation-refit.v1',
    mapId: options.mapId,
    tool: { revision: REFIT_REVISION, fingerprint: REFIT_FINGERPRINT, gitSha: options.gitSha ?? null, params: REFIT_PARAMS },
    source: { xodrSha256: sha(xodrText), bytes: Buffer.byteLength(xodrText) },
    corrected: { xodrSha256: sha(corrected), bytes: Buffer.byteLength(corrected) },
    groundMesh: options.groundMesh,
    before: summary(before),
    after: summary(after),
    continuity,
    structuralDiff: { forbidden: diff.forbidden.length, bytesOutsideAllowedIdentical: diff.bytesOutsideAllowedIdentical, changedElements: diff.allowedCounts },
    totals: {
      roads: all.length,
      roadsRefit: all.filter((r) => r.profile === 'refit').length,
      junctionRoadsRefit: all.filter((r) => r.profile === 'refit' && r.junction).length,
      lanesHeightRefit: all.reduce((n, r) => n + r.lanes.filter((l) => l.action === 'refit').length, 0),
      lanesHeightRemoved: all.reduce((n, r) => n + r.lanes.filter((l) => l.action === 'removed').length, 0),
      maxElevationChangeM: Math.max(0, ...all.map((r) => r.maxElevationChangeM)),
      maxSurfaceChangeM: Math.max(0, ...all.map((r) => r.maxSurfaceChangeM)),
      dataErrorRoads: all.filter((r) => r.dataErrors.length > 0).map((r) => r.road),
      holeRoads: all.filter((r) => r.holes.samples + r.holes.noDeck > 0).map((r) => ({ road: r.road, ...r.holes })),
      shapeZeroedRoads: all.filter((r) => r.shapeZeroed).map((r) => r.road),
    },
    gates,
    ok: gates.every((g) => g.ok),
    warnings: result.warnings,
    roads,
  };
  if (diff.forbidden.length > 0) report.warnings.push(`forbidden changes: ${diff.forbidden.slice(0, 5).map((d) => `${d.kind} ${d.path}`).join('; ')}`);
  return { report, correctedText: corrected, before, after };
}

const cm = (m: number, digits = 1) => `${(m * 100).toFixed(digits)} cm`;
const pct = (v: number) => `${(v * 100).toFixed(2)} %`;

/** Human-readable change log for the map's author (the RoadRunner export owner). */
export function changesMarkdown(r: MapRefitReport, meta: { title: string; sourceFile: string; correctedFile: string }): string {
  const L: string[] = [];
  const b = r.before; const a = r.after; const t = r.totals;
  L.push(`# ${meta.title}: OpenDRIVE elevation corrected to the rendered road mesh`);
  L.push('');
  L.push(`- Source: \`${meta.sourceFile}\` (sha256 \`${r.source.xodrSha256}\`)`);
  L.push(`- Corrected: \`${meta.correctedFile}\` (sha256 \`${r.corrected.xodrSha256}\`)`);
  L.push(`- Mesh: the upward-facing road/ground surface of the same export's GLB (SimForge ground derivative, sha256 \`${r.groundMesh.sha256}\`)`);
  L.push(`- Tool: SimForge \`maps:refit-elevation\` revision ${r.tool.revision}${r.tool.gitSha ? `, commit \`${r.tool.gitSha}\`` : ''}`);
  L.push('');
  L.push('Only `<elevationProfile>`, `<lateralProfile>` (superelevation) and lane `<height>` (laneHeight) changed.');
  L.push('Every other byte of the file (planView, lanes, links, junctions, signals, objects, ids, header) is identical to the source.');
  L.push(`A structural diff confirms it: ${r.structuralDiff.forbidden} changes outside those elements; bytes outside them identical: ${r.structuralDiff.bytesOutsideAllowedIdentical ? 'yes' : 'NO'}.`);
  L.push('');
  L.push('## Result');
  L.push('');
  L.push('Measured at every drivable lane centre (driving, shoulder, parking, biking, ...) every 0.5 m: the full OpenDRIVE surface (elevation, superelevation, shape, laneOffset, laneHeight) minus the rendered mesh directly under it.');
  L.push('');
  L.push('| | before | after |');
  L.push('|---|---|---|');
  L.push(`| drivable p50 | ${cm(b.drivable.p50)} | ${cm(a.drivable.p50)} |`);
  L.push(`| drivable p95 | ${cm(b.drivable.p95)} | ${cm(a.drivable.p95)} |`);
  L.push(`| drivable p99 | ${cm(b.drivable.p99)} | ${cm(a.drivable.p99)} |`);
  L.push(`| drivable max | ${cm(b.drivable.max)} | ${cm(a.drivable.max)} |`);
  L.push(`| samples over 3 cm | ${pct(b.drivable.over3cm)} | ${pct(a.drivable.over3cm)} |`);
  L.push(`| samples over 5 cm | ${pct(b.drivable.over5cm)} | ${pct(a.drivable.over5cm)} |`);
  L.push(`| driving lanes p95 / max | ${cm(b.driving.p95)} / ${cm(b.driving.max)} | ${cm(a.driving.p95)} / ${cm(a.driving.max)} |`);
  L.push(`| roads with p95 over 5 cm | ${b.flaggedRoads} | ${a.flaggedRoads} |`);
  L.push(`| mesh coverage of driving lanes | ${pct(b.coverage.driving)} | ${pct(a.coverage.driving)} |`);
  const cb = r.continuity.before; const ca = r.continuity.after;
  L.push(`| C0 at road contacts (max gap, refit roads) | ${(cb.contactMaxDz * 1000).toFixed(2)} mm | ${(ca.contactMaxDz * 1000).toFixed(2)} mm |`);
  L.push(`| C1 at road contacts (max slope difference) | ${(cb.contactMaxDslope * 100).toFixed(2)} % | ${(ca.contactMaxDslope * 100).toFixed(2)} % |`);
  L.push(`| C1 at elevation record joints (max kink) | ${(cb.recordMaxKink * 100).toFixed(3)} % | ${(ca.recordMaxKink * 100).toFixed(3)} % |`);
  L.push('');
  L.push('## What changed');
  L.push('');
  L.push(`- ${t.roadsRefit} of ${t.roads} roads got a new elevation and superelevation profile (${t.junctionRoadsRefit} of them junction connecting roads). Roads that already matched the mesh (p95 at most ${cm(REFIT_PARAMS.keepP95M)} and max at most ${cm(REFIT_PARAMS.keepMaxM)} on their driving lanes) are unchanged.`);
  L.push(`- laneHeight: ${t.lanesHeightRemoved} lane records removed (the mesh has no offset there, mostly the +15 cm shoulder/parking/bike lanes) and ${t.lanesHeightRefit} set to the offset the mesh has (kerbed sidewalks, gutters).`);
  L.push(`- Largest correction: ${cm(t.maxElevationChangeM)} of reference-line elevation, ${cm(t.maxSurfaceChangeM)} of lane surface.`);
  L.push('- Every junction connecting road now meets its incoming and outgoing roads with the same height, slope and cross-slope at the contact point (C0/C1): this removes the bumps and dips inside intersections.');
  L.push('- New elevation and superelevation records are C1-continuous cubics (value and slope match at every record joint).');
  if (t.dataErrorRoads.length) L.push(`- Data errors fixed (impossible grades, steps, or laneHeight over 1 m in the source): roads ${t.dataErrorRoads.join(', ')}. Details in the table (reason "data error").`);
  if (t.shapeZeroedRoads.length) L.push(`- Roads whose non-zero lateral \`<shape>\` was replaced (the fitted superelevation and laneHeight now carry the cross-section): ${t.shapeZeroedRoads.join(', ')}.`);
  L.push('- Stacked decks (bridges, overpasses): each road follows the deck continuous with its own profile, never the surface under or over it.');
  L.push('');
  L.push('## Mesh holes: original values kept');
  L.push('');
  if (t.holeRoads.length === 0) {
    L.push('None: every drivable lane sample has a rendered surface under it.');
  } else {
    L.push('Where the mesh has no surface under a lane (or no surface continuous with the road), the original OpenDRIVE surface is kept there.');
    L.push('');
    L.push('| road | samples without surface | samples without a continuous deck | s ranges (m) |');
    L.push('|---|---|---|---|');
    for (const h of t.holeRoads) L.push(`| ${h.road} | ${h.samples} | ${h.noDeck} | ${h.sRanges.map(([x, y]) => (x === y ? `${x}` : `${x}-${y}`)).join(', ')} |`);
  }
  L.push('');
  L.push('## Roads changed');
  L.push('');
  L.push('Sorted by the largest change of the lane surface. "before"/"after" are this road\'s drivable lane-centre |OpenDRIVE - mesh| p95 / max.');
  L.push('');
  L.push('| road | junction | elevation | max elevation change | max lane-surface change | before p95 / max | after p95 / max | laneHeight | reason |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const road of r.roads) {
    const lanes = road.lanes.filter((l) => l.action === 'refit' || l.action === 'removed');
    const laneText = lanes.length === 0 ? '' : lanes.map((l) => `${l.laneId}${l.action === 'removed' ? ' removed' : ` ${l.after.map((h) => `${(h[1] * 100).toFixed(0)}/${(h[2] * 100).toFixed(0)}`).join(' ')} cm`}`).join('; ');
    L.push(`| ${road.road} | ${road.junction ? 'yes' : 'no'} | ${road.profile} | ${cm(road.maxElevationChangeM)} | ${cm(road.maxSurfaceChangeM)} | ${cm(road.before.p95)} / ${cm(road.before.max)} | ${road.after ? `${cm(road.after.p95)} / ${cm(road.after.max)}` : 'n/a'} | ${laneText} | ${[...road.reasons, ...road.dataErrors].join('; ')} |`);
  }
  L.push('');
  return L.join('\n');
}
