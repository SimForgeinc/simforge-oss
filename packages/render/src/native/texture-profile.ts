import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { RenderInputFile } from '../index.js';
import { hashFile } from '../hash.js';
import { assertSafeNativeMapMemberPath, type NativeMapClosure } from './map-closure.js';
import { linkOrCopy } from './actor-assets.js';

export type NativeRenderTextures = 'uastc-full' | 'bc7-512';
export class NativeTextureCapacityError extends Error {
  readonly code = 'native_texture_capacity_exceeded';
  constructor(readonly demandBytes: number, readonly budgetBytes: number, readonly capacitySource: 'assumed' | 'explicit' = 'explicit') {
    super(`native_texture_capacity_exceeded: calculated demand ${demandBytes} bytes exceeds ${capacitySource} capacity ${budgetBytes} bytes; pass nativeVramBudgetBytes to declare a different provisioned ceiling. This is a block-payload estimate, not measured driver allocation.`);
    this.name = 'NativeTextureCapacityError';
  }
}

type Master = {
  buffers?: Array<{ uri?: string; byteLength: number }>;
  images?: Array<{ uri?: string; mimeType?: string }>;
  textures?: Array<{ source?: number; extensions?: { KHR_texture_basisu?: { source: number } } }>;
};
type Variant = { schemaVersion: number; id: string; sourceManifestSha256: string; images: Record<string, { file: string; outputSha256: string; width: number; height: number; codec: string }> };

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
  const selected = new Map<string, RenderInputFile>();
  const requireMember = (uri: string) => {
    assertSafeNativeMapMemberPath(uri);
    const member = input.closure.members.get(uri);
    if (!member) throw new Error(`native_texture_member_missing: ${uri}`);
    selected.set(uri, member);
    return member;
  };
  let variant: Variant | undefined;
  let variantDigest = '';
  if (input.renderTextures === 'bc7-512') {
    const manifestInput = requireMember('3d/manifest.json');
    const envelopeInput = requireMember('3d/variants/manifest.json');
    const manifest = JSON.parse(await fs.readFile(envelopeInput.path, 'utf8')) as { sourceManifestSha256: string; variants?: Record<string, { file: string; outputSha256: string; sourceManifestSha256: string }> };
    if (manifest.sourceManifestSha256 !== manifestInput.sha256) throw new Error('native_ml_manifest_binding_mismatch');
    const entry = manifest.variants?.['textures-512-bc7'];
    if (!entry || entry.sourceManifestSha256 !== manifestInput.sha256) throw new Error('native_ml_texture_variant_unavailable');
    const index = requireMember(`3d/variants/${entry.file}`);
    if (index.sha256 !== entry.outputSha256) throw new Error('native_ml_texture_index_digest_mismatch');
    variant = JSON.parse(await fs.readFile(index.path, 'utf8')) as Variant;
    if (variant.schemaVersion !== 1 || variant.id !== 'textures-512-bc7' || variant.sourceManifestSha256 !== manifestInput.sha256) throw new Error('native_ml_texture_index_invalid');
    variantDigest = index.sha256;
  }
  const imageIndices = new Set<number>();
  for (const texture of document.textures ?? []) {
    const index = texture.extensions?.KHR_texture_basisu?.source ?? texture.source;
    if (index !== undefined) imageIndices.add(index);
  }
  let textureBytes = 0;
  const seenImages = new Set<string>();
  for (const index of imageIndices) {
    const image = document.images?.[index];
    if (!image?.uri || image.uri.startsWith('data:')) throw new Error(`native_texture_external_image_required: ${index}`);
    if (variant) {
      const replacement = variant.images[`../${image.uri}`];
      if (!replacement || replacement.width > 512 || replacement.height > 512 || !['bc7', 'rgba'].includes(replacement.codec)) throw new Error(`native_ml_texture_missing_or_invalid: ${image.uri}`);
      const uri = `3d/${replacement.file}`;
      const member = requireMember(uri);
      if (member.sha256 !== replacement.outputSha256) throw new Error(`native_ml_texture_digest_mismatch: ${uri}`);
      image.uri = uri;
      image.mimeType = 'image/ktx2';
    }
    const member = requireMember(image.uri);
    if (seenImages.has(image.uri)) continue;
    seenImages.add(image.uri);
    const file = await fs.open(member.path, 'r');
    try {
      const header = Buffer.alloc(80);
      await file.read(header, 0, 80, 0);
      if (!header.subarray(0, 12).equals(Buffer.from([0xab,0x4b,0x54,0x58,0x20,0x32,0x30,0xbb,0x0d,0x0a,0x1a,0x0a]))) throw new Error(`native_texture_ktx2_required: ${image.uri}`);
      const format = header.readUInt32LE(12);
      if (variant && ![145, 146, 37, 43].includes(format)) throw new Error(`native_ml_texture_format_invalid: ${format}`);
      let width = header.readUInt32LE(20), height = header.readUInt32LE(24);
      if (variant && Math.max(width, height) > 512) throw new Error(`native_ml_texture_dimensions_invalid: ${width}x${height}`);
      const levels = header.readUInt32LE(40);
      if (!width || !height || !levels || levels > 32) throw new Error('native_texture_header_invalid');
      for (let level = 0; level < levels; level++) {
        textureBytes += format === 37 || format === 43 ? width * height * 4 : Math.ceil(width / 4) * Math.ceil(height / 4) * 16;
        width = Math.max(1, width >> 1); height = Math.max(1, height >> 1);
      }
    } finally { await file.close(); }
  }
  let geometryBytes = 0;
  for (const buffer of document.buffers ?? []) {
    if (!buffer.uri || buffer.uri.startsWith('data:')) throw new Error('native_external_geometry_required');
    requireMember(buffer.uri);
    geometryBytes += buffer.byteLength;
  }
  // Admission ESTIMATE: geometry upload + CPU/GPU expansion allowance, frame
  // attachments/readback, and a 512 MiB actor/lighting/driver reserve. This is
  // not a GPU allocator limit and cannot guarantee aggregate parallel VRAM.
  const estimatedBytes = textureBytes + geometryBytes * 2 + input.framePixels * 64 + 512 * 1024 ** 2;
  if (estimatedBytes > capacityBytes!) throw new NativeTextureCapacityError(estimatedBytes, capacityBytes!, capacitySource);
  const budgetBytes = input.budgetBytes ?? estimatedBytes;
  const identity = createHash('sha256').update(JSON.stringify([masterInput.sha256, input.renderTextures, variantDigest, [...selected].map(([uri, member]) => [uri, member.sha256])])).digest('hex');
  const cacheRoot = input.cacheDirectory ?? process.env.SIMFORGE_NATIVE_CACHE_DIR ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache'), 'simforge', 'native-textures');
  const directory = path.join(cacheRoot, identity);
  await fs.mkdir(directory, { recursive: true });
  for (const [uri, member] of selected) {
    const target = path.join(directory, uri);
    try { await linkOrCopy(member.path, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const digest = await hashFile(target);
      if (digest.sha256 !== member.sha256 || digest.sizeBytes !== member.sizeBytes) throw new Error(`native_texture_cache_digest_mismatch: ${uri}`);
    }
  }
  // Never modify the read-only installed master or a hardlink to it.
  const masterPath = path.join(directory, 'master.gltf');
  const content = JSON.stringify(document);
  const temporary = await fs.mkdtemp(path.join(directory, '.master-'));
  try {
    const candidate = path.join(temporary, 'master.gltf');
    await fs.writeFile(candidate, content);
    await fs.rename(candidate, masterPath);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  return { masterPath, renderTextures: input.renderTextures, memberCount: selected.size + 1, textureBytes, geometryBytes, estimatedBytes, budgetBytes, capacityBytes: capacityBytes!, capacitySource, cacheKey: identity };
}
