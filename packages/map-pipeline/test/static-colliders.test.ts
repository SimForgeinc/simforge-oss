import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { encodeGroundMesh, staticColliderMembers } from '../src/index.js';

const box = (x: number, y: number, z: number) =>
  ({ type: 'VEC3', componentType: 5126, count: 2, min: [-x / 2, 0, -z / 2], max: [x / 2, y, z / 2] });

/** A flat 100 m road square at z = 2 m (xodr-local, integer millimetres). */
const ground = encodeGroundMesh({
  vertices: Int32Array.from([-50_000, -50_000, 2_000, 50_000, -50_000, 2_000, 50_000, 50_000, 2_000, -50_000, 50_000, 2_000]),
  triangles: Uint32Array.from([0, 1, 2, 0, 2, 3]),
  classes: Uint8Array.from([1, 1]),
});

const master = {
  asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }],
  nodes: [
    // The pole stands on the road; its mast arm hangs 6.2 m over it.
    { name: 'signal_post_1_mesh_0', mesh: 0, translation: [10, 2, 0] },
    { name: 'signal_mast_arm_1_mesh_0', mesh: 1, translation: [14, 8.2, 0] },
  ],
  meshes: [0, 1].map((accessor) => ({ primitives: [{ attributes: { POSITION: accessor } }] })),
  accessors: [box(0.4, 7, 0.4), box(9, 0.3, 0.3)],
};

describe('staticColliderMembers', () => {
  it('builds the v2 artifact the web-runtime stage publishes and rewrites the variants entry', () => {
    const manifestBytes = Buffer.from('{"tiles":[]}\n');
    const variantsManifestBytes = Buffer.from(JSON.stringify({
      schemaVersion: 1, sourceManifestSha256: 'x',
      variants: {
        'static-colliders': { id: 'static-colliders', schemaVersion: 1, file: 'static-colliders-v1.json' },
        'textures-512-bc7': { id: 'textures-512-bc7', file: 't.json' },
      },
    }));
    const members = staticColliderMembers({
      mapId: 'two-level', manifestBytes, masterBytes: Buffer.from(JSON.stringify(master)),
      topologyBytes: gzipSync(JSON.stringify({ lanes: {} })), groundBytes: ground, variantsManifestBytes,
    });
    expect(members.file).toBe('static-colliders-v2.json');
    expect(members.artifact.sourceManifestSha256).toBe(createHash('sha256').update(manifestBytes).digest('hex'));
    // The arm is overhead; the pole keeps its extent above the road.
    expect(members.artifact.colliders.map(({ id, vertical }) => ({ id, vertical }))).toEqual([
      { id: 'canonical-master/0', vertical: { minY: 2, maxY: 9 } },
    ]);
    expect(members.artifact.statistics.rejectedOverhead).toBe(1);
    const variants = JSON.parse(members.variantsManifestBytes.toString('utf8'));
    expect(variants.variants['static-colliders']).toEqual({
      id: 'static-colliders', schemaVersion: 2, file: 'static-colliders-v2.json',
      digest: members.artifact.digest,
      outputSha256: createHash('sha256').update(members.artifactBytes).digest('hex'),
      bytes: members.artifactBytes.length, sourceTiles: 1, accepted: 1,
    });
    expect(variants.variants['textures-512-bc7']).toEqual({ id: 'textures-512-bc7', file: 't.json' });
    // Deterministic bytes.
    const again = staticColliderMembers({
      mapId: 'two-level', manifestBytes, masterBytes: Buffer.from(JSON.stringify(master)),
      topologyBytes: gzipSync(JSON.stringify({ lanes: {} })), groundBytes: ground, variantsManifestBytes,
    });
    expect(again.artifactBytes.equals(members.artifactBytes)).toBe(true);
    expect(again.variantsManifestBytes.equals(members.variantsManifestBytes)).toBe(true);
  });

  it('classifies nothing without a ground surface', () => {
    const members = staticColliderMembers({
      mapId: 'no-ground', manifestBytes: Buffer.from('{"tiles":[]}\n'), masterBytes: Buffer.from(JSON.stringify(master)),
      topologyBytes: Buffer.from(JSON.stringify({ lanes: {} })), groundBytes: null,
      variantsManifestBytes: Buffer.from('{"schemaVersion":1,"variants":{}}'),
    });
    expect(members.artifact.overheadClearanceM).toBeNull();
    expect(members.artifact.colliders).toHaveLength(2);
  });
});
