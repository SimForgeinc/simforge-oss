import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { sha256 } from '../src/closure.js';
import {
  buildRoadDecals, classifyRoadDecals, parseRoadDecalsManifest, ROAD_DECAL_OPACITY_SCALE, roadDecalsBuildKey, roadDecalsFingerprint,
} from '../src/road-decals.js';

const master = {
  asset: { version: '2.0' },
  materials: [
    { name: 'MI_Road_Asphalt_A2_Roads_Road_Layer0' },
    { name: 'OilPath01_Road_Roads_Road_Layer1', alphaMode: 'BLEND' },
    { name: 'LinearCracks01_Road_3_Roads_Road_Layer4', alphaMode: 'BLEND' },
    { name: 'OilStains01_Diff_png_Marking_Terrain_Marking_Layer1', alphaMode: 'BLEND' },
    { name: 'Cracks01_rrx_Marking_Roads_Marking_Layer2', alphaMode: 'BLEND' },
    // Content, not wear: lane paint and symbols keep their opacity.
    { name: 'LaneMarking2_Marking_Roads_Marking_Layer1', alphaMode: 'BLEND' },
    { name: 'handicapped_png_Marking_Roads_Marking_Layer2', alphaMode: 'BLEND' },
    // A wear name that is not a blended layer is not a decal.
    { name: 'OilPath01_Road_Roads_Road_Layer1_Opaque', alphaMode: 'OPAQUE' },
    { name: 'OilPath01_Road_Roads_Road_Layer0', alphaMode: 'BLEND' },
  ],
};

describe('road decal derivative', () => {
  it('lists only blended wear layers, and names the blended layers it keeps', () => {
    const { materials, keptBlendedLayers } = classifyRoadDecals(master);
    expect(materials.map((m) => [m.index, m.family, m.layer])).toEqual([[1, 'OilPath', 1], [2, 'LinearCracks', 4], [3, 'OilStains', 1], [4, 'Cracks', 2]]);
    expect(keptBlendedLayers).toEqual(['LaneMarking2_Marking_Roads_Marking_Layer1', 'handicapped_png_Marking_Roads_Marking_Layer2']);
  });

  it('writes a manifest bound to the master bytes, with the calibrated opacity', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'road-decals-'));
    try {
      const bytes = Buffer.from(JSON.stringify(master));
      await writeFile(path.join(dir, 'master.gltf'), bytes);
      const built = await buildRoadDecals({ masterDir: dir, outputDir: path.join(dir, 'out') });
      const manifest = parseRoadDecalsManifest(JSON.parse(await readFile(path.join(dir, 'out', 'manifest.json'), 'utf8')));
      expect(manifest).toEqual(built);
      expect(manifest.source.master.sha256).toBe(sha256(bytes));
      expect(manifest.opacityScale).toBe(ROAD_DECAL_OPACITY_SCALE);
      expect(manifest.buildKey).toBe(roadDecalsBuildKey({ masterSha256: sha256(bytes), fingerprint: roadDecalsFingerprint() }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a malformed manifest', () => {
    expect(() => parseRoadDecalsManifest({ schema: 'simforge.map-road-decals.v1', opacityScale: 2 })).toThrow();
    expect(() => parseRoadDecalsManifest({ schema: 'other' })).toThrow(/schema/);
  });
});
