import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildGroundDerivative,
  decodeGroundMesh,
  encodeGroundMesh,
  extractGroundSurface,
  GroundBuildError,
  GroundQuery,
  parseXodrRoads,
  sampleLaneCentres,
  SURFACE_CLASSES,
  surfaceClassOf,
} from '../src/ground/index.js';

/**
 * A 100 m straight road along +x (reference line y = 0, lanes -1 and 1, each
 * 3.5 m) whose OpenDRIVE elevation climbs 1 % from z = 10.
 */
function xodr(elevationB = 0.01, laneHeight = ''): string {
  return `<?xml version="1.0"?>
<OpenDRIVE><header revMajor="1" revMinor="4"/>
  <road name="r" length="100" id="7" junction="-1">
    <planView><geometry s="0" x="0" y="0" hdg="0" length="100"><line/></geometry></planView>
    <elevationProfile><elevation s="0" a="10" b="${elevationB}" c="0" d="0"/></elevationProfile>
    <lanes><laneSection s="0">
      <left><lane id="1" type="driving"><width sOffset="0" a="3.5" b="0" c="0" d="0"/>${laneHeight}</lane></left>
      <center><lane id="0" type="none"/></center>
      <right><lane id="-1" type="driving"><width sOffset="0" a="3.5" b="0" c="0" d="0"/></lane></right>
    </laneSection></lanes>
  </road>
</OpenDRIVE>`;
}

/**
 * A master with one `Roads_Road_Layer0` quad covering the road (x 0..100,
 * y -4..4) at the given end heights, plus a `Roads_Curb` riser (vertical,
 * must be dropped) and a lamp post (unclassified, must be ignored). The
 * scene is y-up: local (x, y, z) is stored as (x, z, -y).
 */
async function writeMaster(dir: string, z0: number, z1: number, options: { hole?: boolean } = {}): Promise<void> {
  const quad = (xs: number[], ys: number[], zs: number[]) => xs.map((x, i) => [x, zs[i]!, -ys[i]!]);
  const road = options.hole
    ? [...quad([0, 40, 40, 0], [-4, -4, 4, 4], [z0, z0, z0, z0]), ...quad([60, 100, 100, 60], [-4, -4, 4, 4], [z1, z1, z1, z1])]
    : quad([0, 100, 100, 0], [-4, -4, 4, 4], [z0, z1, z1, z0]);
  const riser = quad([0, 100, 100, 0], [4, 4, 4, 4], [z0, z1, z1 + 0.15, z0 + 0.15]);
  const post = quad([50, 50.2, 50.2, 50], [5, 5, 5.2, 5.2], [z0 + 5, z0 + 5, z0 + 5, z0 + 5]);
  const meshes = [road, riser, post];
  const floats: number[] = [];
  const ints: number[] = [];
  const accessors: unknown[] = [];
  const bufferViews: unknown[] = [];
  let intOffset = 0;
  const floatBase = () => floats.length * 4;
  for (const vertices of meshes) {
    const at = floatBase();
    for (const v of vertices) floats.push(...v);
    bufferViews.push({ buffer: 0, byteOffset: at, byteLength: vertices.length * 12 });
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: vertices.length, type: 'VEC3' });
    const quads = vertices.length / 4;
    const idx: number[] = [];
    for (let q = 0; q < quads; q += 1) idx.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3);
    ints.push(...idx);
    bufferViews.push({ buffer: 1, byteOffset: intOffset * 4, byteLength: idx.length * 4 });
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5125, count: idx.length, type: 'SCALAR' });
    intOffset += idx.length;
  }
  const gltf = {
    asset: { version: '2.0' },
    buffers: [{ uri: 'geometry.bin', byteLength: floats.length * 4 }, { uri: 'indices.bin', byteLength: ints.length * 4 }],
    bufferViews,
    accessors,
    meshes: meshes.map((_, i) => ({ primitives: [{ attributes: { POSITION: i * 2 }, indices: i * 2 + 1 }] })),
    nodes: [
      { name: 'Scene', children: [1, 2, 3, 4] },
      { name: 'Roads_Road_Layer0', children: [5] },
      { name: 'Roads_Curb_Layer0', mesh: 1 },
      { name: 'LampPost01', mesh: 2 },
      { name: 'Terrain' },
      { name: 'InstancedStaticMeshComponent', mesh: 0 },
    ],
    scenes: [{ nodes: [0] }],
  };
  await writeFile(path.join(dir, 'master.gltf'), JSON.stringify(gltf));
  await writeFile(path.join(dir, 'geometry.bin'), Buffer.from(new Float32Array(floats).buffer));
  await writeFile(path.join(dir, 'indices.bin'), Buffer.from(new Uint32Array(ints).buffer));
}

describe('ground derivative', () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'ground-')); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it('classifies meshes by their asset-layer ancestors', () => {
    expect(surfaceClassOf(['Scene', 'Tile_0_0', 'Roads', 'Roads_Road', 'Roads_Road_Layer0', 'x'])).toBe('road');
    expect(surfaceClassOf(['Roads_Curb_Layer0_4'])).toBe('curb');
    expect(surfaceClassOf(['Terrain_Ground_Layer0_5'])).toBe('terrain');
    expect(surfaceClassOf(['Terrain_Road_Layer2'])).toBe('road');
    expect(surfaceClassOf(['Roads_Uncategorized'])).toBe('paved');
    expect(surfaceClassOf(['Props', 'Prop_Marking_15'])).toBe('marking');
    // Signs named after roads are not road surface.
    expect(surfaceClassOf(['Props', 'RoadWorkAhead_US_1_Sign'])).toBeNull();
    expect(surfaceClassOf(['Roads'])).toBeNull();
  });

  it('extracts only upward-facing classified triangles, in xodr-local millimetres', async () => {
    await writeMaster(dir, 10, 11);
    const surface = await extractGroundSurface(dir);
    expect(surface.triangles.length / 3).toBe(2);
    expect(surface.droppedNotUpward).toBe(2);
    expect([...surface.classes]).toEqual([SURFACE_CLASSES.road, SURFACE_CLASSES.road]);
    const query = new GroundQuery(surface);
    // Local y = +2 (north) maps to scene z = -2.
    expect(query.surfacesAt(50, 2)[0]!.z).toBeCloseTo(10.5, 9);
    expect(query.surfacesAt(50, 20)).toEqual([]);
    const bytes = encodeGroundMesh(surface);
    const decoded = decodeGroundMesh(bytes);
    expect([...decoded.vertices]).toEqual([...surface.vertices]);
    expect([...decoded.classes]).toEqual([...surface.classes]);
  });

  it('evaluates OpenDRIVE lane centres including laneHeight', () => {
    const roads = parseXodrRoads(xodr(0.01, '<height sOffset="0" inner="0.1" outer="0.3"/>'));
    const samples = sampleLaneCentres(roads, 10);
    const left = samples.find((s) => s.lane === 1 && s.s === 50)!;
    expect(left.y).toBeCloseTo(1.75, 9);
    expect(left.z).toBeCloseTo(10.5 + 0.2, 9);
    const right = samples.find((s) => s.lane === -1 && s.s === 50)!;
    expect(right.y).toBeCloseTo(-1.75, 9);
    expect(right.z).toBeCloseTo(10.5, 9);
  });

  it('writes an ok derivative when the mesh matches OpenDRIVE', async () => {
    await writeMaster(dir, 10, 11);
    await writeFile(path.join(dir, 'map.xodr'), xodr(0.01));
    const out = path.join(dir, 'derived', 'ground');
    const first = await buildGroundDerivative({ masterDir: dir, xodrPath: path.join(dir, 'map.xodr'), mapId: 'fixture', outputDir: out });
    expect(first.manifest.status).toBe('ok');
    expect(first.report.validation!.drivingCoverage).toBe(1);
    expect(first.report.validation!.dzAbsM.max).toBeLessThan(1e-3);
    const bytes = await readFile(path.join(out, 'ground-mesh.bin'));
    expect(first.manifest.mesh.bytes).toBe(bytes.length);
    // Deterministic: a rebuild writes identical bytes and the same key.
    const second = await buildGroundDerivative({ masterDir: dir, xodrPath: path.join(dir, 'map.xodr'), mapId: 'fixture', outputDir: out });
    expect(second.manifest).toEqual(first.manifest);
  });

  it('flags a map whose OpenDRIVE elevation disagrees with the rendered mesh, without failing', async () => {
    // Mesh flat at 10 m; OpenDRIVE climbs to 11 m (the Belmont road 116 class).
    await writeMaster(dir, 10, 10);
    await writeFile(path.join(dir, 'map.xodr'), xodr(0.01));
    const result = await buildGroundDerivative({ masterDir: dir, xodrPath: path.join(dir, 'map.xodr'), mapId: 'fixture', outputDir: path.join(dir, 'flagged') });
    expect(result.manifest.status).toBe('xodr-disagrees');
    const road = result.report.validation!.flaggedRoads[0]!;
    expect(road.road).toBe('7');
    expect(road.worst.dzM).toBeCloseTo(1, 2);
    expect(result.manifest.warnings[0]).toMatch(/disagrees with the rendered road mesh on 1 road/);
  });

  it('fails the build when driving lanes have no rendered surface', async () => {
    await writeMaster(dir, 10, 11, { hole: true });
    await writeFile(path.join(dir, 'map.xodr'), xodr(0.01));
    const out = path.join(dir, 'holed');
    await expect(buildGroundDerivative({ masterDir: dir, xodrPath: path.join(dir, 'map.xodr'), mapId: 'fixture', outputDir: out }))
      .rejects.toBeInstanceOf(GroundBuildError);
    await expect(readFile(path.join(out, 'failed-ground-report.json'), 'utf8')).resolves.toMatch(/"holes"/);
    await expect(readFile(path.join(out, 'ground-manifest.json'))).rejects.toThrow();
  });
});
