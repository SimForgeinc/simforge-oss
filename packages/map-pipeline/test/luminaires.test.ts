import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildLuminaires, classifyLuminaires, isLuminaireName, luminairesBuildKey, luminairesFingerprint, parseLuminairesManifest,
} from '../src/luminaires.js';

// One unit cube mesh (POSITION bounds -0.5..0.5), scaled per node.
const cube = { primitives: [{ attributes: { POSITION: 0 } }] };
const accessors = [{ min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] }];

/**
 * A RoadRunner street light (`{guid}StreetLight_30ft` > Node > pole, arm,
 * head), a standalone parking-lot lamp head, and street-light-named props
 * that are not fixtures (a 0.5 m sign, a 30 m mast).
 */
const master = {
  asset: { version: '2.0' },
  scene: 0,
  scenes: [{ nodes: [0, 5, 7, 8] }],
  nodes: [
    { name: '{a70aaa6b-6ce4-475f-a4a7-f37a4ed1054b}StreetLight_30ft', translation: [10, 0, 20], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], children: [1] },
    { name: 'Node', children: [2, 3, 4] },
    { name: 'Signal_Post_30ft', mesh: 0, translation: [0, 4.5, 0], scale: [0.3, 9, 0.3] },
    { name: 'Luminaire_Arm_8ft', mesh: 0, translation: [1.2, 8.8, 0], scale: [2.4, 0.2, 0.2] },
    { name: 'Luminaire_Head01', mesh: 0, translation: [2.4, 8.6, 0], scale: [0.8, 0.3, 0.4] },
    { name: '{94c1874c-ae40-47a5-8b1c-2b3a1d0e9f11}Luminaire_Head02', translation: [-30, 7, 5], children: [6] },
    { name: 'Luminaire_Head02_mesh_Prop', mesh: 0, scale: [0.6, 0.3, 0.6] },
    { name: 'StreetLight_Sign', mesh: 0, translation: [0, 1, 0], scale: [0.5, 0.5, 0.1] },
    { name: 'LightPole_Stadium', mesh: 0, translation: [50, 15, 50], scale: [1, 30, 1] },
  ],
  meshes: [cube],
  accessors,
};

describe('street luminaire derivative', () => {
  it('matches RoadRunner fixture names, braces and camel case included', () => {
    expect(isLuminaireName('{a70aaa6b-6ce4-475f-a4a7-f37a4ed1054b}StreetLight_30ft')).toBe(true);
    expect(isLuminaireName('a70aaa6bStreetLight_30ft_DefaultSceneRoot')).toBe(true);
    expect(isLuminaireName('Object_66790683-59e6-4e09-8926-790cb2fafe27_StreetLight_30ft')).toBe(true);
    expect(isLuminaireName('Streetlightning')).toBe(false);
    expect(isLuminaireName('TrafficLight_3Lamp')).toBe(false);
  });

  it('places the bulb at the lamp head, takes standalone heads, and refuses what is not a fixture', () => {
    const { fixtures, rejected } = classifyLuminaires(master);
    expect(fixtures).toHaveLength(2);
    const [street, lot] = [fixtures.find((f) => f.rule === 'head')!, fixtures.find((f) => f.rule === 'lamp-head')!];
    // The pole's node is rotated 90 degrees about +y: the arm's +x points to -z.
    expect(street.position[0]).toBeCloseTo(10, 2);
    expect(street.position[1]).toBeCloseTo(8.6, 2);
    expect(street.position[2]).toBeCloseTo(17.6, 2);
    expect(street.headingRad).toBeCloseTo(Math.PI / 2, 2);
    expect(street.sourceName).toContain('StreetLight_30ft');
    expect(lot.position).toEqual([-30, 7, 5]);
    // The sign is too short and the stadium mast too tall.
    expect(rejected).toBe(2);
  });

  it('is keyed on the master and the builder, and round-trips through its parser', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'luminaires-'));
    try {
      await writeFile(path.join(dir, 'master.gltf'), JSON.stringify(master));
      const built = await buildLuminaires({ masterDir: dir, outputDir: path.join(dir, 'out') });
      const read = parseLuminairesManifest(JSON.parse(await readFile(path.join(dir, 'out', 'manifest.json'), 'utf8')));
      expect(read).toEqual(built);
      expect(read.buildKey).toBe(luminairesBuildKey({ masterSha256: read.source.master.sha256, fingerprint: luminairesFingerprint() }));
      expect(() => parseLuminairesManifest({ ...read, fixtures: [{ sourceId: 'n0', position: [0, Number.NaN, 0] }] })).toThrow(/fixtures/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
