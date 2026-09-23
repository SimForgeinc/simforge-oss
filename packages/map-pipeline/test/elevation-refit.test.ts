import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  changesMarkdown,
  formatNumber,
  REFIT_GATES,
  runRefit,
  structuralDiff,
  verifyContinuity,
  xodrGeometrySha256,
} from '../src/elevation-refit/index.js';
import { elevationRecords, evalComponent, fitSpline2, unknownIndex } from '../src/elevation-refit/spline.js';
import { decodeGroundMesh, GroundQuery, parseXodrRoads, SURFACE_CLASSES, type GroundMesh } from '../src/ground/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Synthetic map with known defects
// ---------------------------------------------------------------------------
//
//   road 1 (x 0..100)  --junction 9: connecting road 3 (x 100..120)-->  road 2 (x 120..220)
//
// The rendered mesh: z = 10 + 0.01 x everywhere on the carriageway, plus a 2 %
// cross-slope on road 2 (z += 0.02 y); a bridge deck: over x 20..60 the ground
// under road 1 is 6 m lower too (a second, lower surface). Kerb tops at +0.15
// beside road 2's sidewalk. A hole in the mesh over x 160..166.
//
// The OpenDRIVE (before) is wrong in the ways the RoadRunner exports are:
// - road 1 is offset +0.8 m along its whole length;
// - connecting road 3 has a 0.5 m bump in the middle of the junction;
// - road 2's shoulder carries laneHeight +0.15 the mesh does not have;
// - road 2's elevation ends in a data error (a 60 % ramp over its last 8 m).

const meshZ = (x: number, y: number) => 10 + 0.01 * x + (x >= 120 ? 0.02 * y : 0);

function grid(mesh: { v: number[]; t: number[]; c: number[] }, x0: number, x1: number, y0: number, y1: number, z: (x: number, y: number) => number, cls: number, step = 0.5) {
  const nx = Math.round((x1 - x0) / step); const ny = Math.max(1, Math.round((y1 - y0) / step));
  const base = mesh.v.length / 3;
  for (let j = 0; j <= ny; j += 1) for (let i = 0; i <= nx; i += 1) {
    const x = x0 + ((x1 - x0) * i) / nx; const y = y0 + ((y1 - y0) * j) / ny;
    mesh.v.push(Math.round(x * 1000), Math.round(y * 1000), Math.round(z(x, y) * 1000));
  }
  for (let j = 0; j < ny; j += 1) for (let i = 0; i < nx; i += 1) {
    const a = base + j * (nx + 1) + i; const b = a + 1; const c = a + nx + 1; const d = c + 1;
    mesh.t.push(a, b, d, a, d, c); mesh.c.push(cls, cls);
  }
}

function syntheticMesh(): GroundMesh {
  const m = { v: [] as number[], t: [] as number[], c: [] as number[] };
  grid(m, 0, 20, -6, 6, meshZ, SURFACE_CLASSES.road);
  grid(m, 20, 60, -6, 6, meshZ, SURFACE_CLASSES.bridge); // bridge deck
  grid(m, 20, 60, -6, 6, (x, y) => meshZ(x, y) - 6, SURFACE_CLASSES.road); // road under the bridge
  grid(m, 60, 160, -6, 6, meshZ, SURFACE_CLASSES.road);
  grid(m, 166, 220, -6, 6, meshZ, SURFACE_CLASSES.road); // hole over x 160..166
  grid(m, 120, 160, 6, 8, (x, y) => meshZ(x, y) + 0.15, SURFACE_CLASSES.sidewalk); // kerbed sidewalk
  grid(m, 166, 220, 6, 8, (x, y) => meshZ(x, y) + 0.15, SURFACE_CLASSES.sidewalk);
  return { vertices: Int32Array.from(m.v), triangles: Uint32Array.from(m.t), classes: Uint8Array.from(m.c) };
}

const lane = (id: number, type: string, width: number, height = '') => `
          <lane id="${id}" type="${type}" level="false">
            <width sOffset="0" a="${width}" b="0" c="0" d="0"/>
            <roadMark sOffset="0" type="none"/>
            <speed sOffset="0" max="25" unit="mph"/>${height}
            <userData><vectorLane sOffset="0" laneId="{x}"/></userData>
          </lane>`;

const SHOULDER_HEIGHT = '\n            <height sOffset="0" inner="0.15" outer="0.15"/>';

function syntheticXodr(): string {
  // Road 2: 10 + 0.01 x from x=120 -> a = 11.2, b = 0.01; last 8 m ramp +60 %.
  return `<?xml version="1.0" encoding="UTF-8"?>
<OpenDRIVE>
    <header revMajor="1" revMinor="4" name="synthetic" version="1" vendor="test"/>
    <road name="r1" length="100" id="1" junction="-1">
        <link>
            <successor elementType="junction" elementId="9"/>
        </link>
        <planView>
            <geometry s="0" x="0" y="0" hdg="0" length="100"><line/></geometry>
        </planView>
        <elevationProfile>
            <elevation s="0" a="10.8" b="0.01" c="0" d="0"/>
        </elevationProfile>
        <lateralProfile>
            <superelevation s="0" a="0" b="0" c="0" d="0"/>
            <shape s="0" t="-3.5" a="0" b="0" c="0" d="0"/>
        </lateralProfile>
        <lanes>
            <laneSection s="0">
                <left>${lane(1, 'driving', 3.5)}
                </left>
                <center><lane id="0" type="none" level="false"/></center>
                <right>${lane(-1, 'driving', 3.5)}
                </right>
            </laneSection>
        </lanes>
        <signals>
            <signal s="50" t="-5" id="77" name="stop" dynamic="no" orientation="+" zOffset="0" type="206" subtype="-1" value="-1" height="2" width="0.7"/>
        </signals>
    </road>
    <road name="r2" length="100" id="2" junction="-1">
        <link>
            <predecessor elementType="junction" elementId="9"/>
        </link>
        <planView>
            <geometry s="0" x="120" y="0" hdg="0" length="100"><line/></geometry>
        </planView>
        <elevationProfile>
            <elevation s="0" a="11.2" b="0.01" c="0" d="0"/>
            <elevation s="92" a="12.12" b="0.6" c="0" d="0"/>
        </elevationProfile>
        <lateralProfile>
            <superelevation s="0" a="0" b="0" c="0" d="0"/>
            <shape s="0" t="-3.5" a="0" b="0" c="0" d="0"/>
        </lateralProfile>
        <lanes>
            <laneSection s="0">
                <left>${lane(1, 'driving', 3.5)}${lane(2, 'shoulder', 2.0, SHOULDER_HEIGHT)}${lane(3, 'sidewalk', 1.5, SHOULDER_HEIGHT)}
                </left>
                <center><lane id="0" type="none" level="false"/></center>
                <right>${lane(-1, 'driving', 3.5)}
                </right>
            </laneSection>
        </lanes>
    </road>
    <road name="c3" length="20" id="3" junction="9">
        <link>
            <predecessor elementType="road" elementId="1" contactPoint="end"/>
            <successor elementType="road" elementId="2" contactPoint="start"/>
        </link>
        <planView>
            <geometry s="0" x="100" y="0" hdg="0" length="20"><line/></geometry>
        </planView>
        <elevationProfile>
            <elevation s="0" a="11.8" b="0.01" c="0" d="0"/>
            <elevation s="10" a="12.4" b="0.01" c="0" d="0"/>
        </elevationProfile>
        <lateralProfile>
            <superelevation s="0" a="0" b="0" c="0" d="0"/>
            <shape s="0" t="-3.5" a="0" b="0" c="0" d="0"/>
        </lateralProfile>
        <lanes>
            <laneSection s="0">
                <left>${lane(1, 'driving', 3.5)}
                </left>
                <center><lane id="0" type="none" level="false"/></center>
                <right>${lane(-1, 'driving', 3.5)}
                </right>
            </laneSection>
        </lanes>
    </road>
    <junction name="j" id="9">
        <connection id="0" incomingRoad="1" connectingRoad="3" contactPoint="start">
            <laneLink from="1" to="1"/>
            <laneLink from="-1" to="-1"/>
        </connection>
    </junction>
</OpenDRIVE>
`;
}

describe('xodr elevation refit: synthetic map with known offsets', () => {
  const mesh = syntheticMesh();
  const query = new GroundQuery(mesh);
  const source = syntheticXodr();
  const run = runRefit({ mapId: 'synthetic', xodrText: source, query, groundMesh: { sha256: 'synthetic', source: 'test' } });
  const corrected = run.correctedText;
  const roads = new Map(parseXodrRoads(corrected).map((r) => [r.id, r]));
  const change = (id: string) => run.report.roads.find((r) => r.road === id)!;

  it('passes every gate and matches the mesh outside the hole', () => {
    expect(run.report.gates.filter((g) => !g.ok)).toEqual([]);
    expect(run.report.before.drivable.p95).toBeGreaterThan(0.1);
    expect(run.report.after.drivable.p95).toBeLessThan(0.01);
    expect(run.report.after.flaggedRoads).toBe(0);
  });

  it('removes the whole-road offset of road 1 and keeps it on the bridge deck, not the road under it', () => {
    const r1 = roads.get('1')!;
    for (const s of [5, 30, 45, 55, 90]) expect(Math.abs(r1.surfaceZ(s, -1.75) - meshZ(s, -1.75))).toBeLessThan(0.01);
    expect(change('1').maxElevationChangeM).toBeGreaterThan(0.75);
  });

  it('removes the junction bump and meets both roads C0/C1 at the contact points', () => {
    const c3 = roads.get('3')!;
    for (const s of [0, 5, 10, 15, 20]) expect(Math.abs(c3.surfaceZ(s, -1.75) - meshZ(100 + s, -1.75))).toBeLessThan(0.01);
    const continuity = verifyContinuity(corrected);
    expect(continuity.contacts).toBe(2);
    expect(continuity.contactMaxDz).toBeLessThan(1e-6);
    expect(continuity.contactMaxDslope).toBeLessThan(REFIT_GATES.contactSlope);
    expect(continuity.contactMaxDcross).toBeLessThan(1e-6);
    expect(continuity.recordMaxKink).toBeLessThan(REFIT_GATES.recordKink);
    expect(continuity.recordMaxStep).toBeLessThan(REFIT_GATES.recordStepM);
  });

  it('fits the cross-slope of road 2 as superelevation', () => {
    const r2 = roads.get('2')!;
    expect(r2.superelevation.length).toBeGreaterThan(0);
    const phi = Math.atan(0.02);
    expect(Math.abs(r2.superelevation.find((x) => x[0] <= 20)![1] - phi)).toBeLessThan(0.002);
    expect(Math.abs(r2.surfaceZ(30, 1.75) - meshZ(150, 1.75))).toBeLessThan(0.01);
  });

  it('removes the shoulder laneHeight the mesh does not have and keeps the kerbed sidewalk', () => {
    const shoulder = roads.get('2')!.sections[0]!.left.find((l) => l.id === 2)!;
    // +15 cm gone; only the hole edge (where the original, flat cross-section is kept) may carry a residual.
    for (const h of shoulder.heights) expect(Math.max(Math.abs(h[1]), Math.abs(h[2]))).toBeLessThan(0.025);
    expect(shoulder.heights.filter((h) => h[1] !== 0 || h[2] !== 0).every((h) => h[0] > 35 && h[0] < 47)).toBe(true);
    const sidewalk = roads.get('2')!.sections[0]!.left.find((l) => l.id === 3)!;
    expect(sidewalk.heights.length).toBeGreaterThan(0);
    for (const h of sidewalk.heights.filter((r) => r[0] < 35 || r[0] > 47)) {
      expect(Math.abs((h[1] + h[2]) / 2 - 0.15)).toBeLessThan(0.02);
    }
  });

  it('fixes the data error at the end of road 2', () => {
    expect(change('2').dataErrors.join(' ')).toMatch(/grade 60 %/);
    const r2 = roads.get('2')!;
    expect(Math.abs(r2.surfaceZ(99, 0) - meshZ(219, 0))).toBeLessThan(0.02);
  });

  it('keeps the original surface over the mesh hole and lists it', () => {
    const hole = run.report.totals.holeRoads.find((h) => h.road === '2')!;
    expect(hole.samples).toBeGreaterThan(0);
    expect(hole.sRanges.some(([a, b]) => a >= 39 && b <= 47)).toBe(true);
    // The original (10 + 0.01 x) equals the mesh model there, so the fit continues it.
    const r2 = roads.get('2')!;
    expect(Math.abs(r2.surfaceZ(43, 0) - (11.2 + 0.01 * 43))).toBeLessThan(0.01);
  });

  it('changes nothing but elevationProfile, lateralProfile and lane height', () => {
    const diff = structuralDiff(source, corrected);
    expect(diff.forbidden).toEqual([]);
    expect(diff.bytesOutsideAllowedIdentical).toBe(true);
    expect(corrected).toContain('<signal s="50" t="-5" id="77"');
    expect(corrected.slice(0, corrected.indexOf('<road'))).toBe(source.slice(0, source.indexOf('<road')));
  });

  it('writes a CHANGES.md listing every changed road', () => {
    const md = changesMarkdown(run.report, { title: 'synthetic', sourceFile: 'in.xodr', correctedFile: 'out.xodr' });
    for (const id of ['1', '2', '3']) expect(md).toMatch(new RegExp(`\\| ${id} \\| (yes|no) \\| refit`));
    expect(md).toContain('## Mesh holes: original values kept');
  });

  it('is deterministic', () => {
    const again = runRefit({ mapId: 'synthetic', xodrText: source, query, groundMesh: { sha256: 'synthetic', source: 'test' } });
    expect(again.correctedText).toBe(corrected);
  });

  it('keeps the road-geometry digest (the refit changes no geometry)', () => {
    expect(xodrGeometrySha256(corrected)).toBe(xodrGeometrySha256(source));
    expect(xodrGeometrySha256(corrected.replace('hdg="0" length="20"', 'hdg="0.001" length="20"'))).not.toBe(xodrGeometrySha256(source));
  });

  it('flags structural changes outside the allowed elements', () => {
    const tampered = corrected.replace('<signal s="50"', '<signal s="51"');
    const diff = structuralDiff(source, tampered);
    expect(diff.forbidden.map((d) => d.path)).toEqual(['/OpenDRIVE[0]/road[id=1]/signals[0]/signal[id=77]']);
    expect(diff.bytesOutsideAllowedIdentical).toBe(false);
  });
});

describe('elevation refit building blocks', () => {
  it('formats numbers like RoadRunner', () => {
    expect(formatNumber(7.7144044016421036)).toBe('7.7144044016421036e+00');
    expect(formatNumber(-0.000123)).toBe('-1.2300000000000001e-04'); // %.16e prints the 17th significant digit of the double
    expect(formatNumber(0)).toBe('0.0000000000000000e+00');
    expect(formatNumber(1.5e123)).toBe('1.5000000000000000e+123');
    expect(() => formatNumber(Number.NaN)).toThrow();
  });

  it('reproduces a cubic exactly and honours pins', () => {
    const f = (s: number) => 3 + 0.1 * s - 0.02 * s * s + 0.001 * s * s * s;
    const obs = Array.from({ length: 81 }, (_, i) => ({ s: i * 0.25, t: 0, z: f(i * 0.25), w: 1 }));
    const knots = Float64Array.from([0, 7, 13, 20]);
    const spline = fitSpline2(knots, obs, [{ index: unknownIndex(0, 0, 0), value: 3 }], { smoothE: 0, smoothG: 0, ridgeG: 0, fitLateral: false });
    for (const s of [0, 3.3, 10, 19.9]) expect(evalComponent(spline, 0, s).value).toBeCloseTo(f(s), 7);
    const records = elevationRecords(spline);
    expect(records).toHaveLength(3);
    for (let i = 1; i < records.length; i += 1) {
      const p = records[i - 1]!; const r = records[i]!; const ds = r[0] - p[0];
      expect(p[1] + p[2] * ds + p[3] * ds * ds + p[4] * ds ** 3).toBeCloseTo(r[1], 12);
      expect(p[2] + 2 * p[3] * ds + 3 * p[4] * ds * ds).toBeCloseTo(r[2], 12);
    }
  });
});

describe('xodr elevation refit: Richmond Field Station fixture', () => {
  it('corrects the RoadRunner export to within the gates, deterministically', async () => {
    const dir = path.resolve(here, '../../../fixtures/golden-traces/maps/richmond-field-station');
    const xodrText = gunzipSync(await readFile(path.join(dir, 'map.xodr.gz'))).toString('utf8');
    const mesh = decodeGroundMesh(new Uint8Array(await readFile(path.join(dir, 'derived/ground/ground-mesh.bin'))));
    const run = runRefit({ mapId: 'richmond-field-station', xodrText, query: new GroundQuery(mesh), groundMesh: { sha256: 'fixture', source: 'fixture' } });
    expect(run.report.source.xodrSha256).toBe('5b08367524edbc0c46cfb2f4cd77ef6a204f263bb14cf7e8f90a1fffde1c14d6');
    expect(run.report.gates.filter((g) => !g.ok)).toEqual([]);
    expect(run.report.before.flaggedRoads).toBe(80);
    expect(run.report.after.flaggedRoads).toBe(0);
    expect(run.report.before.drivable.p95).toBeGreaterThan(0.06);
    expect(run.report.after.drivable.p95).toBeLessThan(0.01);
    expect(run.report.after.drivable.max).toBeLessThan(0.04);
    // Junction bump from the survey: road 308 was 26 cm below the mesh.
    expect(run.after.roads.get('308')!.max).toBeLessThan(0.02);
    // Golden: bump REFIT_REVISION when this changes.
    expect(run.report.corrected.xodrSha256).toBe('531c1bd6f568c56a41fd868ffe1cec0e92bc7dcda9c794c67a8f80a450186b18');
  }, 60_000);
});
