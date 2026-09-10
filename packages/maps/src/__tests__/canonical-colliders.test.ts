import { expect, it } from 'vitest';
import { buildStaticColliderArtifact } from '../ingest/static-colliders.mjs';

it('retains separate world-space obstacles when the browser tier instances a shared mesh', () => {
  const master = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [
      { translation: [10, 0, 20], children: [1, 2] },
      { name: 'Building_A', mesh: 0 },
      { name: 'Building_B', mesh: 0, translation: [30, 0, 0] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ type: 'VEC3', componentType: 5126, count: 2, min: [-2, 0, -2], max: [2, 6, 2] }],
  };
  const artifact = buildStaticColliderArtifact({
    mapId: 'shared-mesh-map', sourceManifestSha256: 'a'.repeat(64),
    manifest: { tiles: [{ id: 'instanced', lods: [{ level: 0, file: 'instanced.glb' }] }] },
    topology: { lanes: {} },
    canonicalGltf: { file: 'master.gltf', bytes: Buffer.from(JSON.stringify(master)) },
  });
  expect(artifact.colliders.map(({ obb }) => obb)).toEqual([
    { center: { x: 10, z: 20 }, lengthM: 4, widthM: 4, headingRad: 0 },
    { center: { x: 40, z: 20 }, lengthM: 4, widthM: 4, headingRad: 0 },
  ]);
});

it('ignores a merged map-wide curb network, keeping only strip-shaped road boundaries', () => {
  // RoadRunner exports the whole map's kerbs as one `Roads_Curb` mesh under a
  // ×100 unit-scale parent. Its bounding box is the map; treating it as a solid
  // slab put every spawned vehicle inside a collider at t=0 (rc.61 Richmond
  // Field Station regression: routes ignored, vehicles kicked sideways).
  const master = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [
      { scale: [100, 100, 100], children: [1, 2] },
      { name: 'Roads_Curb_Layer0', mesh: 0 },
      { name: 'Road_Curb_7', mesh: 1 },
    ],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0 } }] },
      { primitives: [{ attributes: { POSITION: 1 } }] },
    ],
    accessors: [
      { type: 'VEC3', componentType: 5126, count: 2, min: [-0.43, 0.04, -3.42], max: [3.86, 0.09, 1.1] },
      { type: 'VEC3', componentType: 5126, count: 2, min: [0, 0, 0], max: [0.12, 0.002, 0.002] },
    ],
  };
  const artifact = buildStaticColliderArtifact({
    mapId: 'merged-curb-map', sourceManifestSha256: 'a'.repeat(64),
    manifest: { tiles: [] },
    topology: { lanes: {} },
    canonicalGltf: { file: 'master.gltf', bytes: Buffer.from(JSON.stringify(master)) },
  });
  expect(artifact.colliders.map(({ id, class: kind, obb }) => ({ id, kind, lengthM: obb.lengthM, widthM: obb.widthM }))).toEqual([
    { id: 'canonical-master/2', kind: 'road-boundary', lengthM: 12, widthM: 0.2 },
  ]);
  expect(artifact.statistics.ignored).toBe(1);
});
