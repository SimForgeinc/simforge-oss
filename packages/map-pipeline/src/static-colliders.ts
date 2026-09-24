import { gunzipSync } from 'node:zlib';

import {
  buildStaticColliderArtifact,
  serializeStaticColliderArtifact,
  STATIC_COLLIDER_FILE,
  STATIC_COLLIDER_SCHEMA_VERSION,
  type StaticColliderArtifact,
} from '@simforge-oss/maps/ingest';

import { canonicalJson, sha256 } from './closure.js';
import { decodeGroundMesh, GroundQuery } from './ground/index.js';

/**
 * Revision of the static-collider members a scenario-ready web closure
 * carries (`3d/variants/static-colliders-v2.json` and its entry in
 * `3d/variants/manifest.json`). Folded into the web-runtime stage key and into
 * the tool fingerprint of a web closure whose colliders were rebuilt.
 */
export const STATIC_COLLIDER_STAGE_REVISION = 'canonical-static-colliders-v3';

export interface StaticColliderMembersInput {
  readonly mapId: string;
  /** `3d/manifest.json` of the web closure: the artifact is bound to its sha256. */
  readonly manifestBytes: Uint8Array;
  /** The canonical `master.gltf`. */
  readonly masterBytes: Uint8Array;
  /** `topology-index.json.gz` (gzipped or plain). */
  readonly topologyBytes: Uint8Array;
  /** `derived/ground/ground-mesh.bin`, or null for a map without a ground surface. */
  readonly groundBytes: Uint8Array | null;
  /** The web closure's `3d/variants/manifest.json` before the colliders are added. */
  readonly variantsManifestBytes: Uint8Array;
}

export interface StaticColliderMembers {
  readonly artifact: StaticColliderArtifact;
  /** `3d/variants/<file>`. */
  readonly file: typeof STATIC_COLLIDER_FILE;
  readonly artifactBytes: Buffer;
  /** The variants manifest with the `static-colliders` entry (re)written. */
  readonly variantsManifestBytes: Buffer;
}

/**
 * The static-collider members of a scenario-ready web closure, from the
 * canonical master, the topology and the ground surface. The ONE producer the
 * pipeline's web-runtime stage and a collider rebuild of a published version
 * share, so a rebuilt closure carries exactly the bytes a fresh build would.
 */
export function staticColliderMembers(input: StaticColliderMembersInput): StaticColliderMembers {
  const plain = (bytes: Uint8Array) => Buffer.from(bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes);
  const ground = input.groundBytes ? new GroundQuery(decodeGroundMesh(input.groundBytes)) : null;
  const artifact = buildStaticColliderArtifact({
    mapId: input.mapId,
    sourceManifestSha256: sha256(Buffer.from(input.manifestBytes)),
    manifest: JSON.parse(Buffer.from(input.manifestBytes).toString('utf8')),
    topology: JSON.parse(plain(input.topologyBytes).toString('utf8')),
    ground: ground ? { surfacesAt: (x: number, y: number) => ground.surfacesAt(x, y).map((hit) => hit.z) } : null,
    canonicalGltf: { file: 'master.gltf', bytes: Buffer.from(input.masterBytes) },
  });
  const artifactBytes = Buffer.from(serializeStaticColliderArtifact(artifact));
  const variants = JSON.parse(Buffer.from(input.variantsManifestBytes).toString('utf8')) as { variants: Record<string, unknown> };
  variants.variants['static-colliders'] = {
    id: 'static-colliders', schemaVersion: STATIC_COLLIDER_SCHEMA_VERSION, file: STATIC_COLLIDER_FILE,
    digest: artifact.digest, outputSha256: sha256(artifactBytes), bytes: artifactBytes.length,
    sourceTiles: artifact.statistics.sourceTiles, accepted: artifact.statistics.accepted,
  };
  return { artifact, file: STATIC_COLLIDER_FILE, artifactBytes, variantsManifestBytes: Buffer.from(`${canonicalJson(variants)}\n`) };
}
