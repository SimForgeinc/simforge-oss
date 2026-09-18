import { expect, it } from 'vitest';
import { buildStaticColliderArtifact, extractGlbColliders } from '../ingest/static-colliders.mjs';

/** The authored sources are GLBs; the extractor reads their JSON chunk alone. */
function glb(json: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(json), 'utf8');
  const chunk = Buffer.concat([body, Buffer.alloc((4 - (body.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + chunk.length, 8);
  header.writeUInt32LE(chunk.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, chunk]);
}

const box = (x: number, y: number, z: number) =>
  ({ type: 'VEC3', componentType: 5126, count: 2, min: [-x / 2, 0, -z / 2], max: [x / 2, y, z / 2] });

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

it('makes component-named geometry solid, taking its class from the ancestor chain or its size', () => {
  // Nothing here is named like an obstacle: `InstancedStaticMeshComponent_0:7`
  // is Unreal's component name and `3_2_VWB_16` is Belmont's own code for an
  // office block. Under the old name-inclusion list both were `ignored`, which
  // is why 4842 of Belmont's 4869 mesh nodes collided with nothing.
  const master = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 3] }],
    nodes: [
      { name: 'Scene', children: [1] },
      { name: '{194278d9-e401-43a8-8f03-aae562c04407}FencePost', children: [2] },
      { name: 'InstancedStaticMeshComponent_0:7', mesh: 0, translation: [4, 0, 0] },
      { name: '3_2_VWB_16', mesh: 1, translation: [40, 0, 40] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }, { primitives: [{ attributes: { POSITION: 1 } }] }],
    accessors: [box(0.2, 2.5, 0.2), box(14, 7.5, 11)],
  };
  const artifact = buildStaticColliderArtifact({
    mapId: 'component-names', sourceManifestSha256: 'a'.repeat(64),
    manifest: { tiles: [] }, topology: { lanes: {} },
    canonicalGltf: { file: 'master.gltf', bytes: Buffer.from(JSON.stringify(master)) },
  });
  expect(artifact.colliders.map(({ id, class: kind, obb }) => ({ id, kind, center: obb.center }))).toEqual([
    { id: 'canonical-master/2', kind: 'wall', center: { x: 4, z: 0 } },
    { id: 'canonical-master/3', kind: 'building', center: { x: 40, z: 40 } },
  ]);
  expect(artifact.statistics.ignored).toBe(0);
});

it('excludes road surfaces, ground and foliage, and says which it excluded', () => {
  // `Trees`/`Bushes_v1` instances carry canopy and trunk in one mesh, so the
  // trunk goes with the canopy: a 6 m box across a verge would be worse than
  // no collider at all. Surfaces go by the exporter's own layer taxonomy.
  const source = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 2, 6] }],
    nodes: [
      { name: 'Bushes_v1', children: [1] },
      { name: 'HierarchicalInstancedStaticMeshComponent_2:11', mesh: 0 },
      { name: 'Roads', children: [3, 4, 5] },
      { name: 'Roads_Road_Layer0', mesh: 1 },
      { name: 'Roads_Sidewalk_Layer0', mesh: 1 },
      { name: 'Terrain_Ground_Layer0', mesh: 1 },
      { name: 'Prop_Marking_19', mesh: 2 },
    ],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0 } }] },
      { primitives: [{ attributes: { POSITION: 1 } }] },
      { primitives: [{ attributes: { POSITION: 2 } }] },
    ],
    accessors: [box(6, 6.5, 6), box(570, 4.6, 550), box(120, 0.02, 40)],
  };
  const extracted = extractGlbColliders(glb(source), 'tile-0');
  expect(extracted.colliders).toEqual([]);
  expect(extracted.exclusions).toEqual({ surface: 4, foliage: 1, flat: 0, tiny: 0, degenerate: 0, mergedBoundary: 0 });
});

it('rejects what a travel lane runs through and keeps what merely stands beside one', () => {
  // The lane index pads every sample by half its lane's width plus 0.75 m, so
  // comparing a raw footprint to it deleted kerbside obstacles: a 5.2 m
  // parking bay abutting a wall put the whole building on the reject pile.
  const master = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1, 2] }],
    nodes: [
      { name: 'Prop_Prop_3', mesh: 0, translation: [10, 0, 0] },
      { name: 'Prop_Prop_4', mesh: 0, translation: [10, 0, 11.5] },
      { name: 'P_17_container', mesh: 1, translation: [10, 0, -3] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }, { primitives: [{ attributes: { POSITION: 1 } }] }],
    accessors: [box(14, 7.5, 14), box(0.4, 1.1, 0.4)],
  };
  const artifact = buildStaticColliderArtifact({
    mapId: 'lane-overlap', sourceManifestSha256: 'a'.repeat(64),
    manifest: { tiles: [] },
    topology: { lanes: {
      drive: { laneType: 'driving', representativeWidthM: 3.5, polyline: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }] },
      bay: { laneType: 'parking', representativeWidthM: 2.6, polyline: [{ x: 4, y: -3 }, { x: 16, y: -3 }] },
    } },
    canonicalGltf: { file: 'master.gltf', bytes: Buffer.from(JSON.stringify(master)) },
  });
  // Node 0 straddles the driving lane. Node 1's near wall stands 1.5 m clear
  // of the parking bay's centreline — inside the old padded band, outside the
  // footprint the lane actually crosses. The container sits between the lanes.
  expect(artifact.colliders.map(({ id }) => id)).toEqual(['canonical-master/1', 'canonical-master/2']);
  expect(artifact.statistics.rejectedRoadOverlap).toBe(1);
});
