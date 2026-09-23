import type { MapTextureTier, TierSelection } from './types';

export type TextureVariantId = `textures-${256 | 512}-${'uastc' | 'bc7' | 'astc' | 'etc2'}`;
export type CityAssetVariantPreference = 'auto' | 'original' | 'ktx2' | 'geometry-only' | TextureVariantId;
export type CityAssetVariantId = Exclude<CityAssetVariantPreference, 'auto' | 'original'>;

export interface CityAssetVariantFile {
  file: string;
  /** Previous known-good derivative; never a textured source asset. */
  fallbackFile?: string;
  sourceSha256: string;
  outputSha256: string;
  bytes: number;
}

export interface CityAssetVariant {
  id: CityAssetVariantId;
  generatedAt: string;
  generator: { name: string; version: string; command: string };
  files: Record<string, CityAssetVariantFile>;
  runtime?: { ktx2TranscoderPath?: string; assets?: Array<{ file: string; sha256: string }> };
  /** Optional replacement for a monolithic static layer, only emitted after continuity validation. */
  staticLayers?: Array<{ id: string; files: string[]; bounds: { min: number[]; max: number[] }[] }>;
}

export interface CitySnowCoverVariantFile {
  file: string;
  sourceSha256: string;
  outputSha256: string;
  bytes: number;
  sourcePrimitives?: number;
  keptPrimitives?: number;
  excludedPrimitives?: number;
  sourceTriangles?: number;
  keptTriangles?: number;
  rejectedNonUpwardTriangles?: number;
  receiverKinds?: Record<string, { primitives: number; triangles: number }>;
  baseShellOffsetM?: number;
  elevationMode?: 'runtime-world-y';
  retainedAttributes?: string[];
}

/**
 * Optional, render-only snow receiver geometry. Unlike the selectable asset
 * variants above, this is composited with the authored asset rather than used
 * in its place.
 */
export interface CitySnowCoverVariant {
  id: 'snow-cover-v1';
  generatedAt: string;
  generator: { name: string; version: string; command: string };
  elevation: {
    mode: 'runtime-world-y';
    baseShellOffsetM: number;
    axis: [number, number, number];
    seamPolicy?: string;
  };
  files: Record<string, CitySnowCoverVariantFile>;
}

export interface CityAssetVariantManifest {
  schemaVersion: 1;
  sourceManifestSha256: string;
  variants: Partial<Record<Exclude<CityAssetVariantId, TextureVariantId>, CityAssetVariant>>
    & Partial<Record<TextureVariantId, TextureTierReference>> & {
    snowCover?: CitySnowCoverVariant;
  };
}
export interface TextureTierImage {
  file: string;
  sourceSha256: string;
  outputSha256: string;
  bytes: number;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  levels: number;
  residentBytes: number;
  codec: 'uastc' | 'bc7' | 'astc' | 'etc2' | 'rgba';
}

export interface TextureTierIndex {
  schemaVersion: 1;
  id: TextureVariantId;
  sourceManifestSha256: string;
  codec: 'uastc' | 'bc7' | 'astc' | 'etc2';
  longestEdgePx: 256 | 512;
  images: Record<string, TextureTierImage>;
  assets: Record<string, { images: string[] }>;
}

export interface TextureTierReference {
  id: TextureVariantId;
  schemaVersion: 1;
  file: string;
  outputSha256: string;
  digest: string;
  sourceManifestSha256: string;
  bytes: number;
}

export interface TextureCapabilities { bc7: boolean; astc: boolean; etc2?: boolean; maxTextureSize: number }

/** Probe the context that will actually upload the textures; no platform guessing. */
export function probeTextureCapabilities(gl: WebGLRenderingContext | WebGL2RenderingContext): TextureCapabilities {
  return {
    bc7: Boolean(gl.getExtension('EXT_texture_compression_bptc')),
    astc: Boolean(gl.getExtension('WEBGL_compressed_texture_astc')),
    etc2: Boolean(gl.getExtension('WEBGL_compressed_texture_etc')),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
  };
}

export function selectTextureTier(requested: MapTextureTier, capabilities: TextureCapabilities): TierSelection {
  if (capabilities.maxTextureSize < 256) throw new Error('This GPU cannot allocate the minimum Low texture tier (256 px)');
  const reasons: string[] = [];
  let actual = requested;
  if (actual === 'render' || actual === 'ml') {
    reasons.push(`${actual} requires the native renderer; browser selects Medium`);
    actual = 'medium';
  }
  if (actual === 'medium' && capabilities.maxTextureSize < 512) {
    actual = 'low';
    reasons.push('GPU MAX_TEXTURE_SIZE is below the Medium 512 px target');
  }
  // Every tier is cooked at ingest for each GPU family; the client uploads
  // the blocks its GPU samples natively and transcodes nothing. Only a context
  // that exposes none of them transcodes the portable UASTC tier, and says so.
  const codec = capabilities.bc7 ? 'bc7' : capabilities.astc ? 'astc' : capabilities.etc2 ? 'etc2' : 'uastc';
  if (codec === 'uastc') reasons.push('BC7, ASTC and ETC2 unavailable on this WebGL context; transcoding portable UASTC');
  const longestEdgePx = actual === 'low' ? 256 : 512;
  return { requested, actual, codec, longestEdgePx, variantId: `textures-${longestEdgePx}-${codec}`, downgradeReason: reasons.join('; ') || null };
}

export interface ResolvedSnowCoverVariant {
  file: string;
  bytes: number;
  /** Conservative decoded closed-shell estimate used before fetch/parse. */
  estimatedBytes?: number;
  baseShellOffsetM: number;
}

const MAX_SNOW_BASE_SHELL_OFFSET_M = 0.25;

/** Resolve only a validated, asset-root-relative snow derivative. */
export function resolveSnowCoverVariant(
  manifest: CityAssetVariantManifest | null,
  sourceFile: string,
): ResolvedSnowCoverVariant | null {
  const variantValue: unknown = manifest?.variants?.snowCover;
  if (!variantValue || typeof variantValue !== 'object') return null;
  const variant = variantValue as Partial<CitySnowCoverVariant>;
  const elevationValue: unknown = variant.elevation;
  if (variant.id !== 'snow-cover-v1' || !elevationValue || typeof elevationValue !== 'object') return null;
  const elevation = elevationValue as Partial<CitySnowCoverVariant['elevation']>;
  if (elevation.mode !== 'runtime-world-y' || !Array.isArray(elevation.axis) || elevation.axis.length !== 3) return null;
  const axis = elevation.axis;
  if (axis[0] !== 0 || axis[1] !== 1 || axis[2] !== 0) return null;
  if (!variant.files || typeof variant.files !== 'object') return null;
  const candidateValue: unknown = variant.files[sourceFile];
  if (!candidateValue || typeof candidateValue !== 'object') return null;
  const candidate = candidateValue as Partial<CitySnowCoverVariantFile>;
  if (!candidate || typeof candidate.file !== 'string' || !candidate.file
    || typeof candidate.bytes !== 'number' || !Number.isFinite(candidate.bytes) || candidate.bytes <= 0) return null;
  if (candidate.elevationMode !== undefined && candidate.elevationMode !== 'runtime-world-y') return null;
  const unsafePath = /^(?:[a-z]+:|\/)/i.test(candidate.file) || /(?:^|\/)\.\.(?:\/|$)/.test(candidate.file);
  if (unsafePath) return null;
  const baseShellOffsetM = candidate.baseShellOffsetM !== undefined && Number.isFinite(candidate.baseShellOffsetM)
    ? candidate.baseShellOffsetM
    : elevation.baseShellOffsetM;
  if (!Number.isFinite(baseShellOffsetM)
    || (baseShellOffsetM as number) < 0 || (baseShellOffsetM as number) > MAX_SNOW_BASE_SHELL_OFFSET_M) return null;
  const rawKeptTriangles = candidate.keptTriangles;
  const keptTriangles = Number.isFinite(rawKeptTriangles)
    ? Math.max(0, rawKeptTriangles as number)
    : 0;
  const decodedEstimate = keptTriangles * 128;
  if (!Number.isFinite(decodedEstimate)) return null;
  return {
    file: candidate.file,
    bytes: candidate.bytes as number,
    estimatedBytes: Math.max(
      candidate.bytes as number,
      decodedEstimate,
    ),
    baseShellOffsetM: baseShellOffsetM as number,
  };
}

export function allowsSourceAssetFallback(selected: CityAssetVariantId | 'original'): boolean {
  return selected === 'ktx2' || selected === 'geometry-only';
}

export function isCityAssetVariantManifest(value: unknown): value is CityAssetVariantManifest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CityAssetVariantManifest>;
  return candidate.schemaVersion === 1
    && typeof candidate.sourceManifestSha256 === 'string'
    && Boolean(candidate.variants && typeof candidate.variants === 'object');
}

export function selectAssetVariant(
  manifest: CityAssetVariantManifest | null,
  sourceFile: string,
  preference: CityAssetVariantPreference,
  options: { ktx2Ready: boolean },
): { variant: CityAssetVariantId | 'original'; file: string; fallbackFile?: string; sha256?: string } {
  if (!manifest || preference === 'original') return { variant: 'original', file: sourceFile };
  const requested: CityAssetVariantId | null = preference === 'auto'
    ? (options.ktx2Ready ? 'ktx2' : null)
    : preference;
  if (!requested || (requested === 'ktx2' && !options.ktx2Ready)) {
    return { variant: 'original', file: sourceFile };
  }
  if (requested.startsWith('textures-')) return { variant: requested, file: sourceFile };
  const candidate = (manifest.variants[requested] as CityAssetVariant | undefined)?.files[sourceFile];
  const unsafePath = (file: string): boolean => /^(?:[a-z]+:|\/)/i.test(file) || /(?:^|\/)\.\.(?:\/|$)/.test(file);
  const unsafe = candidate && unsafePath(candidate.file);
  const fallbackFile = candidate?.fallbackFile && !unsafePath(candidate.fallbackFile) ? candidate.fallbackFile : undefined;
  return candidate && !unsafe
    ? { variant: requested, file: candidate.file, fallbackFile, sha256: candidate.outputSha256 }
    : { variant: 'original', file: sourceFile };
}
