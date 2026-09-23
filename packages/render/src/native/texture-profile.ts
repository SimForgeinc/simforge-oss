import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { RenderInputFile } from '../index.js';
import { hashFile } from '../hash.js';
import { assertSafeNativeMapMemberPath, type NativeMapClosure } from './map-closure.js';

export type NativeRenderTextures = 'uastc-full' | 'bc7-512';
export class NativeTextureCapacityError extends Error {
  readonly code = 'native_texture_capacity_exceeded';
  constructor(readonly demandBytes: number, readonly budgetBytes: number, readonly capacitySource: 'assumed' | 'explicit' = 'explicit') {
    super(`native_texture_capacity_exceeded: calculated demand ${demandBytes} bytes exceeds ${capacitySource} capacity ${budgetBytes} bytes; pass nativeVramBudgetBytes to declare a different provisioned ceiling. This is a block-payload estimate, not measured driver allocation.`);
    this.name = 'NativeTextureCapacityError';
  }
}

/**
 * The device cannot hold the scene at this texture tier. Raised before the
 * service starts (seconds into the job) instead of a startup timeout minutes
 * later; not retryable when the whole device is too small.
 */
export class NativeGpuMemoryError extends Error {
  readonly code = 'native_gpu_memory_insufficient';
  readonly retryable: boolean;
  constructor(readonly demandBytes: number, readonly device: { readonly totalBytes: number; readonly freeBytes: number }, readonly renderTextures: NativeRenderTextures) {
    const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
    const advice = renderTextures === 'uastc-full'
      ? 'Render at ML quality (512 px textures, about a fifth of the texture memory) or below 720p, or on a worker with more GPU memory.'
      : 'Render on a worker with more GPU memory.';
    super(`native_gpu_memory_insufficient: not enough GPU memory for this map at ${renderTextures} quality: the scene needs about ${gb(demandBytes)} GB and this worker has ${gb(device.freeBytes)} GB free of ${gb(device.totalBytes)} GB. ${advice}`);
    this.name = 'NativeGpuMemoryError';
    this.retryable = demandBytes <= device.totalBytes;
  }
}

/**
 * Startup budget for the retained service: texture transcode/upload scales
 * with texture volume (~15 s/GB measured on an RTX 3080 box) and the sensor
 * raycast scene with map geometry; a large map at full quality otherwise hit
 * a flat 300 s timeout after its textures were already resident.
 */
export function nativeStartupTimeoutMs(profile: { readonly textureBytes: number; readonly geometryBytes: number }): number {
  const seconds = 300 + 30 * (profile.textureBytes / 1024 ** 3) + 2 * (profile.geometryBytes / 1024 ** 2);
  return Math.round(Math.min(1800, seconds) * 1000);
}

export type NativeMapMaster = Master;
type Master = {
  buffers?: Array<{ uri?: string; byteLength: number }>;
  images?: Array<{ uri?: string; mimeType?: string }>;
  textures?: Array<{ source?: number; extensions?: { KHR_texture_basisu?: { source: number } } }>;
};
type Variant = { schemaVersion: number; id: string; sourceManifestSha256: string; images: Record<string, { file: string; outputSha256: string; width: number; height: number; codec: string }> };

/** What the texture planner may read from a map closure: member digests and small JSON members. */
export interface NativeTextureMemberSource {
  /** The member's sha256, or undefined when the closure has no such member. */
  sha256(uri: string): string | undefined;
  readText(uri: string): Promise<string>;
}

export interface NativeTexturePlan {
  /** Every member the tier renders from besides `master.gltf` (manifests, variant index, images, buffers). */
  readonly members: ReadonlySet<string>;
  /** Final image uri per referenced image index (variant replacements applied). */
  readonly images: ReadonlyMap<number, string>;
  readonly variantDigest: string;
  readonly variant: boolean;
  /**
   * `uastc-full` only: why the service will transcode UASTC at load instead
   * of uploading the ingest-built `textures-full-bc7` blocks (identical
   * pixels either way); `undefined` when the GPU variant is used.
   */
  readonly transcodeAtLoad?: string;
}

/** The ingest-built full-resolution GPU-block variant of `uastc-full` (`ktx2-gpu-variant`). */
export const NATIVE_FULL_GPU_VARIANT_ID = 'textures-full-bc7';
const FULL_GPU_VARIANT_CODECS = ['bc7', 'bc5', 'bc4'];

/**
 * Selects exactly the closure members a texture tier renders from. Pure
 * over the master and the (small) manifest members, so a worker can decide
 * which members to fetch before downloading any texture: `uastc-full` never
 * needs the 512 px variants, and `bc7-512` never needs the full-size images.
 */
export async function planNativeTextureMembers(
  document: Master,
  renderTextures: NativeRenderTextures,
  source: NativeTextureMemberSource,
): Promise<NativeTexturePlan> {
  const members = new Set<string>();
  const requireMember = (uri: string) => {
    assertSafeNativeMapMemberPath(uri);
    const sha256 = source.sha256(uri);
    if (!sha256) throw new Error(`native_texture_member_missing: ${uri}`);
    members.add(uri);
    return sha256;
  };
  let variant: Variant | undefined;
  let variantDigest = '';
  if (renderTextures === 'bc7-512') {
    const manifestSha256 = requireMember('3d/manifest.json');
    requireMember('3d/variants/manifest.json');
    const manifest = JSON.parse(await source.readText('3d/variants/manifest.json')) as { sourceManifestSha256: string; variants?: Record<string, { file: string; outputSha256: string; sourceManifestSha256: string }> };
    if (manifest.sourceManifestSha256 !== manifestSha256) throw new Error('native_ml_manifest_binding_mismatch');
    const entry = manifest.variants?.['textures-512-bc7'];
    if (!entry || entry.sourceManifestSha256 !== manifestSha256) throw new Error('native_ml_texture_variant_unavailable');
    const indexUri = `3d/variants/${entry.file}`;
    const indexSha256 = requireMember(indexUri);
    if (indexSha256 !== entry.outputSha256) throw new Error('native_ml_texture_index_digest_mismatch');
    variant = JSON.parse(await source.readText(indexUri)) as Variant;
    if (variant.schemaVersion !== 1 || variant.id !== 'textures-512-bc7' || variant.sourceManifestSha256 !== manifestSha256) throw new Error('native_ml_texture_index_invalid');
    variantDigest = indexSha256;
  }
  // uastc-full: prefer the pre-transcoded blocks when ingest built them.
  let fullVariant: Variant | undefined;
  let transcodeAtLoad: string | undefined;
  if (renderTextures === 'uastc-full') {
    const manifestSha256 = source.sha256('3d/manifest.json');
    const variantsSha256 = source.sha256('3d/variants/manifest.json');
    if (!manifestSha256 || !variantsSha256) {
      transcodeAtLoad = 'closure has no texture variants';
    } else {
      const manifest = JSON.parse(await source.readText('3d/variants/manifest.json')) as { sourceManifestSha256: string; variants?: Record<string, { file: string; outputSha256: string; sourceManifestSha256: string }> };
      const entry = manifest.variants?.[NATIVE_FULL_GPU_VARIANT_ID];
      const indexUri = entry ? `3d/variants/${entry.file}` : undefined;
      if (!entry || !indexUri) transcodeAtLoad = `closure has no ${NATIVE_FULL_GPU_VARIANT_ID} variant`;
      else if (manifest.sourceManifestSha256 !== manifestSha256 || entry.sourceManifestSha256 !== manifestSha256) transcodeAtLoad = `${NATIVE_FULL_GPU_VARIANT_ID} is bound to another manifest`;
      else if (source.sha256(indexUri) !== entry.outputSha256) transcodeAtLoad = `${NATIVE_FULL_GPU_VARIANT_ID} index is missing or its digest differs`;
      else {
        const index = JSON.parse(await source.readText(indexUri)) as Variant;
        if (index.schemaVersion !== 1 || index.id !== NATIVE_FULL_GPU_VARIANT_ID || index.sourceManifestSha256 !== manifestSha256) {
          transcodeAtLoad = `${NATIVE_FULL_GPU_VARIANT_ID} index is invalid`;
        } else {
          fullVariant = index;
          members.add('3d/manifest.json');
          members.add('3d/variants/manifest.json');
          members.add(assertIndexUri(indexUri));
          variantDigest = entry.outputSha256;
        }
      }
    }
  }
  const imageIndices = new Set<number>();
  for (const texture of document.textures ?? []) {
    const index = texture.extensions?.KHR_texture_basisu?.source ?? texture.source;
    if (index !== undefined) imageIndices.add(index);
  }
  const images = new Map<number, string>();
  for (const index of imageIndices) {
    const image = document.images?.[index];
    if (!image?.uri || image.uri.startsWith('data:')) throw new Error(`native_texture_external_image_required: ${index}`);
    let uri = image.uri;
    if (variant) {
      const replacement = variant.images[`../${image.uri}`];
      if (!replacement || replacement.width > 512 || replacement.height > 512 || !['bc7', 'rgba'].includes(replacement.codec)) throw new Error(`native_ml_texture_missing_or_invalid: ${image.uri}`);
      uri = `3d/${replacement.file}`;
      const sha256 = requireMember(uri);
      if (sha256 !== replacement.outputSha256) throw new Error(`native_ml_texture_digest_mismatch: ${uri}`);
    }
    // A full GPU variant omits images that need no transcode (passthrough).
    const gpu = fullVariant?.images[`../${image.uri}`];
    if (gpu) {
      if (!FULL_GPU_VARIANT_CODECS.includes(gpu.codec)) throw new Error(`native_texture_variant_codec_invalid: ${gpu.codec} for ${image.uri}`);
      uri = `3d/${gpu.file}`;
      if (requireMember(uri) !== gpu.outputSha256) throw new Error(`native_texture_variant_digest_mismatch: ${uri}`);
    }
    requireMember(uri);
    images.set(index, uri);
  }
  for (const buffer of document.buffers ?? []) {
    if (!buffer.uri || buffer.uri.startsWith('data:')) throw new Error('native_external_geometry_required');
    requireMember(buffer.uri);
  }
  return { members, images, variantDigest, variant: variant !== undefined, ...(transcodeAtLoad ? { transcodeAtLoad } : {}) };
}

function assertIndexUri(uri: string): string {
  assertSafeNativeMapMemberPath(uri);
  return uri;
}

const KTX2_MAGIC = Buffer.from([0xab,0x4b,0x54,0x58,0x20,0x32,0x30,0xbb,0x0d,0x0a,0x1a,0x0a]);

async function readKtx2Header(file: string): Promise<Buffer> {
  const handle = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(80);
    await handle.read(header, 0, 80, 0);
    return header;
  } finally { await handle.close(); }
}

/** Device bytes of one KTX2 texture once resident (BC7/ASTC-class blocks, or RGBA8), all mips. */
export function ktx2VramBytes(header: Buffer, uri: string, variant: boolean): number {
  if (!header.subarray(0, 12).equals(KTX2_MAGIC)) throw new Error(`native_texture_ktx2_required: ${uri}`);
  const format = header.readUInt32LE(12);
  if (variant && ![145, 146, 37, 43].includes(format)) throw new Error(`native_ml_texture_format_invalid: ${format}`);
  let width = header.readUInt32LE(20), height = header.readUInt32LE(24);
  if (variant && Math.max(width, height) > 512) throw new Error(`native_ml_texture_dimensions_invalid: ${width}x${height}`);
  const levels = header.readUInt32LE(40);
  if (!width || !height || !levels || levels > 32) throw new Error('native_texture_header_invalid');
  let bytes = 0;
  for (let level = 0; level < levels; level++) {
    bytes += format === 37 || format === 43 ? width * height * 4 : Math.ceil(width / 4) * Math.ceil(height / 4) * 16;
    width = Math.max(1, width >> 1); height = Math.max(1, height >> 1);
  }
  return bytes;
}

/** Scene memory a map needs at one tier, without frame attachments (job-specific). */
export const NATIVE_SCENE_RESERVE_BYTES = 512 * 1024 ** 2;
export async function measureNativeTextureDemand(
  master: Master,
  renderTextures: NativeRenderTextures,
  source: NativeTextureMemberSource & { readonly path: (uri: string) => string },
): Promise<{ textureBytes: number; geometryBytes: number; sceneBytes: number }> {
  const document = JSON.parse(JSON.stringify(master)) as Master;
  const plan = await planNativeTextureMembers(document, renderTextures, source);
  let textureBytes = 0;
  for (const uri of new Set(plan.images.values())) textureBytes += ktx2VramBytes(await readKtx2Header(source.path(uri)), uri, plan.variant);
  const geometryBytes = (document.buffers ?? []).reduce((sum, buffer) => sum + buffer.byteLength, 0);
  return { textureBytes, geometryBytes, sceneBytes: textureBytes + geometryBytes * 2 + NATIVE_SCENE_RESERVE_BYTES };
}

export async function stageNativeTextureProfile(input: {
  closure: NativeMapClosure<RenderInputFile>;
  renderTextures: NativeRenderTextures;
  framePixels: number;
  budgetBytes?: number;
  capacityBytes?: number;
  cacheDirectory?: string;
}) {
  const capacityBytes = input.budgetBytes ?? input.capacityBytes;
  if (!Number.isSafeInteger(capacityBytes) || capacityBytes! <= 0) throw new Error('native_vram_capacity_missing');
  if (!Number.isSafeInteger(input.framePixels) || input.framePixels < 0) throw new Error('native_frame_pixels_invalid');
  const capacitySource = input.budgetBytes === undefined ? 'assumed' as const : 'explicit' as const;
  const masterInput = input.closure.members.get('master.gltf')!;
  const document = JSON.parse(await fs.readFile(masterInput.path, 'utf8')) as Master;
  const plan = await planNativeTextureMembers(document, input.renderTextures, {
    sha256: (uri) => input.closure.members.get(uri)?.sha256,
    readText: (uri) => fs.readFile(input.closure.members.get(uri)!.path, 'utf8'),
  });
  const selected = new Map<string, RenderInputFile>([...plan.members].map((uri) => [uri, input.closure.members.get(uri)!]));
  const variantDigest = plan.variantDigest;
  const identity = createHash('sha256').update(JSON.stringify([masterInput.sha256, input.renderTextures, variantDigest, [...selected].map(([uri, member]) => [uri, member.sha256])])).digest('hex');
  // Default beside the worker's blob cache (SIMFORGE_CACHE_DIR) so the staged
  // tree is hard links on the same filesystem: no copy, and it survives restarts.
  const cacheRoot = input.cacheDirectory ?? process.env.SIMFORGE_NATIVE_CACHE_DIR
    ?? (process.env.SIMFORGE_CACHE_DIR ? path.join(process.env.SIMFORGE_CACHE_DIR, 'native-textures') : undefined)
    ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache'), 'simforge', 'native-textures');
  const directory = path.join(cacheRoot, identity);
  const masterPath = path.join(directory, 'master.gltf');
  // A tree staged before (same identity: master, tier, variant and every
  // member digest) is complete once its marker exists; its measured bytes
  // ride in the marker, so a later job skips the per-file header reads and
  // links (thousands of files on a large map).
  const staged = await readStagedMarker(directory, identity);
  let textureBytes: number;
  let geometryBytes: number;
  if (staged) {
    ({ textureBytes, geometryBytes } = staged);
  } else {
    const headers = new Map<string, number>();
    const uniqueImages = [...new Set(plan.images.values())];
    await forEachConcurrent(uniqueImages, 32, async (uri) => {
      headers.set(uri, ktx2VramBytes(await readKtx2Header(selected.get(uri)!.path), uri, plan.variant));
    });
    textureBytes = 0;
    for (const uri of uniqueImages) textureBytes += headers.get(uri)!;
    for (const [index, uri] of plan.images) {
      const image = document.images![index]!;
      if (uri !== image.uri) {
        image.uri = uri;
        image.mimeType = 'image/ktx2';
      }
    }
    geometryBytes = 0;
    for (const buffer of document.buffers ?? []) geometryBytes += buffer.byteLength;
  }
  // Admission ESTIMATE: geometry upload + CPU/GPU expansion allowance, frame
  // attachments/readback, and a 512 MiB actor/lighting/driver reserve. This is
  // not a GPU allocator limit and cannot guarantee aggregate parallel VRAM.
  const estimatedBytes = textureBytes + geometryBytes * 2 + input.framePixels * 64 + NATIVE_SCENE_RESERVE_BYTES;
  if (estimatedBytes > capacityBytes!) throw new NativeTextureCapacityError(estimatedBytes, capacityBytes!, capacitySource);
  const budgetBytes = input.budgetBytes ?? estimatedBytes;
  const profile = { ...(plan.transcodeAtLoad ? { transcodeAtLoad: plan.transcodeAtLoad } : {}), masterPath, renderTextures: input.renderTextures, memberCount: selected.size + 1, textureBytes, geometryBytes, estimatedBytes, budgetBytes, capacityBytes: capacityBytes!, capacitySource, cacheKey: identity };
  if (staged) return profile;
  await fs.mkdir(directory, { recursive: true });
  await forEachConcurrent([...selected], 32, async ([uri, member]) => {
    const target = path.join(directory, uri);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try { await fs.link(member.path, target); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        // Already staged as a link to this very blob: nothing to prove again.
        const [linked, source] = await Promise.all([fs.stat(target), fs.stat(member.path)]);
        if (linked.ino === source.ino && linked.dev === source.dev) return;
        const digest = await hashFile(target);
        if (digest.sha256 !== member.sha256 || digest.sizeBytes !== member.sizeBytes) throw new Error(`native_texture_cache_digest_mismatch: ${uri}`);
      } else if (code === 'EXDEV' || code === 'EPERM') {
        // A cross-filesystem cache still publishes atomically: another env must
        // never read an unfinished copy while its sibling populates the cache.
        const temporary = await fs.mkdtemp(path.join(path.dirname(target), '.asset-'));
        try {
          const candidate = path.join(temporary, 'payload');
          await fs.copyFile(member.path, candidate);
          await fs.rename(candidate, target);
        } finally { await fs.rm(temporary, { recursive: true, force: true }); }
      } else throw error;
    }
  });
  // Never modify the read-only installed master or a hardlink to it.
  const content = JSON.stringify(document);
  const temporary = await fs.mkdtemp(path.join(directory, '.master-'));
  try {
    const candidate = path.join(temporary, 'master.gltf');
    await fs.writeFile(candidate, content);
    await fs.rename(candidate, masterPath);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  await writeStagedMarker(directory, { identity, textureBytes, geometryBytes });
  return profile;
}

const STAGED_MARKER = '.staged.json';

interface StagedMarker {
  readonly identity: string;
  readonly textureBytes: number;
  readonly geometryBytes: number;
}

async function readStagedMarker(directory: string, identity: string): Promise<StagedMarker | null> {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(directory, STAGED_MARKER), 'utf8')) as StagedMarker;
    if (marker.identity !== identity || !Number.isSafeInteger(marker.textureBytes) || !Number.isSafeInteger(marker.geometryBytes)) return null;
    await fs.access(path.join(directory, 'master.gltf'));
    return marker;
  } catch {
    return null;
  }
}

/** Written last (temp + rename): its presence means every member and the master are staged. */
async function writeStagedMarker(directory: string, marker: StagedMarker): Promise<void> {
  const temporary = path.join(directory, `${STAGED_MARKER}.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(marker));
  await fs.rename(temporary, path.join(directory, STAGED_MARKER));
}

async function forEachConcurrent<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await work(item);
    }
  }));
}
