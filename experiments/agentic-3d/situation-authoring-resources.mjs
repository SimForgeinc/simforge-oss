import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import * as scenario from '@simforge-oss/scenario';
import { DEV_ASSETS } from '@simforge-oss/compiler/node';
import { loadLibrary, librarySearch, resolveEngineId, ROOT, MODELS_DIR } from './asset-library.mjs';
import { WorkbenchActionSchema, InspectionCameraSchema } from './blender-client.mjs';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const assert = (condition, message) => { if (!condition) throw new Error(message); };
const fileDigests = new Map();
const statSignature = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
let fileHashBuffer;
export const fileHash = file => {
  const stat = fs.statSync(file, { bigint: true });
  assert(stat.isFile(), `Source is not a regular file: ${file}`);
  const signature = statSignature(stat);
  const cached = fileDigests.get(file);
  if (cached?.signature === signature) return cached.sha256;
  const digest = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    assert(statSignature(fs.fstatSync(fd, { bigint: true })) === signature, `Source changed before hashing: ${file}`);
    fileHashBuffer ??= Buffer.allocUnsafe(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, fileHashBuffer, 0, fileHashBuffer.length, null)) > 0) digest.update(fileHashBuffer.subarray(0, count));
    assert(statSignature(fs.fstatSync(fd, { bigint: true })) === signature, `Source changed during hashing: ${file}`);
  } finally { fs.closeSync(fd); }
  assert(statSignature(fs.statSync(file, { bigint: true })) === signature, `Source path changed during hashing: ${file}`);
  const sha256 = digest.digest('hex');
  if (fileDigests.size >= 1024) fileDigests.delete(fileDigests.keys().next().value);
  fileDigests.set(file, { signature, sha256 });
  return sha256;
};
export function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
export function pinSources(mapId, state) {
  assert(state.mapId === mapId, `Workbench map ${state.mapId} differs from requested ${mapId}`);
  assert(state.ready && !state.busy, 'Workbench must be ready and idle');
  assert(Array.isArray(state.visualOnlyPatches) && state.visualOnlyPatches.length === 0,
    'The authored-map runner requires unchanged source geometry. Undo or reset visual-only edits; they are not executable scene closure.');
  const artifacts = ['map.xodr', 'topology-index.json.gz', 'derived/topology-derived.json.gz', 'derived/locations.json.gz', 'signals.geojson.gz'].map(name => {
    const file = path.join(DEV_ASSETS, mapId, name);
    return { id: name, uri: new URL(`file://${file}`).href, sha256: fileHash(file), kind: 'map' };
  });
  assert(state.sourceArtifacts?.length > 0, 'Workbench did not expose immutable geometry sources');
  for (const row of state.sourceArtifacts) {
    assert(row.uri.startsWith('file:'), 'Only locally verifiable source files are supported');
    assert(fileHash(fileURLToPath(row.uri)) === row.sha256, `Source digest mismatch: ${row.id}`);
    const extension = path.extname(fileURLToPath(row.uri)).toLowerCase();
    const kind = extension === '.glb' ? 'mesh' : ['.hdr', '.exr', '.png', '.jpg', '.jpeg', '.webp'].includes(extension) ? 'baked' : 'map';
    artifacts.push({ id: row.id, uri: row.uri, sha256: row.sha256, kind });
  }
  return { id: `map:${mapId}`, kind: 'authored', mapId, artifacts,
    frame: { id: 'scene', axes: 'simforge-y-up', units: 'm' }, time: { origin: 0, unit: 's' },
    assumptions: ['Static imported map, not a measured dynamic scene.', 'Runtime vehicle motion is planar; edited road pixels do not establish falling physics.'] };
}
export function verifySources(source) {
  for (const row of source.artifacts) assert(fileHash(fileURLToPath(row.uri)) === row.sha256, `Pinned source changed: ${row.id}`);
}
export function resources() {
  const library = loadLibrary();
  const raw = JSON.parse(fs.readFileSync(path.join(MODELS_DIR, 'catalog-models.json'), 'utf8'));
  const catalog = raw.entries ?? raw;
  const schemas = new Map();
  return {
    search(query, limit = 8) { return (String(query).trim()
      ? librarySearch(library, query, { limit })
      : library.entries.filter(row => !row.supersededBy && row.status !== 'rejected').slice(0, limit)).map(row => ({
      ...row, sourceId: `asset:${row.id}`,
      engineId: resolveEngineId(row.id) ?? (row.id.startsWith('gallery.') ? resolveEngineId(row.id.slice(8)) : null),
      hasRenderFile: Boolean(catalog[row.id]?.model?.glbPath && fs.existsSync(path.resolve(ROOT, catalog[row.id].model.glbPath))),
    })); },
    pinAssets() {
      const digests = new Map(), artifacts = [];
      for (const entry of library.entries) {
        const engineId = resolveEngineId(entry.id) ?? (entry.id.startsWith('gallery.') ? resolveEngineId(entry.id.slice(8)) : null);
        const file = catalog[entry.id]?.model?.glbPath;
        if (!engineId || !file || entry.status === 'rejected' || entry.supersededBy) continue;
        const absolute = path.resolve(ROOT, file);
        if (!fs.existsSync(absolute)) continue;
        const real = fs.realpathSync(absolute);
        if (!digests.has(real)) digests.set(real, fileHash(real));
        artifacts.push({ id: `asset:${entry.id}`, uri: new URL(`file://${real}`).href, sha256: digests.get(real), kind: 'mesh' });
      }
      return artifacts;
    },
    bind({ actorId, libraryId, catalogId }) {
      const entry = library.entries.find(row => row.id === libraryId);
      assert(entry && !entry.supersededBy && entry.status !== 'rejected', `Unavailable library asset ${libraryId}`);
      const engineId = resolveEngineId(catalogId);
      assert(engineId === catalogId, 'catalogId must be an exact engine-legal ID');
      const direct = resolveEngineId(libraryId) ?? (libraryId.startsWith('gallery.') ? resolveEngineId(libraryId.slice(8)) : null);
      // Render-only CARLA blueprints have no semantic engine mapping in this library.
      // A caller cannot certify an arbitrary substitute by supplying another catalog ID.
      assert(direct === catalogId, `No authoritative engine mapping for ${libraryId} -> ${catalogId}; choose a catalog-backed asset`);
      const row = catalog[libraryId] ?? (libraryId.startsWith('gallery.') ? catalog[catalogId] : null);
      assert(row?.model?.glbPath, `No real render file registered for ${libraryId}; primitive fallback disabled`);
      const file = fs.realpathSync(path.resolve(ROOT, row.model.glbPath));
      assert(fs.statSync(file).isFile(), 'Asset is not a regular file');
      return { actorId, catalogId, libraryId, path: file, sha256: fileHash(file), status: entry.status, metadata: { source: entry.source, dims: entry.dims, render: entry.render, scaleToDims: row.scaleToDims } };
    },
    schema(name, pointer = '') {
      const allowed = ['SituationTransactionSchema', 'SituationProgramSchema', 'ScenarioTemplateV2Schema', 'ConditionSchema',
        'SceneAbsoluteRoleSchema', 'InteractionSchema', 'SituationParticipantSchema', 'SituationEventSchema', 'SituationConstraintSchema', 'SituationKnobSchema', 'WorkbenchActionSchema', 'InspectionCameraSchema'];
      assert(allowed.includes(name), `Choose schema ${allowed.join(', ')}`);
      if (!schemas.has(name)) schemas.set(name, name === 'WorkbenchActionSchema' ? WorkbenchActionSchema
        : name === 'InspectionCameraSchema' ? InspectionCameraSchema : z.toJSONSchema(scenario[name], { io: 'input', unrepresentable: 'any' }));
      let value = schemas.get(name);
      for (const key of pointer.split('/').filter(Boolean)) value = value?.[key.replace(/~1/g, '/').replace(/~0/g, '~')];
      assert(value !== undefined, `Unknown JSON pointer ${pointer}`);
      const text = JSON.stringify(value);
      if (text.length > 24000) {
        const branches = [];
        const scan = (node, at, depth) => {
          if (!node || typeof node !== 'object' || depth > 4) return;
          for (const union of ['anyOf', 'oneOf']) {
            (node[union] ?? []).forEach((branch, index) => {
              const discriminator = Object.entries(branch.properties ?? {}).find(([, field]) => field.const !== undefined);
              branches.push({ pointer: `${at}/${union}/${index}`, discriminator: discriminator ? { field: discriminator[0], value: discriminator[1].const } : null,
                fields: Object.keys(branch.properties ?? {}) });
            });
          }
          for (const [key, child] of Object.entries(node.properties ?? {})) scan(child, `${at}/properties/${key}`, depth + 1);
          if (node.items) scan(node.items, `${at}/items`, depth + 1);
        };
        scan(value, pointer, 0);
        return { name, pointer, keys: Object.keys(value), properties: Object.keys(value.properties ?? {}), branches,
          namedSchemas: allowed, finding: 'Large schema summarized with named branches. Select the exact discriminator pointer or a named component schema; do not scan numeric branches blindly.' };
      }
      return value;
    },
  };
}
