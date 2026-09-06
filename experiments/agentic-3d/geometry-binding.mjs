import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { NodeIO } from '@gltf-transform/core';
import { applySituationTransaction, parseSituationProgram, situationDigest } from '@simforge-oss/scenario';
import { canonicalJson, contentHash } from '@simforge-oss/engine';
import { parseExternalCatalogEntries } from '@simforge-oss/asset-catalog/metadata';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const exact = (a, b) => canonicalJson(a) === canonicalJson(b);
const nonempty = value => typeof value === 'string' && value.length > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const localPath = uri => {
  assert(nonempty(uri), 'Artifact URI is required');
  if (uri.startsWith('file:')) return fileURLToPath(uri);
  assert(path.isAbsolute(uri), 'Generated geometry requires local absolute paths or file: URIs');
  return uri;
};
const verifiedBytes = reference => {
  assert(reference && digest(reference.sha256), 'Artifact SHA256 is required');
  const bytes = fs.readFileSync(localPath(reference.uri));
  assert(sha(bytes) === reference.sha256, `Artifact SHA256 mismatch: ${reference.uri}`);
  return bytes;
};
const keys = (value, expected, label) => {
  assert(value && typeof value === 'object' && !Array.isArray(value) && exact(Object.keys(value).sort(), [...expected].sort()), `Invalid ${label} fields`);
};
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const loaded = new WeakMap();

function validateDescriptor(d) {
  keys(d, ['schema', 'jobId', 'mapId', 'sourceArtifacts', 'objectIds', 'asset', 'placement', 'dimensions', 'support'], 'descriptor');
  assert(d.schema === 'simforge.generated-static-geometry/v1' && nonempty(d.jobId) && nonempty(d.mapId), 'Unsupported geometry descriptor');
  assert(Array.isArray(d.sourceArtifacts) && d.sourceArtifacts.length > 0, 'Immutable source artifacts are required');
  for (const source of d.sourceArtifacts) {
    keys(source, ['id', 'uri', 'sha256'], 'source artifact');
    assert(nonempty(source.id), 'Source ID is required');
    verifiedBytes(source);
  }
  assert(new Set(d.sourceArtifacts.map(source => source.id)).size === d.sourceArtifacts.length, 'Duplicate source IDs');
  assert(Array.isArray(d.objectIds) && d.objectIds.length > 0 && d.objectIds.every(nonempty) && new Set(d.objectIds).size === d.objectIds.length, 'Unique generated object IDs are required');
  keys(d.asset, ['id', 'uri', 'sha256', 'kind', 'format', 'frame'], 'mesh asset');
  assert(nonempty(d.asset.id) && d.asset.kind === 'mesh' && d.asset.format === 'glb' && d.asset.frame === 'simforge-y-up', 'Only normalized SimForge GLB meshes are supported');
  keys(d.placement, ['position', 'headingRad', 'groundOffsetM'], 'placement');
  assert(Array.isArray(d.placement.position) && d.placement.position.length === 3 && d.placement.position.every(Number.isFinite) && d.placement.headingRad === 0, 'Invalid generated placement');
  assert(Number.isFinite(d.placement.groundOffsetM) && Math.abs(d.placement.groundOffsetM) <= 0.05, 'Generated static geometry must be grounded within 0.05m of immutable source ground');
  keys(d.dimensions, ['l', 'w', 'h'], 'dimensions');
  assert(Object.values(d.dimensions).every(value => Number.isFinite(value) && value > 0), 'Invalid generated dimensions');
  assert(exact(d.support, { motion: 'static', collision: 'planar-opaque-obb', occlusion: 'planar-opaque-obb' }), 'Unsupported generated geometry semantics');
}

async function verifyMesh(d) {
  const bytes = verifiedBytes(d.asset);
  assert(bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'glTF' && bytes.readUInt32LE(4) === 2 && bytes.readUInt32LE(8) === bytes.length && bytes.readUInt32LE(16) === 0x4e4f534a, 'Invalid GLB container');
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)));
  assert(!(json.buffers ?? []).some(row => row.uri) && !(json.images ?? []).some(row => row.uri), 'GLB must be self-contained');
  assert(!(json.animations?.length || json.skins?.length || json.extensionsRequired?.length), 'Animated, skinned or extension-required GLBs are unsupported');
  assert(!(json.meshes ?? []).some(mesh => mesh.primitives.some(primitive => primitive.targets?.length)), 'Morphing GLBs are unsupported');
  const doc = await new NodeIO().readBinary(bytes);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], point = [0, 0, 0];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const matrix = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      assert(primitive.getMode() === 4, 'Generated geometry requires triangle primitives');
      const positions = primitive.getAttribute('POSITION');
      assert(positions, 'Mesh primitive has no positions');
      for (let i = 0; i < positions.getCount(); i++) {
        positions.getElement(i, point);
        for (let axis = 0; axis < 3; axis++) {
          const value = matrix[axis] * point[0] + matrix[4 + axis] * point[1] + matrix[8 + axis] * point[2] + matrix[12 + axis];
          assert(Number.isFinite(value), 'Non-finite mesh geometry');
          min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
        }
      }
    }
  }
  const close = (a, b) => Math.abs(a - b) <= 1e-4;
  assert(close(min[1], 0) && close(min[0] + max[0], 0) && close(min[2] + max[2], 0), 'Generated mesh must be footprint-centered with lowest Y=0');
  assert(close(max[0] - min[0], d.dimensions.l) && close(max[2] - min[2], d.dimensions.w) && close(max[1] - min[1], d.dimensions.h), 'Generated mesh bounds do not match descriptor dimensions');
}

/** Loads and verifies immutable descriptor, sources and self-contained normalized mesh. */
export async function loadGeometryExport(reference) {
  const descriptor = JSON.parse(verifiedBytes(reference).toString('utf8'));
  validateDescriptor(descriptor);
  await verifyMesh(descriptor);
  freeze(descriptor);
  loaded.set(descriptor, freeze(structuredClone(reference)));
  return descriptor;
}

/** Build one atomic addition. No original source inventory, role or participant is mutated. */
export async function prepareStaticGeometry(program, descriptor, { roleId, intention }) {
  const reference = loaded.get(descriptor);
  assert(reference, 'Descriptor must come from loadGeometryExport in this process');
  // Reverify on use: a descriptor object is not a permanent authorization for changed files.
  assert(exact(JSON.parse(verifiedBytes(reference).toString('utf8')), descriptor), 'Descriptor changed');
  validateDescriptor(descriptor);
  verifiedBytes(descriptor.asset);
  const base = parseSituationProgram(program);
  assert(nonempty(roleId) && nonempty(intention), 'roleId and intention are required');
  assert(!base.template.roles.some(role => role.id === roleId), 'Generated geometry must add a new role');
  assert(base.source.mapId === descriptor.mapId && base.source.frame.axes === 'simforge-y-up', 'Geometry source map/frame mismatch');
  const canonicalSources = new Map();
  for (const source of descriptor.sourceArtifacts) {
    const original = base.source.artifacts.find(row => row.id === source.id)
      ?? base.source.artifacts.find(row => row.uri === source.uri && row.sha256 === source.sha256);
    assert(original && original.uri === source.uri && original.sha256 === source.sha256, `Immutable source mismatch: ${source.id}`);
    canonicalSources.set(original.id, { sourceId: original.id, sha256: original.sha256 });
  }
  const d = descriptor;
  const catalogId = `gallery.generated.${d.asset.sha256}`;
  const catalogEntry = parseExternalCatalogEntries([{ id: catalogId, label: intention, class: 'occluder', actorClass: 'static_object', description: intention,
    dims: d.dimensions, tags: ['occlusion:high'], defaultParams: {}, model: { kind: 'glb', url: d.asset.uri, contentHash: d.asset.sha256 } }])[0];
  const patchId = `generated:${contentHash({ descriptor: reference.sha256, roleId })}`;
  assert(!base.geometryPatches.some(patch => patch.id === patchId), 'Generated patch already exists');
  const assets = [{ id: d.asset.id, uri: d.asset.uri, sha256: d.asset.sha256, kind: 'mesh' }];
  const satisfiedEffects = [];
  for (const effect of ['bounds', 'collision', 'occlusion']) {
    const payload = { schema: 'simforge.static-geometry-effect/v1', effect, meshSha256: d.asset.sha256, roleId,
      placement: d.placement, dimensions: d.dimensions, support: d.support };
    const bytes = canonicalJson(payload), sha256 = sha(bytes);
    const filename = path.join(path.dirname(localPath(reference.uri)), `${effect}-${sha256}.json`);
    try { fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o444 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const asset = { id: `${effect}:${sha256}`, uri: pathToFileURL(filename).href, sha256, kind: effect };
    verifiedBytes(asset);
    assets.push(asset); satisfiedEffects.push({ effect, assetId: asset.id });
  }
  const manifest = { id: patchId, status: 'executable', sourceArtifacts: [...canonicalSources.values()], assets,
    affected: { sourceIds: [...canonicalSources.keys()], objectIds: d.objectIds, roleIds: [roleId] }, requiredEffects: ['bounds', 'collision', 'occlusion'], satisfiedEffects };
  const role = { id: roleId, kind: 'scene_absolute', actor: { class: 'static_object', catalogId, static: true, sensors: [], dims: { length: d.dimensions.l, width: d.dimensions.w, height: d.dimensions.h } },
    pose: { position: { x: d.placement.position[0], y: d.placement.position[1], z: d.placement.position[2] }, headingRad: 0 }, initialSpeedKph: 0, essentiality: 'required' };
  const participant = { roleId, intention, authority: [{ kind: 'controller', startS: 0, endS: base.template.choreography.clipSeconds }], appearance: { kind: 'mesh', sourceId: d.asset.id }, information: [] };
  const transaction = { baseRevision: base.revision, baseDigest: situationDigest(base), label: intention, templateOps: [{ type: 'addRole', role }],
    changes: { participants: [...base.participants, participant], geometryPatches: [...base.geometryPatches, manifest] },
    preserve: { roles: base.template.roles.map(row => row.id), interactions: base.template.choreography.interactions.map(row => row.id) } };
  const candidate = applySituationTransaction(base, transaction).program;
  const patch = candidate.geometryPatches.find(row => row.id === patchId);
  return freeze({ transaction, geometryBinding: { patchId, patchSha256: contentHash(patch), roleId, descriptor, catalogEntry },
    binding: { actorId: roleId, catalogId, path: localPath(d.asset.uri), sha256: d.asset.sha256, sourceId: d.asset.id,
      groundOffsetM: d.placement.groundOffsetM, placement: d.placement, geometry: { sha256: d.asset.sha256, frame: d.asset.frame, dims: d.dimensions }, descriptor: reference } });
}
