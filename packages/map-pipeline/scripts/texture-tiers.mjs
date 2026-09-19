import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { read as readKtx2 } from 'three/addons/libs/ktx-parse.module.js';
import { selectKtx2MipLevels, ktx2MipInfo } from '@simforge-oss/maps/ktx2';

export const TEXTURE_TIERS_REVISION = 'texture-tiers-v1-ktx-4.4.2-zstd9';
export const TEXTURE_VARIANTS = ['textures-256-uastc', 'textures-512-uastc', 'textures-512-bc7', 'textures-512-astc'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const exec = promisify(execFile);
const arrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const serialize = value => Buffer.from(`${JSON.stringify(value)}\n`);

async function atomicWrite(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, bytes);
  await rename(temporary, file);
}

async function assertHeadroom(directory) {
  const { bavail, bsize } = await statfs(directory);
  if (bavail * bsize < 25e9) throw new Error('Texture derivatives require at least 25 GB of free disk space');
}

/** Read only the GLB JSON chunk, not hundreds of megabytes of vegetation vertices. */
async function imageUris(file) {
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(20);
    if ((await handle.read(header, 0, 20, 0)).bytesRead !== 20 || header.readUInt32LE(0) !== 0x46546c67
      || header.readUInt32LE(4) !== 2 || header.readUInt32LE(16) !== 0x4e4f534a) throw new Error(`Invalid GLB: ${file}`);
    const length = header.readUInt32LE(12);
    if (length > 128e6) throw new Error(`Unreasonable GLB JSON chunk: ${file}`);
    const bytes = Buffer.alloc(length);
    if ((await handle.read(bytes, 0, length, 20)).bytesRead !== length) throw new Error(`Truncated GLB: ${file}`);
    const json = JSON.parse(bytes.toString('utf8').trim());
    return (json.images ?? []).map(image => {
      if (typeof image.uri !== 'string' || !image.uri.endsWith('.ktx2')) throw new Error(`Texture tiers require external KTX2 images: ${file}`);
      return image.uri;
    });
  } finally { await handle.close(); }
}

function verifySlice(source, output) {
  const input = readKtx2(new Uint8Array(source));
  const sliced = readKtx2(new Uint8Array(output));
  const first = input.levels.length - sliced.levels.length;
  if (first < 0 || sliced.pixelWidth !== Math.max(1, input.pixelWidth >> first)
    || sliced.pixelHeight !== Math.max(1, input.pixelHeight >> first)) throw new Error('Invalid sliced KTX2 level index');
  for (let index = 0; index < sliced.levels.length; index++) {
    const before = input.levels[index + first];
    const after = sliced.levels[index];
    if (before.uncompressedByteLength !== after.uncompressedByteLength
      || !Buffer.from(before.levelData).equals(Buffer.from(after.levelData))) throw new Error('KTX2 slice changed an authored mip payload');
  }
}

/**
 * One producer for pipeline publishes and retrofit CLI. sourceRoot is the map
 * root (contains 3d/manifest.json and images/); outputRoot may be a separate
 * additive overlay. It never modifies source images, GLBs or the source manifest.
 */
export async function buildTextureTiers({ sourceRoot, outputRoot = sourceRoot, ktxBin,
  variants = TEXTURE_VARIANTS, concurrency = 2 } = {}) {
  sourceRoot = await realpath(sourceRoot);
  outputRoot = path.resolve(outputRoot);
  const protectedRoot = path.join(os.homedir(), '.local/share/simforge/maps');
  // Check the existing ancestor before mkdir, including aliases into an
  // installed map. Refusing after mkdir would already violate read-only input.
  let ancestor = outputRoot;
  for (;;) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  const protectedRealRoot = await realpath(protectedRoot).catch(error => {
    if (error.code === 'ENOENT') return protectedRoot;
    throw error;
  });
  if (outputRoot === protectedRoot || outputRoot.startsWith(`${protectedRoot}${path.sep}`)
    || ancestor === protectedRealRoot || ancestor.startsWith(`${protectedRealRoot}${path.sep}`)) {
    throw new Error('Installed maps are immutable; choose a separate --output-root for additive derivatives');
  }
  await mkdir(outputRoot, { recursive: true });
  outputRoot = await realpath(outputRoot);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Texture transcode concurrency must be 1..8');
  if (!variants.length || variants.some(id => !TEXTURE_VARIANTS.includes(id))) throw new Error('Unknown texture variant');
  await assertHeadroom(outputRoot);
  const started = performance.now();
  const manifestBytes = await readFile(path.join(sourceRoot, '3d/manifest.json'));
  const sourceManifestSha256 = sha256(manifestBytes);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const variantRoot = path.join(outputRoot, '3d/variants');
  const manifestFile = path.join(variantRoot, 'manifest.json');
  let existing = { schemaVersion: 1, sourceManifestSha256, variants: {} };
  try { existing = JSON.parse(await readFile(manifestFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (outputRoot !== sourceRoot) {
    try {
      const sourceEnvelope = JSON.parse(await readFile(path.join(sourceRoot, '3d/variants/manifest.json'), 'utf8'));
      if (sourceEnvelope.sourceManifestSha256 !== sourceManifestSha256) throw new Error('Source derivatives target another map manifest');
      existing.variants = { ...sourceEnvelope.variants, ...existing.variants };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (existing.schemaVersion !== 1 || existing.sourceManifestSha256 !== sourceManifestSha256) throw new Error('Derivative source manifest changed; refusing mixed generations');
  const sources = new Set((manifest.staticLayers ?? []).map(layer => layer.file));
  for (const tile of [...(manifest.tiles ?? []), ...(manifest.vegetationTiles ?? [])]) {
    for (const lod of tile.lods ?? []) if (lod.file.endsWith('.glb')) sources.add(lod.file);
  }
  const assets = {};
  for (const file of [...sources].sort()) {
    if (!file.endsWith('.glb') || path.isAbsolute(file) || file.split('/').includes('..')) throw new Error(`Invalid scene member ${file}`);
    assets[file] = { images: [...new Set((await imageUris(path.join(sourceRoot, '3d', file)))
      .map(uri => path.posix.normalize(path.posix.join(path.posix.dirname(file), uri))))].sort() };
  }
  const imageFiles = (await readdir(path.join(sourceRoot, 'images'))).filter(file => file.endsWith('.ktx2')).sort();
  const available = new Set(imageFiles.map(file => `../images/${file}`));
  for (const asset of Object.values(assets)) for (const image of asset.images) {
    if (!available.has(image)) throw new Error(`Missing image ${image}`);
  }
  const reports = {};
  const payloads = {};
  const previousImages = {};
  for (const id of variants) {
    reports[id] = { images: 0, bytes: 0, residentBytes: 0, rgbaImages: 0, producedObjects: 0, reusedObjects: 0 };
    payloads[id] = { schemaVersion: 1, id, codec: id.split('-')[2], longestEdgePx: Number(id.split('-')[1]), sourceManifestSha256, images: {}, assets };
    const reference = existing.variants[id];
    if (reference) {
      const bytes = await readFile(path.join(variantRoot, reference.file));
      if (sha256(bytes) !== reference.outputSha256) throw new Error(`Corrupt derivative index ${id}`);
      previousImages[id] = JSON.parse(bytes).images;
    }
  }
  ktxBin ??= path.join(process.env.SIMFORGE_KTX_BIN_DIR ?? path.join(os.homedir(), 'simforge-assets/tools/KTX-Software-4.4.2-Linux-x86_64/bin'), 'ktx');
  if (variants.some(id => /-(bc7|astc)$/.test(id))) {
    const { stdout } = await exec(ktxBin, ['--version']);
    if (!stdout.includes('4.4.2')) throw new Error(`Texture tier transcodes require KTX-Software 4.4.2, got ${stdout.trim()}`);
  }
  await mkdir(path.join(variantRoot, 'objects'), { recursive: true });
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
    for (;;) {
      const index = cursor++;
      if (index >= imageFiles.length) break;
      if (index % 128 === 0) await assertHeadroom(outputRoot);
      const sourceFile = imageFiles[index];
      const sourceKey = `../images/${sourceFile}`;
      const source = arrayBuffer(await readFile(path.join(sourceRoot, 'images', sourceFile)));
      const sourceSha256 = sha256(new Uint8Array(source));
      const authored = ktx2MipInfo(source);
      const slices = new Map();
      for (const id of variants) {
        const report = reports[id];
        const payload = payloads[id];
        const previous = previousImages[id]?.[sourceKey];
        let image;
        if (previous?.sourceSha256 === sourceSha256 && previous.revision === TEXTURE_TIERS_REVISION) {
          const object = await readFile(path.join(outputRoot, '3d', previous.file));
          if (sha256(object) !== previous.outputSha256) throw new Error(`Corrupt immutable texture object ${previous.file}`);
          image = previous;
          report.reusedObjects++;
        } else {
          let selected = slices.get(payload.longestEdgePx);
          if (!selected) {
            selected = selectKtx2MipLevels(source, payload.longestEdgePx);
            verifySlice(source, selected.buffer);
            slices.set(payload.longestEdgePx, selected);
          }
          let output = Buffer.from(selected.buffer);
          let codec = payload.codec;
          if (codec !== 'uastc') {
            if (selected.forceRgba) codec = 'rgba';
            const temporary = path.join(variantRoot, `.transcode-${process.pid}-${worker}`);
            try {
              await writeFile(`${temporary}.in.ktx2`, output);
              await exec(ktxBin, ['transcode', '--target', codec === 'rgba' ? 'rgba8' : codec, '--zstd', '9',
                `${temporary}.in.ktx2`, `${temporary}.out.ktx2`], { maxBuffer: 1024 * 1024 });
              output = await readFile(`${temporary}.out.ktx2`);
            } finally {
              await Promise.all([rm(`${temporary}.in.ktx2`, { force: true }), rm(`${temporary}.out.ktx2`, { force: true })]);
            }
          }
          const info = ktx2MipInfo(arrayBuffer(output));
          if (info.supercompressionScheme !== 2 || Math.max(info.width, info.height) > payload.longestEdgePx) throw new Error(`Invalid texture tier output ${id}/${sourceFile}`);
          if ((codec === 'bc7' || codec === 'astc') && (info.width % 4 || info.height % 4)) throw new Error(`Illegal native texture base ${id}/${sourceFile}`);
          const outputSha256 = sha256(output);
          const file = `variants/objects/${outputSha256}.ktx2`;
          const objectPath = path.join(outputRoot, '3d', file);
          try {
            const stored = await readFile(objectPath);
            if (!stored.equals(output)) throw new Error(`Immutable object collision ${file}`);
            report.reusedObjects++;
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await atomicWrite(objectPath, output);
            report.producedObjects++;
          }
          // Basis NPOT tails use RGBA at runtime, so budget their real allocation.
          let residentBytes = info.residentBytes;
          if (codec === 'uastc' && selected.forceRgba) {
            residentBytes = 0;
            for (let level = 0; level < info.levels; level++) residentBytes += Math.max(1, info.width >> level) * Math.max(1, info.height >> level) * 4;
          }
          image = { file, sourceSha256, outputSha256, bytes: output.length, width: info.width, height: info.height,
            sourceWidth: authored.width, sourceHeight: authored.height,
            levels: info.levels, residentBytes, codec, revision: TEXTURE_TIERS_REVISION };
        }
        payload.images[sourceKey] = image;
        report.images++;
        report.bytes += image.bytes;
        report.residentBytes += image.residentBytes;
        if (image.codec === 'rgba') report.rgbaImages++;
      }
    }
  }));
  for (const id of variants) {
    const payload = payloads[id];
    payload.images = Object.fromEntries(Object.entries(payload.images).sort(([a], [b]) => a.localeCompare(b)));
    const bytes = serialize(payload);
    const outputSha256 = sha256(bytes);
    const file = `${id}-${outputSha256}.json`;
    await atomicWrite(path.join(variantRoot, file), bytes);
    existing.variants[id] = { id, schemaVersion: 1, file, outputSha256, digest: `sha256-${outputSha256}`,
      sourceManifestSha256, bytes: bytes.length };
  }
  await atomicWrite(manifestFile, serialize(existing));
  return { sourceRoot, outputRoot, sourceManifestSha256, wallSeconds: (performance.now() - started) / 1000, variants: reports };
}
