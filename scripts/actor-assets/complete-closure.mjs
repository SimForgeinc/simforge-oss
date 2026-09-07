#!/usr/bin/env node
// Completes a verified native actor closure so every default authored catalog
// id resolves to a real model, without touching the approved members.
//
//   node scripts/actor-assets/complete-closure.mjs \
//     --base-root <cas-dir> [--base-digest <sha256>] --out <cas-dir> \
//     [--catalog <packages/asset-catalog>] [--external-root <dir>] [--report <file.json>]
//
// Inputs
//   --base-root      A content-addressed actor root as `fetch-actor-closure.mjs`
//                    lays it out: `closures/<digest>.json` + `blobs/sha256/<xx>/<sha256>`.
//                    Every member is re-hashed; the closure digest must equal
//                    the file name. Its `catalog-models.json` entries, model
//                    metadata and animations are carried over byte-for-byte.
//   --base-digest    Which closure to complete when the root holds several.
//   --catalog        The @simforge-oss/asset-catalog workspace package; must be
//                    built (`pnpm --filter @simforge-oss/asset-catalog build`).
//                    Its dist entry and its own `three` instance do the export.
//                    Defaults to `packages/asset-catalog` in this repository.
//   --external-root  Directory that resolves root-relative catalog `model.url`
//                    bindings (`/catalog/...`). Defaults to the repository root.
//
// For each `CATALOG_IDS` id absent from the base catalog:
//   - a procedural entry is built with `buildProp(id)` (catalog default
//     params) and exported to GLB with three's GLTFExporter, exactly the
//     geometry and palette materials the web viewer instantiates. Flat-shaded
//     materials get their facet normals baked, since glTF has no flatShading.
//     The group is y-up, +X forward, ground origin, so the sidecar carries
//     `yawOffsetRad: 0`, `groundOffsetM: 0`, `uniformScale: 1`.
//   - an entry bound to an external `glb` model is included only when the
//     bound file resolves locally, hashes to the declared `contentHash`, and a
//     sibling `catalog-models.json` provides its attribution and source. The
//     placeholder box `buildProp` returns for such entries is never exported.
//   - `proxy` bindings, animated bindings without local clip assets, and
//     `body-centre` entries other than the two native articulated ids
//     (`robot.delivery-4w`, `robot.wheel`, built from primitives by
//     `render-core/src/catalog.rs`) fail the run.
// The run fails unless every catalog id is either a closure model or one of
// the two articulated ids. The output digest is the sha256 of the canonical
// closure bytes; nothing is predetermined.
//
// Output: `<out>/closures/<digest>.json`, every member under
// `<out>/blobs/sha256/`, and a JSON report on stdout (also `--report`).
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CLOSURE_SCHEMA = 'simforge.actor-assets-closure/v1';
const CATALOG_MEMBER = 'catalog-models.json';
/** Built from articulated primitive parts by the retained service; never a closure model. */
const NATIVE_ARTICULATED_IDS = ['robot.delivery-4w', 'robot.wheel'];
const PROCEDURAL_SOURCE = 'asset-catalog-procedural';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function fail(message) {
  throw new Error(message);
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    if (fallback === undefined) fail(`${name} is required`);
    return fallback;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) fail(`${name} requires a value`);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function hashFile(file) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

function blobPath(root, digest) {
  return path.join(root, 'blobs', 'sha256', digest.slice(0, 2), digest);
}

async function verified(file, expected) {
  try {
    const stats = await stat(file);
    if (!stats.isFile() || stats.size !== expected.bytes) return false;
  } catch {
    return false;
  }
  const actual = await hashFile(file);
  return actual.sha256 === expected.sha256;
}

async function placeBytes(destination, bytes) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o644 });
  await rename(temporary, destination);
}

async function placeFile(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await rm(temporary, { force: true });
  try {
    await link(source, temporary);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await copyFile(source, temporary);
  }
  await rename(temporary, destination);
}

/** Puts a member's bytes into the output CAS unless an identical blob is already there. */
async function ensureBlob(outputRoot, member, provide) {
  const destination = blobPath(outputRoot, member.sha256);
  if (await verified(destination, member)) return false;
  await provide(destination);
  if (!(await verified(destination, member))) fail(`written blob does not verify: ${destination}`);
  return true;
}

function memberPathIsSafe(memberPath) {
  const parts = memberPath.split('/');
  return parts.length > 0 && parts.every((part) => part !== '' && part !== '.' && part !== '..' && !part.includes('\\'));
}

// ------------------------------------------------------------------ base root

async function loadBase(baseRoot, requestedDigest) {
  const closuresDir = path.join(baseRoot, 'closures');
  const files = (await readdir(closuresDir).catch(() => fail(`${closuresDir} is not a closure directory`)))
    .filter((name) => /^[0-9a-f]{64}\.json$/u.test(name));
  let digest = requestedDigest;
  if (!digest) {
    if (files.length !== 1) fail(`${closuresDir} holds ${files.length} closures; pass --base-digest`);
    digest = files[0].slice(0, 64);
  }
  const closureFile = path.join(closuresDir, `${digest}.json`);
  const bytes = await readFile(closureFile).catch(() => fail(`base closure not found: ${closureFile}`));
  const actual = sha256(bytes);
  if (actual !== digest) fail(`base closure ${closureFile} hashes to ${actual}, not its file name`);
  const document = JSON.parse(bytes.toString('utf8'));
  if (document.schema !== CLOSURE_SCHEMA || !document.members || typeof document.members !== 'object' || Array.isArray(document.members)) {
    fail(`${closureFile} is not a ${CLOSURE_SCHEMA} document`);
  }
  const members = new Map();
  for (const [memberPath, member] of Object.entries(document.members)) {
    if (!memberPathIsSafe(memberPath)) fail(`unsafe member path in base closure: ${memberPath}`);
    if (typeof member?.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(member.sha256) || !Number.isInteger(member?.bytes) || member.bytes < 0) {
      fail(`base closure member ${memberPath} lacks a sha256/bytes identity`);
    }
    const file = blobPath(baseRoot, member.sha256);
    if (!(await verified(file, member))) fail(`base member ${memberPath} does not verify at ${file}`);
    members.set(memberPath, { sha256: member.sha256, bytes: member.bytes, file });
  }
  const catalogMember = members.get(CATALOG_MEMBER) ?? fail(`base closure ${digest} lacks ${CATALOG_MEMBER}`);
  const catalog = JSON.parse(await readFile(catalogMember.file, 'utf8'));
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog) || 'models' in catalog || 'entries' in catalog) {
    fail(`${CATALOG_MEMBER} in base closure ${digest} is not a flat catalog-id table`);
  }
  for (const [catalogId, entry] of Object.entries(catalog)) {
    if (!catalogId.includes('.')) continue;
    const glbPath = entry?.model?.glbPath ?? entry?.glbPath;
    if (typeof glbPath !== 'string' || !members.has(glbPath)) fail(`base ${CATALOG_MEMBER} binds ${catalogId} to a path that is not a member: ${glbPath}`);
    for (const [name, animation] of Object.entries(entry.animations ?? {})) {
      if (typeof animation?.glbPath !== 'string' || !members.has(animation.glbPath)) fail(`base ${CATALOG_MEMBER} animation ${catalogId}/${name} is not a member`);
    }
  }
  return { digest, sizeBytes: bytes.byteLength, members, catalog };
}

// ------------------------------------------------------------- asset catalog

async function loadCatalogPackage(packageRoot) {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8').catch(() => fail(`${packageRoot} has no package.json; pass --catalog <packages/asset-catalog>`)));
  if (manifest.name !== '@simforge-oss/asset-catalog') fail(`${packageRoot} is not the asset-catalog package`);
  const entryRelative = manifest.exports?.['.']?.default ?? manifest.main;
  if (typeof entryRelative !== 'string' || !entryRelative.includes('/dist/')) fail(`${packageRoot} does not declare a built dist entry`);
  const entryFile = path.join(packageRoot, entryRelative);
  if (!(await stat(entryFile).then((stats) => stats.isFile(), () => false))) fail(`${entryFile} is missing; build @simforge-oss/asset-catalog first`);
  const entryUrl = pathToFileURL(entryFile).href;
  let catalog;
  try {
    catalog = await import(entryUrl);
  } catch (error) {
    fail(`@simforge-oss/asset-catalog dist failed to load: ${error.message}`);
  }
  for (const name of ['CATALOG_IDS', 'BUILDER_IDS', 'buildProp', 'getEntry']) {
    if (!(name in catalog)) fail(`@simforge-oss/asset-catalog does not export ${name}`);
  }

  // The exporter must share the catalog's `three` instance: resolve the
  // package the dist entry sees (its `require` entry is `build/three.cjs`)
  // and import that package's ESM build plus the addon.
  const require = createRequire(entryUrl);
  const threeRoot = path.resolve(path.dirname(require.resolve('three')), '..');
  const three = await import(pathToFileURL(path.join(threeRoot, 'build', 'three.module.js')).href);
  const { GLTFExporter } = await import(pathToFileURL(path.join(threeRoot, 'examples', 'jsm', 'exporters', 'GLTFExporter.js')).href);
  return { catalog, version: manifest.version, three, GLTFExporter, threeVersion: three.REVISION };
}

/** GLTFExporter finishes binary output through FileReader, which Node lacks. */
function installFileReader() {
  if (typeof globalThis.FileReader !== 'undefined') return;
  globalThis.FileReader = class FileReader {
    result = null;
    error = null;
    onloadend = null;
    onerror = null;
    #finish(work) {
      work.then(
        (result) => { this.result = result; this.onloadend?.(); },
        (error) => { this.error = error; (this.onerror ?? this.onloadend)?.(); },
      );
    }
    readAsArrayBuffer(blob) {
      this.#finish(blob.arrayBuffer());
    }
    readAsDataURL(blob) {
      this.#finish(blob.arrayBuffer().then((buffer) => `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`));
    }
  };
}

function measure(three, group) {
  group.updateMatrixWorld(true);
  const bounds = new three.Box3().setFromObject(group, true);
  if (bounds.isEmpty()) fail(`${group.name} has no measurable geometry`);
  const size = bounds.getSize(new three.Vector3());
  const centre = bounds.getCenter(new three.Vector3());
  return { bounds, size, centre };
}

/**
 * Proves the built group is in the y-up/+X-forward/ground-origin actor frame
 * the sidecar declares (the catalog's own dimension and grounding contract).
 */
function assertActorFrame(id, dims, { bounds, size, centre }) {
  for (const [axis, actual] of [['l', size.x], ['w', size.z], ['h', size.y]]) {
    const expected = dims[axis];
    if (!(expected > 0) || Math.abs(actual - expected) / expected > 0.1) {
      fail(`${id}: built ${axis} ${actual.toFixed(3)} m is not within 10% of catalog ${expected} m`);
    }
  }
  if (Math.abs(bounds.min.y) > 0.02) fail(`${id}: built geometry is not ground-origin (min y ${bounds.min.y.toFixed(3)} m)`);
  if (Math.abs(centre.x) > dims.l * 0.15 + 0.05 || Math.abs(centre.z) > dims.w * 0.15 + 0.05) {
    fail(`${id}: built geometry is not centred on its placement point (centre x ${centre.x.toFixed(3)}, z ${centre.z.toFixed(3)})`);
  }
}

/**
 * Makes each mesh's shading representable in glTF: flat-shaded materials
 * render facet normals in three, so their geometry is unrolled and given
 * per-face normals; smooth materials keep (or gain) vertex normals.
 */
function bakeShading(group) {
  const converted = new Map();
  group.traverse((object) => {
    if (!object.isMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    if (materials.some((material) => !material?.isMeshStandardMaterial)) {
      fail(`${group.name}: mesh ${object.name || object.uuid} uses a non-standard material, which the export cannot represent`);
    }
    const flat = materials.some((material) => material.flatShading);
    const key = `${object.geometry.uuid}:${flat ? 'flat' : 'smooth'}`;
    let geometry = converted.get(key);
    if (!geometry) {
      geometry = flat && object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
      if (flat || !geometry.getAttribute('normal')) geometry.computeVertexNormals();
      converted.set(key, geometry);
    }
    object.geometry = geometry;
  });
}

function parseGlb(bytes) {
  if (bytes.byteLength < 20 || bytes.toString('ascii', 0, 4) !== 'glTF') fail('export is not a GLB');
  const jsonLength = bytes.readUInt32LE(12);
  return JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').replace(/[\0 ]+$/u, ''));
}

async function exportProcedural({ catalog, three, GLTFExporter }, id) {
  const entry = catalog.getEntry(id);
  const group = catalog.buildProp(id);
  if (group.userData.catalogId !== id) fail(`${id}: buildProp returned a group for ${group.userData.catalogId}`);
  const measured = measure(three, group);
  assertActorFrame(id, entry.dims, measured);
  bakeShading(group);
  let meshes = 0;
  group.traverse((object) => { if (object.isMesh) meshes += 1; });
  if (meshes === 0) fail(`${id}: buildProp produced no meshes`);

  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(group, { binary: true, onlyVisible: true, trs: false, includeCustomExtensions: false });
  if (!(result instanceof ArrayBuffer)) fail(`${id}: GLTFExporter did not produce binary output`);
  const bytes = Buffer.from(result);
  const document = parseGlb(bytes);
  if (!(document.meshes?.length > 0) || !(document.nodes?.length > 0)) fail(`${id}: exported GLB carries no meshes`);
  if (document.images?.length) fail(`${id}: exported GLB embeds images, which the procedural palette never has`);
  return {
    bytes,
    meshes,
    builtBounds: { l: measured.size.x, w: measured.size.z, h: measured.size.y },
    params: group.userData.params ?? entry.defaultParams,
  };
}

// ---------------------------------------------------------- external models

async function findExternalSidecar(externalRoot, glbFile) {
  let dir = path.dirname(glbFile);
  const stop = path.resolve(externalRoot);
  for (;;) {
    const candidate = path.join(dir, CATALOG_MEMBER);
    try {
      return { dir, sidecar: JSON.parse(await readFile(candidate, 'utf8')) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (dir === stop || path.dirname(dir) === dir) return null;
    dir = path.dirname(dir);
  }
}

async function resolveExternal(externalRoot, id, binding) {
  if (binding.kind !== 'glb') fail(`${id}: catalog binds a ${binding.kind} model, which is a placeholder, not exportable geometry`);
  if (binding.animated || binding.clipAssets) fail(`${id}: animated external bindings need their clip assets in the closure; not supported by this generator`);
  if (!binding.url.startsWith('/') || binding.url.includes('..')) fail(`${id}: model url ${binding.url} is not a root-relative catalog path resolvable under --external-root`);
  const file = path.join(externalRoot, ...binding.url.slice(1).split('/'));
  const bytes = await readFile(file).catch(() => fail(`${id}: bound model ${binding.url} is not present under ${externalRoot}`));
  const digest = sha256(bytes);
  if (digest !== binding.contentHash) fail(`${id}: ${file} hashes to ${digest}, catalog declares ${binding.contentHash}`);
  const found = await findExternalSidecar(externalRoot, file) ?? fail(`${id}: no ${CATALOG_MEMBER} beside ${file} declares its attribution and source`);
  const table = found.sidecar.entries ?? found.sidecar.models ?? found.sidecar;
  const relative = path.relative(found.dir, file).split(path.sep).join('/');
  const sidecarEntry = Object.values(table).find((value) => {
    const glbPath = value?.model?.glbPath ?? value?.glbPath;
    return typeof glbPath === 'string' && (glbPath === relative || glbPath.endsWith(`/${relative}`));
  }) ?? fail(`${id}: ${path.join(found.dir, CATALOG_MEMBER)} has no entry for ${relative}`);
  const model = sidecarEntry.model ?? sidecarEntry;
  if (typeof model.attribution !== 'string' || typeof model.source !== 'string') fail(`${id}: sidecar entry for ${relative} lacks attribution/source`);
  const document = parseGlb(bytes);
  const convention = document.asset?.extras?.convention;
  return {
    bytes,
    attribution: model.attribution,
    source: model.source,
    tintable: sidecarEntry.tintable === true,
    scaleToDims: sidecarEntry.scaleToDims === true,
    convention: typeof convention === 'string' ? convention : null,
    file,
  };
}

// --------------------------------------------------------------------- main

const baseRoot = path.resolve(option('--base-root'));
const outputRoot = path.resolve(option('--out'));
const externalRoot = path.resolve(option('--external-root', REPO_ROOT));
const catalogRoot = path.resolve(option('--catalog', path.join(REPO_ROOT, 'packages', 'asset-catalog')));
const reportPath = option('--report', null);
const baseDigestOption = option('--base-digest', null);
if (baseDigestOption && !/^[0-9a-f]{64}$/u.test(baseDigestOption)) fail('--base-digest must be a lowercase sha256 hex digest');

installFileReader();
const base = await loadBase(baseRoot, baseDigestOption);
const pkg = await loadCatalogPackage(catalogRoot);
const { catalog: assetCatalog } = pkg;

const catalogIds = [...assetCatalog.CATALOG_IDS];
const builderIds = new Set(assetCatalog.BUILDER_IDS);
for (const id of NATIVE_ARTICULATED_IDS) {
  if (assetCatalog.getEntry(id).origin !== 'body-centre') fail(`${id} is expected to be a body-centre articulated component`);
}

const catalogTable = { ...base.catalog };
const members = new Map([...base.members].map(([memberPath, member]) => [memberPath, { sha256: member.sha256, bytes: member.bytes, provide: (destination) => placeFile(member.file, destination) }]));
const exportedProcedural = [];
const externalBound = [];
const preserved = catalogIds.filter((id) => id in base.catalog);

for (const id of catalogIds) {
  if (id in base.catalog || NATIVE_ARTICULATED_IDS.includes(id)) continue;
  const entry = assetCatalog.getEntry(id);
  if (entry.origin === 'body-centre') fail(`${id} is body-centre and not one of the native articulated ids ${NATIVE_ARTICULATED_IDS.join(', ')}`);
  const relative = `models/${id}/model.glb`;
  if (members.has(relative)) fail(`${relative} is already a closure member but ${CATALOG_MEMBER} does not bind ${id}`);

  if (entry.model) {
    const external = await resolveExternal(externalRoot, id, entry.model);
    members.set(relative, { sha256: sha256(external.bytes), bytes: external.bytes.byteLength, provide: (destination) => placeBytes(destination, external.bytes) });
    catalogTable[id] = {
      model: { glbPath: relative, attribution: external.attribution, source: external.source },
      tintable: external.tintable,
      scaleToDims: external.scaleToDims,
      uniformScale: entry.model.scale ?? 1,
      yawOffsetRad: entry.model.yawRad ?? 0,
      groundOffsetM: 0,
      sourceSha256: entry.model.contentHash,
      targetBounds: entry.dims,
      provenance: {
        kind: 'external-glb',
        catalogId: id,
        package: '@simforge-oss/asset-catalog',
        packageVersion: pkg.version,
        boundUrl: entry.model.url,
        contentHash: entry.model.contentHash,
        frame: external.convention ?? 'y-up, meters, +X forward, ground origin (catalog sidecar convention)',
        origin: 'ground',
        tint: external.tintable ? 'body_paint slot receives the authored tint' : 'authored materials, not tintable',
        dimensions: external.scaleToDims ? 'uniform-scaled to actor length' : 'authored metres, rendered at uniformScale',
      },
      animations: {},
    };
    externalBound.push(id);
    continue;
  }

  if (!builderIds.has(id)) fail(`${id} has neither a builder nor a model binding`);
  const exported = await exportProcedural(pkg, id);
  members.set(relative, { sha256: sha256(exported.bytes), bytes: exported.bytes.byteLength, provide: (destination) => placeBytes(destination, exported.bytes) });
  catalogTable[id] = {
    model: {
      glbPath: relative,
      attribution: `SimForge procedural catalog model (@simforge-oss/asset-catalog ${pkg.version}), buildProp("${id}") with catalog default params`,
      source: PROCEDURAL_SOURCE,
    },
    tintable: false,
    scaleToDims: false,
    uniformScale: 1,
    yawOffsetRad: 0,
    groundOffsetM: 0,
    sourceSha256: sha256(exported.bytes),
    targetBounds: entry.dims,
    builtBounds: exported.builtBounds,
    provenance: {
      kind: 'procedural',
      catalogId: id,
      package: '@simforge-oss/asset-catalog',
      packageVersion: pkg.version,
      builder: 'buildProp',
      params: exported.params,
      exporter: `THREE.GLTFExporter r${pkg.threeVersion}`,
      meshes: exported.meshes,
      flatShadingBaked: true,
      frame: 'y-up, meters, +X forward, ground origin (buildProp actor frame; yawOffsetRad 0, groundOffsetM 0)',
      origin: 'ground',
      tint: typeof exported.params.color === 'string'
        ? `paint colour ${exported.params.color} baked from defaultParams.color; not tintable`
        : 'palette materials baked; not tintable',
      dimensions: 'catalog dims are the built extents (targetBounds vs builtBounds); rendered at uniformScale 1, never scaled to actor dims',
      ...(entry.animation ? { animationProfile: entry.animation, note: 'static procedural pose; no clips exported' } : {}),
    },
    animations: {},
  };
  exportedProcedural.push(id);
}

const missing = catalogIds.filter((id) => !(id in catalogTable) && !NATIVE_ARTICULATED_IDS.includes(id));
if (missing.length > 0) fail(`catalog ids without a closure model or native articulated support: ${missing.join(', ')}`);

const catalogBytes = Buffer.from(`${JSON.stringify(Object.fromEntries(Object.keys(catalogTable).sort().map((key) => [key, catalogTable[key]])), null, 2)}\n`);
members.set(CATALOG_MEMBER, { sha256: sha256(catalogBytes), bytes: catalogBytes.byteLength, provide: (destination) => placeBytes(destination, catalogBytes) });

const closureMembers = {};
for (const memberPath of [...members.keys()].sort((left, right) => left.localeCompare(right))) {
  const member = members.get(memberPath);
  closureMembers[memberPath] = { sha256: member.sha256, bytes: member.bytes };
}
const closureBytes = Buffer.from(canonical({ schema: CLOSURE_SCHEMA, members: closureMembers }));
const digest = sha256(closureBytes);

let written = 0;
for (const member of members.values()) {
  if (await ensureBlob(outputRoot, member, member.provide)) written += 1;
}
const closureFile = path.join(outputRoot, 'closures', `${digest}.json`);
if (!(await verified(closureFile, { sha256: digest, bytes: closureBytes.byteLength }))) {
  await placeBytes(closureFile, closureBytes);
  written += 1;
}

const report = {
  digest,
  sizeBytes: closureBytes.byteLength,
  closure: closureFile,
  out: outputRoot,
  members: Object.keys(closureMembers).length,
  bytes: Object.values(closureMembers).reduce((sum, member) => sum + member.bytes, 0),
  blobsWritten: written,
  base: { digest: base.digest, sizeBytes: base.sizeBytes, members: base.members.size, catalogIds: Object.keys(base.catalog).length },
  catalogPackage: { name: '@simforge-oss/asset-catalog', version: pkg.version, three: pkg.threeVersion },
  coverage: {
    catalogIds: catalogIds.length,
    modelled: catalogIds.filter((id) => id in catalogTable).length,
    preserved,
    exportedProcedural,
    externalBound,
    nativeArticulated: NATIVE_ARTICULATED_IDS,
  },
  missing,
};
const reportBytes = `${JSON.stringify(report, null, 2)}\n`;
if (reportPath) await writeFile(path.resolve(reportPath), reportBytes);
process.stdout.write(reportBytes);
