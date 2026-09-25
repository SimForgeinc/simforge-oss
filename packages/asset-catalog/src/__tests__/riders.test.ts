import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

// The models are not in git: each is fetched by its digest in the sealed
// vehicles-carla closure (catalog/vehicles-carla/closure.json) into the shared
// asset cache. An unreachable or non-verifying model fails the test.
import { packClosure, pullBlob } from '../../../../scripts/actor-assets/closures.mjs';
import { CATALOG } from '../catalog.js';
import type { CatalogEntry } from '../types.js';

interface GltfNode { readonly name?: string; readonly mesh?: number; readonly skin?: number; readonly children?: readonly number[]; readonly extras?: Record<string, unknown> }
interface Gltf {
  readonly nodes: readonly GltfNode[];
  readonly scenes: readonly { readonly nodes: readonly number[] }[];
  readonly materials: readonly { readonly name?: string }[];
  readonly animations?: readonly { readonly name?: string; readonly channels: readonly unknown[] }[];
}

function glbJson(bytes: Buffer): Gltf {
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
  const length = bytes.readUInt32LE(12);
  return JSON.parse(bytes.subarray(20, 20 + length).toString('utf8')) as Gltf;
}

const TWO_WHEELERS = (CATALOG as readonly CatalogEntry[]).filter((entry) => entry.actorClass === 'bicycle' || entry.actorClass === 'motorcycle');

describe('ridden two-wheelers', () => {
  it('binds every two-wheeler with a GLB to a ridden model (no ghost bikes)', () => {
    const withModels = TWO_WHEELERS.filter((entry) => entry.model?.kind === 'glb');
    expect(withModels.map((entry) => entry.id).sort()).toEqual(['vehicle.bicycle', 'vehicle.motorcycle']);
    for (const entry of withModels) {
      const model = entry.model!;
      if (model.kind !== 'glb') throw new Error('unreachable');
      expect(model.rider, entry.id).toBeDefined();
      expect(model.animated, entry.id).toBe(true);
      // The clip drives wheels and crank; renderer articulation would fight it.
      expect(model.nodes, entry.id).toBeUndefined();
    }
  });

  for (const entry of TWO_WHEELERS.filter((candidate) => candidate.model?.kind === 'glb')) {
    it(`${entry.id}: the GLB carries the rider, its clip and every palette slot`, async () => {
      const model = entry.model!;
      if (model.kind !== 'glb' || !model.rider) throw new Error(`${entry.id} is not ridden`);
      const member = packClosure('vehicles-carla').members.get(model.url.replace(/^\/catalog\/vehicles-carla\//, ''));
      expect(member?.sha256, `${model.url} is a member of the sealed vehicles-carla closure`).toBe(model.contentHash);
      const bytes = readFileSync(await pullBlob(member!));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(model.contentHash);
      const gltf = glbJson(bytes);
      const rider = gltf.nodes.find((node) => node.name === 'rider');
      expect(rider?.extras?.semanticClass).toBe('rider');
      const riderMesh = gltf.nodes.find((node) => node.name === 'rider_mesh');
      expect(riderMesh?.skin).toBeDefined();
      expect(riderMesh?.extras?.semanticClass).toBe('rider');
      // Skinned mesh at a scene root: loaders must not bake parent transforms into the bind.
      const index = gltf.nodes.indexOf(riderMesh!);
      expect(gltf.scenes[0]!.nodes).toContain(index);
      const clip = gltf.animations?.find((animation) => animation.name === model.rider!.clip);
      expect(clip?.channels.length).toBeGreaterThan(0);
      const materials = new Set(gltf.materials.map((material) => material.name));
      for (const slot of model.rider.slots) expect(materials.has(slot), slot).toBe(true);
      expect(model.rider.palettes[0]).toBeNull();
      for (const palette of model.rider.palettes.slice(1)) {
        expect(Object.keys(palette!).sort()).toEqual([...model.rider.slots].sort());
      }
      if (entry.actorClass === 'motorcycle') {
        expect(gltf.nodes.some((node) => node.name === 'rider_helmet')).toBe(true);
        expect(model.rider.slots).toContain('rider_helmet');
      }
    }, 300_000); // a cold cache downloads the model (tens of MB)
  }
});
