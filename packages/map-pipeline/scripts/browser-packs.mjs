import { createHash } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

/**
 * Browser map packs: the map's web closure for one texture tier, cooked at
 * ingest into a few large content-addressed chunks in streaming order.
 *
 * A browser that loads a map member by member pays a per-file cost ~2,000
 * times per map: an S3 request on a cold load (1-5 MB/s effective) and a
 * Cache Storage lookup, a Response and a promise chain on a warm one, all on
 * the main thread. A pack is read in a handful of reads instead. Its index
 * maps every member (`tiles/*.glb`, `variants/objects/*.ktx2`) to a byte range
 * of a chunk, so the client serves members from memory and never re-derives
 * anything that depends only on the map:
 *
 * - order: roads first, then city cells nearest-first from the viewer's
 *   initial focus (`initialEditorFocus`: the cell nearest the scene centre),
 *   each cell followed by the textures it is first to use; vegetation cells
 *   follow in their own chunks, so a profile without foliage never reads them;
 * - albedo classification: base-colour images whose RGB is entirely zero at
 *   the tier's base level (the viewer used to find these with a GPU readback
 *   per texture on every load) are listed in `albedoRgbMissing`.
 *
 * Geometry chunks depend only on the scene, so every tier's index points at
 * the same geometry chunk files; only texture chunks differ per tier.
 *
 * Output (additive, like texture tiers; installed maps stay immutable):
 *
 *   3d/packs/objects/<sha256>.bin        chunk, named by its digest
 *   3d/variants/browser-pack-<tier>-<sha256>.json   pack index (schema below)
 *   3d/variants/manifest.json            variants['browser-pack:<tier>'] -> index
 */
export const BROWSER_PACK_SCHEMA = 'simforge.map-browser-pack.v1';
export const BROWSER_PACK_REVISION = 'browser-pack-v1';
/** Chunks close at the first member boundary past this size. */
export const BROWSER_PACK_CHUNK_BYTES = 16 * 1024 * 1024;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const serialize = (value) => Buffer.from(`${JSON.stringify(value)}\n`);

async function atomicWrite(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, bytes);
  await rename(temporary, file);
}

async function glbJson(file) {
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(20);
    if ((await handle.read(header, 0, 20, 0)).bytesRead !== 20 || header.readUInt32LE(0) !== 0x46546c67
      || header.readUInt32LE(4) !== 2 || header.readUInt32LE(16) !== 0x4e4f534a) throw new Error(`Invalid GLB: ${file}`);
    const length = header.readUInt32LE(12);
    const bytes = Buffer.alloc(length);
    if ((await handle.read(bytes, 0, length, 20)).bytesRead !== length) throw new Error(`Truncated GLB: ${file}`);
    return JSON.parse(bytes.toString('utf8').trim());
  } finally { await handle.close(); }
}

/** Source image URIs (`../images/<x>.ktx2`, relative to 3d/) used as base colour by a GLB. */
function baseColorImages(file, json) {
  const out = new Set();
  for (const material of json.materials ?? []) {
    const index = material.pbrMetallicRoughness?.baseColorTexture?.index;
    if (index === undefined) continue;
    const texture = json.textures?.[index];
    const source = texture?.extensions?.KHR_texture_basisu?.source ?? texture?.source;
    const uri = json.images?.[source]?.uri;
    if (typeof uri === 'string') out.add(path.posix.normalize(path.posix.join(path.posix.dirname(file), uri)));
  }
  return out;
}

/** The viewer's `initialEditorFocus`: centre of the cell nearest the scene centre. */
export function initialFocus(manifest) {
  const b = manifest.scene.bounds;
  const cx = (b.min[0] + b.max[0]) / 2;
  const cz = (b.min[2] + b.max[2]) / 2;
  let best = null;
  let bestDistance = Infinity;
  for (const tile of manifest.tiles ?? []) {
    const x = (tile.bounds.min[0] + tile.bounds.max[0]) / 2;
    const z = (tile.bounds.min[2] + tile.bounds.max[2]) / 2;
    const d = (x - cx) ** 2 + (z - cz) ** 2;
    if (d < bestDistance) { bestDistance = d; best = [x, (tile.bounds.min[1] + tile.bounds.max[1]) / 2, z]; }
  }
  return best ?? [cx, (b.min[1] + b.max[1]) / 2, cz];
}

function boxDistance(bounds, point) {
  let d = 0;
  for (const axis of [0, 2]) {
    const v = point[axis];
    if (v < bounds.min[axis]) d += (bounds.min[axis] - v) ** 2;
    else if (v > bounds.max[axis]) d += (v - bounds.max[axis]) ** 2;
  }
  return Math.sqrt(d);
}

/**
 * Streaming order of scene files: the road layer, then city cells by
 * distance from the focus, then vegetation cells, coarsest level first. Ties break on
 * the file name so the order, and therefore every chunk digest, is stable.
 */
export function streamingOrder(manifest) {
  const focus = initialFocus(manifest);
  // Coarse levels first everywhere, then each finer level nearest-first: a
  // cell's coarse vegetation can be on screen before any full plant is read.
  const byDistance = (tiles) => tiles
    .flatMap((tile) => (tile.lods ?? []).map((lod) => ({ file: lod.file, distance: boxDistance(tile.bounds, focus), level: lod.level ?? 0 })))
    .sort((a, b) => b.level - a.level || a.distance - b.distance || a.file.localeCompare(b.file))
    .map((entry) => entry.file);
  return {
    focus,
    core: [...(manifest.staticLayers ?? []).map((layer) => layer.file), ...byDistance(manifest.tiles ?? [])],
    vegetation: byDistance(manifest.vegetationTiles ?? []),
  };
}

let basisModule = null;
async function basis() {
  if (basisModule) return basisModule;
  const require = createRequire(import.meta.url);
  const js = require.resolve('three/examples/jsm/libs/basis/basis_transcoder.js');
  const source = await readFile(js, 'utf8');
  // The Emscripten build declares a global BASIS factory; evaluate it as a CommonJS body.
  // eslint-disable-next-line no-new-func
  const factory = new Function('module', 'exports', 'require', '__dirname', '__filename', `${source}\nreturn BASIS;`)(
    {}, {}, require, path.dirname(js), js);
  const module = await factory({ wasmBinary: await readFile(js.replace(/\.js$/, '.wasm')) });
  module.initializeBasis();
  basisModule = module;
  return module;
}

/**
 * True when every base-level texel of a UASTC KTX2 has R = G = B = 0: an
 * albedo authored as a mask only. The viewer shades those differently; it
 * used to discover them by rendering and reading back every base-colour
 * texture on the GPU. BC7 and ASTC tiers are transcoded from this UASTC level,
 * and UASTC -> BC7/ASTC keeps an all-zero RGB block all-zero, so the answer is
 * the same for every codec built from it.
 */
export async function uastcRgbMissing(bytes) {
  const module = await basis();
  const file = new module.KTX2File(new Uint8Array(bytes));
  try {
    if (!file.isValid() || !file.isUASTC()) throw new Error('albedo classification expects a UASTC KTX2');
    if (!file.startTranscoding()) throw new Error('UASTC transcoder refused the image');
    const RGBA32 = 13;
    const size = file.getImageTranscodedSizeInBytes(0, 0, 0, RGBA32);
    const pixels = new Uint8Array(size);
    if (!file.transcodeImage(pixels, 0, 0, 0, RGBA32, 0, -1, -1)) throw new Error('UASTC transcode failed');
    for (let i = 0; i < size; i += 4) if (pixels[i] || pixels[i + 1] || pixels[i + 2]) return false;
    return true;
  } finally {
    file.close();
    file.delete();
  }
}

/** Raw RGBA8 KTX2 (the tiers' non-block-aligned fallback): classify directly. */
async function rgbaRgbMissing(bytes) {
  const { read } = await import('three/addons/libs/ktx-parse.module.js');
  const container = read(new Uint8Array(bytes));
  const level = container.levels[0];
  let data = level.levelData;
  if (container.supercompressionScheme === 2) {
    const { ZSTDDecoder } = await import('three/addons/libs/zstddec.module.js');
    const zstd = new ZSTDDecoder();
    await zstd.init();
    data = zstd.decode(data, level.uncompressedByteLength);
  }
  for (let i = 0; i < data.length; i += 4) if (data[i] || data[i + 1] || data[i + 2]) return false;
  return true;
}

async function readVariantIndex(root, reference) {
  const bytes = await readFile(path.join(root, '3d/variants', reference.file));
  if (sha256(bytes) !== reference.outputSha256) throw new Error(`Corrupt texture tier index ${reference.id}`);
  return JSON.parse(bytes.toString('utf8'));
}

/**
 * Build (or confirm) the pack of every texture tier listed in the map's
 * variant manifest. `sourceRoot` is the map root (3d/manifest.json, 3d/tiles,
 * 3d/variants); `outputRoot` may be a separate additive overlay whose
 * variants/manifest.json extends the source's (the texture-tier convention).
 */
export async function buildBrowserPacks({ sourceRoot, outputRoot = sourceRoot, tiers, chunkBytes = BROWSER_PACK_CHUNK_BYTES } = {}) {
  sourceRoot = await realpath(sourceRoot);
  outputRoot = path.resolve(outputRoot);
  const protectedRoot = path.join(os.homedir(), '.local/share/simforge/maps');
  if (outputRoot === protectedRoot || outputRoot.startsWith(`${protectedRoot}${path.sep}`)) {
    throw new Error('Installed maps are immutable; choose a separate --output-root for additive derivatives');
  }
  const started = performance.now();
  const manifestBytes = await readFile(path.join(sourceRoot, '3d/manifest.json'));
  const sourceManifestSha256 = sha256(manifestBytes);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const readMember = async (relative) => {
    for (const root of [outputRoot, sourceRoot]) {
      try { return await readFile(path.join(root, '3d', relative)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    throw new Error(`Missing pack member 3d/${relative}`);
  };
  const variantManifestFile = path.join(outputRoot, '3d/variants/manifest.json');
  let envelope;
  try { envelope = JSON.parse(await readFile(variantManifestFile, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    envelope = JSON.parse(await readFile(path.join(sourceRoot, '3d/variants/manifest.json'), 'utf8'));
  }
  if (envelope.schemaVersion !== 1 || envelope.sourceManifestSha256 !== sourceManifestSha256) {
    throw new Error('Variant manifest targets another map manifest; refusing to pack mixed generations');
  }
  const tierIds = (tiers ?? Object.keys(envelope.variants).filter((id) => /^textures-\d+-[a-z0-9]+$/.test(id))).sort();
  if (tierIds.length === 0) throw new Error('No texture tiers to pack; build texture tiers first');

  const order = streamingOrder(manifest);
  const sceneFiles = [...order.core, ...order.vegetation];
  const json = new Map();
  for (const file of sceneFiles) json.set(file, await glbJson(path.join(sourceRoot, '3d', file)));
  const albedoSources = new Set();
  for (const [file, value] of json) for (const uri of baseColorImages(file, value)) albedoSources.add(uri);

  const report = {};
  const albedoCache = new Map();
  for (const id of tierIds) {
    const reference = envelope.variants[id];
    if (!reference) throw new Error(`Texture tier ${id} is not published for this map`);
    const index = await readVariantIndex(outputRoot, reference).catch(() => readVariantIndex(sourceRoot, reference));
    if (index.sourceManifestSha256 !== sourceManifestSha256) throw new Error(`Texture tier ${id} targets another manifest`);
    // Albedo classification comes from the UASTC decode at this tier's size.
    const uastcReference = envelope.variants[`textures-${index.longestEdgePx}-uastc`];
    const uastcIndex = uastcReference ? await readVariantIndex(outputRoot, uastcReference).catch(() => readVariantIndex(sourceRoot, uastcReference)) : null;

    const chunks = [];
    const members = {};
    let current = [];
    let currentBytes = 0;
    let currentKey = null;
    const flush = async () => {
      if (current.length === 0) return;
      const bytes = Buffer.concat(current.map((entry) => entry.bytes));
      const digest = sha256(bytes);
      const file = `packs/objects/${digest}.bin`;
      const target = path.join(outputRoot, '3d', file);
      try {
        const stored = await readFile(target);
        if (!stored.equals(bytes)) throw new Error(`Immutable pack chunk collision ${file}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await atomicWrite(target, bytes);
      }
      let offset = 0;
      for (const entry of current) {
        members[entry.member] = [chunks.length, offset, entry.bytes.length];
        offset += entry.bytes.length;
      }
      chunks.push({ file, sha256: digest, bytes: bytes.length, group: currentKey.group, kind: currentKey.kind });
      current = [];
      currentBytes = 0;
    };
    const pending = new Set();
    const add = async (member, bytes, group, kind) => {
      if (members[member] || pending.has(member)) return;
      if (!currentKey || currentKey.group !== group || currentKey.kind !== kind) { await flush(); currentKey = { group, kind }; }
      current.push({ member, bytes });
      pending.add(member);
      currentBytes += bytes.length;
      if (currentBytes >= chunkBytes) await flush();
    };
    // Geometry chunks depend only on the scene, so every tier's pack shares
    // them byte for byte (one stored file per digest). Texture chunks follow
    // the same streaming order: each image goes with the first cell to use it.
    for (const [group, files] of [['core', order.core], ['vegetation', order.vegetation]]) {
      for (const file of files) await add(file, await readMember(file), group, 'geometry');
      await flush();
    }
    const albedoRgbMissing = [];
    for (const [group, files] of [['core', order.core], ['vegetation', order.vegetation]]) {
      for (const file of files) {
        const images = index.assets[file]?.images;
        if (!images) throw new Error(`Texture tier ${id} omits scene member ${file}`);
        for (const source of images) {
          const image = index.images[source];
          if (!image) throw new Error(`Texture tier ${id} omits image ${source}`);
          if (members[image.file] || pending.has(image.file)) continue;
          const bytes = await readMember(image.file);
          if (sha256(bytes) !== image.outputSha256) throw new Error(`Texture object ${image.file} does not match its tier index`);
          await add(image.file, bytes, group, 'textures');
          if (albedoSources.has(source)) {
            let missing;
            if (image.codec === 'rgba') missing = await rgbaRgbMissing(bytes);
            else {
              const uastc = uastcIndex?.images[source];
              if (!uastc) throw new Error(`Albedo classification needs textures-${index.longestEdgePx}-uastc for ${source}`);
              const key = uastc.outputSha256;
              if (!albedoCache.has(key)) {
                const uastcBytes = await readMember(uastc.file);
                albedoCache.set(key, uastc.codec === 'rgba' ? await rgbaRgbMissing(uastcBytes) : await uastcRgbMissing(uastcBytes));
              }
              missing = albedoCache.get(key);
            }
            if (missing) albedoRgbMissing.push(image.file);
          }
        }
      }
      await flush();
    }
    const payload = {
      schema: BROWSER_PACK_SCHEMA,
      revision: BROWSER_PACK_REVISION,
      id,
      sourceManifestSha256,
      tier: { id, outputSha256: reference.outputSha256 },
      focus: order.focus,
      chunks,
      members,
      albedo: { classifiedFrom: `textures-${index.longestEdgePx}-uastc`, sources: albedoSources.size, rgbMissing: albedoRgbMissing.sort() },
    };
    const bytes = serialize(payload);
    const outputSha256 = sha256(bytes);
    const file = `browser-pack-${id}-${outputSha256}.json`;
    await atomicWrite(path.join(outputRoot, '3d/variants', file), bytes);
    envelope.variants[`browser-pack:${id}`] = {
      id: `browser-pack:${id}`, schemaVersion: 1, file, outputSha256, digest: `sha256-${outputSha256}`, sourceManifestSha256, bytes: bytes.length,
    };
    report[id] = {
      chunks: chunks.length,
      coreBytes: chunks.filter((chunk) => chunk.group === 'core').reduce((sum, chunk) => sum + chunk.bytes, 0),
      vegetationBytes: chunks.filter((chunk) => chunk.group === 'vegetation').reduce((sum, chunk) => sum + chunk.bytes, 0),
      textureBytes: chunks.filter((chunk) => chunk.kind === 'textures').reduce((sum, chunk) => sum + chunk.bytes, 0),
      members: Object.keys(members).length,
      albedoRgbMissing: albedoRgbMissing.length,
    };
  }
  await atomicWrite(variantManifestFile, Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`));
  return { sourceRoot, outputRoot, sourceManifestSha256, wallSeconds: (performance.now() - started) / 1000, packs: report };
}
