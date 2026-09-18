/// <reference path="./ktx-parse.d.ts" />

import type { BufferGeometry, Light, Material, Object3D, Texture, WebGLRenderer } from 'three';
import { CompressedTexture, Mesh, RGBAFormat, RGBA_S3TC_DXT1_Format } from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import {
  read as readKtx2,
  write as writeKtx2,
  VK_FORMAT_BC1_RGB_UNORM_BLOCK,
  VK_FORMAT_BC7_SRGB_BLOCK,
  VK_FORMAT_UNDEFINED,
} from 'three/addons/libs/ktx-parse.module.js';
import { AssetDownloadTracker, readResponseBufferWithProgress } from './download-progress';
import type { CityViewerOptions } from './types';

/**
 * Where the Basis transcoder (`basis_transcoder.js` + `.wasm`) is served
 * when the embedder does not say: `/basis/` at the origin root. The map web tier
 * is KTX2-only (KHR_texture_basisu is required in every cell), so the loader
 * is always configured - a missing transcoder fails the first texture load
 * loudly instead of silently rendering untextured.
 */
export const DEFAULT_KTX2_TRANSCODER_PATH = '/basis/';

export function defaultKtx2TranscoderPath(): string {
  if (typeof document !== 'undefined' && document.baseURI) return new URL(DEFAULT_KTX2_TRANSCODER_PATH, document.baseURI).href;
  return DEFAULT_KTX2_TRANSCODER_PATH;
}

/** Map illumination belongs to the viewer sun/sky and semantic luminaire pool. */
export async function parseMapGLTF(loader: GLTFLoader, buffer: ArrayBuffer, path: string): Promise<GLTF> {
  const gltf = await loader.parseAsync(buffer, path);
  for (const scene of gltf.scenes) scene.traverse(node => {
    // Do not hide the node: authored mesh children must remain renderable.
    if ((node as Light).isLight) node.layers.disableAll();
  });
  return gltf;
}

const linkedPrograms = new WeakSet<WebGLProgram>();

/** Three's compileAsync polls completion, which does not imply successful linking. */
export function assertMaterialsLinked(renderer: WebGLRenderer, materials: readonly Material[]): void {
  for (const material of materials) {
    const programs = (renderer.properties.get(material) as { programs?: Map<string, { program: WebGLProgram }> }).programs;
    if (!programs) continue;
    for (const { program } of programs.values()) {
      if (linkedPrograms.has(program)) continue;
      const gl = renderer.getContext();
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`Shader linking failed for ${material.name || material.type}: ${gl.getProgramInfoLog(program) || 'no driver log'}`);
      }
      linkedPrograms.add(program);
    }
  }
}

interface SharedTextureEntry {
  url: string;
  promise: Promise<CompressedTexture>;
  /** Decoded original; never bound to a material, only cloned. */
  texture: CompressedTexture | null;
  /** Live clones handed to parsers, one per (asset, image). */
  refs: number;
  bytes: number;
}

/**
 * One decode and one GPU upload per KTX2 URL, however many cells reference
 * it. The master externalizes every image as `images/<sha>.ktx2` and cells
 * point at it by relative URI, so a texture shared by N resident cells would
 * otherwise be fetched, transcoded and uploaded N times.
 *
 * `load` hands every requester a `clone()` of the decoded texture. Clones
 * share `.source`, and three's `WebGLTextures` keys uploads on the source,
 * so the GPU copy is one; the clone carries the requester's own sampler,
 * colour space and name (GLTFLoader assigns those after `load`). Disposing
 * a clone drops its source use; the cache disposes the original when the
 * last clone is released by [`releaseSharedTextures`].
 */
class SharedTextureCache {
  private readonly entries = new Map<string, SharedTextureEntry>();
  private readonly bySource = new WeakMap<object, SharedTextureEntry>();
  hits = 0;
  misses = 0;

  acquire(url: string, fetchTexture: () => Promise<CompressedTexture>): Promise<CompressedTexture> {
    let entry = this.entries.get(url);
    if (entry === undefined) {
      this.misses += 1;
      const created: SharedTextureEntry = { url, texture: null, refs: 0, bytes: 0, promise: undefined as unknown as Promise<CompressedTexture> };
      created.promise = fetchTexture().then((texture) => {
        created.texture = texture;
        created.bytes = compressedBytes(texture);
        this.bySource.set(texture.source, created);
        return texture;
      }, (error: unknown) => {
        if (this.entries.get(url) === created) this.entries.delete(url);
        throw error;
      });
      this.entries.set(url, created);
      entry = created;
    } else {
      this.hits += 1;
    }
    const held = entry;
    held.refs += 1;
    return held.promise.then((texture) => texture.clone() as CompressedTexture, (error: unknown) => {
      held.refs -= 1;
      throw error;
    });
  }

  entryFor(texture: Texture): SharedTextureEntry | undefined {
    return this.bySource.get(texture.source);
  }

  release(entry: SharedTextureEntry): void {
    entry.refs -= 1;
    if (entry.refs > 0) return;
    if (this.entries.get(entry.url) === entry) this.entries.delete(entry.url);
    entry.texture?.dispose();
    entry.texture = null;
  }

  stats(): { textures: number; bytes: number; refs: number; hits: number; misses: number } {
    let bytes = 0;
    let refs = 0;
    for (const entry of this.entries.values()) {
      bytes += entry.bytes;
      refs += entry.refs;
    }
    return { textures: this.entries.size, bytes, refs, hits: this.hits, misses: this.misses };
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      entry.texture?.dispose();
      entry.texture = null;
      entry.refs = 0;
    }
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

export const sharedTextures = new SharedTextureCache();

/**
 * Texture concurrency for a map's first view.
 *
 * A city tile in this dataset references ~80 separate KTX2 images, so the first
 * 350 m of Belmont is ~2100 texture files and 1.4 GB of container bytes — of
 * which `selectKtx2MipLevels` discards 97.5% unread, because only the mip
 * levels at or below the per-asset dimension budget are transcoded. What
 * time-to-ready is actually paid in is therefore the *width* of these two
 * stages, not the tile byte volume: measured on Belmont at the 350 m bound,
 * 95% of every texture's life was spent queued for a download slot, and the
 * transcoder pool was the next wall behind it.
 *
 * Neither width can run away with memory, because `maxConcurrentLoads` already
 * bounds the demand upstream: at most two tiles decode at once, so the
 * in-flight texture set is at most those tiles' images no matter how many
 * slots exist here. Measured JS heap before ready moved 530 MB -> 546 MB.
 */
const MAP_TEXTURE_DOWNLOADS = 48;
const MAP_TRANSCODER_WORKERS = Math.min(8, Math.max(2, (navigator.hardwareConcurrency ?? 4) - 2));

/**
 * Drop authored mip levels larger than `maxDimension` without decompressing or
 * resampling pixels: the first retained level becomes the new base.
 *
 * Three uploads a compressed texture as one `texStorage2D` at the base
 * dimensions and never resizes it, so a base above the renderer's
 * `MAX_TEXTURE_SIZE` is a `GL_INVALID_VALUE` followed by failed sub-image
 * uploads for every level. A cropped BC chain must keep a block-aligned base,
 * so the crop retreats to the nearest aligned level. KTX2Loader also returns a
 * `CompressedTexture` for its uncompressed RGBA output, which has no such
 * constraint.
 */
export function limitCompressedTextureMipmaps(texture: CompressedTexture, maxDimension: number): CompressedTexture {
  let first = 0;
  while (first + 1 < texture.mipmaps.length) {
    const mip = texture.mipmaps[first]!;
    if (Math.max(mip.width, mip.height) <= maxDimension) break;
    first++;

  }
  // A cropped BC chain becomes a new base level, which must remain block-aligned.
  // KTX2Loader also returns CompressedTexture for its uncompressed RGBA output.
  while (first > 0 && (texture as Texture).format !== RGBAFormat
    && (texture.mipmaps[first]!.width % 4 !== 0 || texture.mipmaps[first]!.height % 4 !== 0)) first--;
  if (first > 0) {
    texture.mipmaps = texture.mipmaps.slice(first);
    const base = texture.mipmaps[0]!;
    texture.image = { width: base.width, height: base.height };
  }
  return texture;
}

/**
 * Select the encoded mip levels to decode before any pixels are allocated.
 *
 * Returns the original buffer when every level fits; an uncropped texture is
 * decoded exactly as authored. Otherwise the container is rewritten with the
 * levels at or below `maxDimension`, so the transcoder never touches the
 * oversized levels. `forceRgba` reports a Basis image whose cropped base is not
 * block-aligned: it is not a legal BC base level, so the caller must transcode
 * the same pixels to RGBA instead. Already-BC data cannot be re-encoded and
 * keeps its nearest aligned level.
 */
export function selectKtx2MipLevels(buffer: ArrayBuffer, maxDimension: number): { buffer: ArrayBuffer; forceRgba: boolean } {
  const container = readKtx2(new Uint8Array(buffer));
  if (container.pixelDepth > 0) return { buffer, forceRgba: false };
  let first = 0;
  while (first + 1 < container.levels.length
    && Math.max(container.pixelWidth >> first, container.pixelHeight >> first) > maxDimension) first++;
  const blockAligned = () => Math.max(1, container.pixelWidth >> first) % 4 === 0
    && Math.max(1, container.pixelHeight >> first) % 4 === 0;
  if (first === 0) return { buffer, forceRgba: false };
  const rawBc = container.vkFormat >= VK_FORMAT_BC1_RGB_UNORM_BLOCK && container.vkFormat <= VK_FORMAT_BC7_SRGB_BLOCK;
  if (rawBc) {
    while (first > 0 && !blockAligned()) first--;
    if (first === 0) return { buffer, forceRgba: false };
  }
  const forceRgba = container.vkFormat === VK_FORMAT_UNDEFINED && !blockAligned();
  container.pixelWidth = Math.max(1, container.pixelWidth >> first);
  container.pixelHeight = Math.max(1, container.pixelHeight >> first);
  container.levels = container.levels.slice(first);
  container.levelCount = container.levels.length;
  if (container.globalData) {
    const imagesPerLevel = Math.max(1, container.layerCount) * container.faceCount;
    container.globalData.imageDescs = container.globalData.imageDescs.slice(first * imagesPerLevel);
  }
  return { buffer: writeKtx2(container, { keepWriter: true }).buffer as ArrayBuffer, forceRgba };
}

class SharedKTX2Loader extends KTX2Loader {
  /** Largest base level the renderer can allocate; `Infinity` until a renderer is known. */
  maxTextureDimension = Infinity;
  tracker?: AssetDownloadTracker;
  signal?: AbortSignal;
  readonly resolvedUrls = new Map<string, string>();
  private activeDownloads = 0;
  private readonly waiting: (() => void)[] = [];
  private disposeWhenIdle = false;
  private rgbaLoader: KTX2Loader | null = null;

  private disposeLoaders(): void {
    super.dispose();
    this.rgbaLoader?.dispose();
    this.rgbaLoader = null;
  }

  private parseAtLimit(buffer: ArrayBuffer, maxDimension: number, onLoad?: (texture: CompressedTexture) => void, onError?: (error: unknown) => void): void {
    const selected = selectKtx2MipLevels(buffer, maxDimension);
    if (!selected.forceRgba) {
      super.parse(selected.buffer, onLoad, onError);
      return;
    }
    if (!this.rgbaLoader) {
      this.rgbaLoader = new KTX2Loader(this.manager).setTranscoderPath(this.transcoderPath).setWorkerLimit(1);
      // NPOT cropped bases are not legal BC textures. Decode the same authored
      // mip pixels to RGBA instead; retain compression for block-aligned images.
      this.rgbaLoader.workerConfig = {
        astcSupported: false, astcHDRSupported: false, etc1Supported: false,
        etc2Supported: false, dxtSupported: false, bptcSupported: false, pvrtcSupported: false,
      };
    }
    this.rgbaLoader.parse(selected.buffer, onLoad, onError);
  }

  override parse(buffer: ArrayBuffer, onLoad?: (texture: CompressedTexture) => void, onError?: (error: unknown) => void): void {
    this.parseAtLimit(buffer, this.maxTextureDimension, onLoad, onError);
  }


  private async fetchTracked(url: string, maxDimension: number): Promise<CompressedTexture> {
    const tracker = this.tracker!;
    const sessionId = tracker.sessionId;
    const decoded = tracker.trackDecode();
    const signal = this.signal;
    if (this.activeDownloads >= MAP_TEXTURE_DOWNLOADS) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.activeDownloads++;
    try {
      signal?.throwIfAborted();
      const resolvedUrl = this.resolvedUrls.get(new URL(url, document.baseURI).href) ?? url;
      const response = await fetch(resolvedUrl, { signal, credentials: this.withCredentials ? 'include' : 'same-origin' });
      if (!response.ok) throw new Error(`downloading texture ${response.status} ${url}`);
      const buffer = await readResponseBufferWithProgress(response, tracker, undefined, sessionId);
      signal?.throwIfAborted();
      const texture = await new Promise<CompressedTexture>((resolve, reject) => this.parseAtLimit(buffer, maxDimension, resolve, reject));
      if (signal?.aborted) {
        texture.dispose();
        signal.throwIfAborted();
      }
      decoded();
      return texture;
    } catch (cause) {
      if (signal?.aborted) throw signal.reason;
      throw new Error(`downloading/decoding texture ${url} failed`, { cause });
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.activeDownloads--;
      if (this.activeDownloads === 0 && this.disposeWhenIdle) this.disposeLoaders();
    }
 
  }
  override load(
    url: string,
    onLoad: (texture: CompressedTexture) => void,
    onProgress?: (event: ProgressEvent) => void,
    onError?: (error: unknown) => void,
  ): CompressedTexture {
    // GLTFLoader only uses the onLoad texture; the synchronous return is
    // the Loader contract and never bound to a material.
    const placeholder = new CompressedTexture([], 0, 0, RGBA_S3TC_DXT1_Format);
    const maxDimension = this.maxTextureDimension;
    sharedTextures
      .acquire(`${url}|mip-limit=${maxDimension}`, async () => {
        const texture = this.tracker
          ? await this.fetchTracked(url, maxDimension)
          : await new Promise<CompressedTexture>((resolve, reject) => {
            super.load(url, resolve, onProgress, reject);
          });
        return limitCompressedTextureMipmaps(texture, maxDimension);
      })
      .then(onLoad, (error: unknown) => onError?.(error));
    return placeholder;
  }

  override dispose(): void {
    if (this.activeDownloads > 0) {
      this.disposeWhenIdle = true;
      return;
    }
    this.disposeLoaders();
  }
}

let sharedLoader: GLTFLoader | null = null;
let sharedKtx2: SharedKTX2Loader | null = null;
let sharedKtx2Path = '';
const trackedLoaders = new Map<AssetDownloadTracker, { loader: GLTFLoader; ktx2: SharedKTX2Loader; path: string; signal?: AbortSignal; maxTextureDimension: number; resolver: CityViewerOptions['resolveAssetUrls']; textureBudgetPerAsset: number }>();

export function textureDimensionForBudget(images: number, bytes: number, ceiling: number): number {
  if (images <= 0 || !Number.isFinite(bytes)) return ceiling;
  // Block-compressed maps use at most one byte/pixel plus a complete mip chain.
  const fitted = 2 ** Math.floor(Math.log2(Math.sqrt(Math.max(1, bytes) * 0.75 / images)));
  return Math.min(ceiling, Math.max(128, fitted));
}

export function trackedTextureDimension(tracker: AssetDownloadTracker): number {
  return trackedLoaders.get(tracker)?.ktx2.maxTextureDimension ?? Infinity;
}

/**
 * One GLTFLoader for the whole app.
 *
 * - meshopt decoding runs on a small worker pool (every web-tier cell is
 *   EXT_meshopt_compression, and decoding on the main thread stalls it for
 *   tens of ms).
 * - KTX2 is always wired once a renderer is known: cells carry no other
 *   image encoding. The transcoder path is the embedder's, else `/basis/`
 *   at the origin root, independent of the current application route.
 * - Compressed textures are decoded at the largest authored mip the
 *   renderer's `MAX_TEXTURE_SIZE` can hold, so a software GL (SwiftShader) or
 *   a small GPU never receives a `texStorage2D` it must reject.
 */
export function getGLTFLoader(renderer?: WebGLRenderer, ktx2TranscoderPath = '', tracker?: AssetDownloadTracker, signal?: AbortSignal, maxTextureDimension = Infinity, resolver: CityViewerOptions['resolveAssetUrls'] = null, textureBudgetPerAsset = Infinity): GLTFLoader {
  if (!sharedLoader) {
    const loader = new GLTFLoader();
    MeshoptDecoder.useWorkers(Math.min(4, Math.max(1, (navigator.hardwareConcurrency ?? 4) - 2)));
    loader.setMeshoptDecoder(MeshoptDecoder);
    sharedLoader = loader;
  }
  if (renderer && !tracker) {
    const path = ktx2TranscoderPath || defaultKtx2TranscoderPath();
    // The context's MAX_TEXTURE_SIZE; a stub renderer that reports none is unlimited.
    const maxTextureDimension = renderer.capabilities.maxTextureSize > 0 ? renderer.capabilities.maxTextureSize : Infinity;
    if (!sharedKtx2 || sharedKtx2Path !== path || sharedKtx2.maxTextureDimension !== maxTextureDimension) {
      sharedKtx2?.dispose();
      sharedKtx2 = new SharedKTX2Loader().setTranscoderPath(path).detectSupport(renderer) as SharedKTX2Loader;
      sharedKtx2.maxTextureDimension = maxTextureDimension;
      sharedKtx2Path = path;
      sharedLoader.setKTX2Loader(sharedKtx2);
    }
    sharedKtx2.maxTextureDimension = maxTextureDimension;
  }
  if (renderer && tracker) {
    const path = ktx2TranscoderPath || defaultKtx2TranscoderPath();
    let tracked = trackedLoaders.get(tracker);
    if (!tracked || tracked.path !== path || tracked.signal !== signal || tracked.maxTextureDimension !== maxTextureDimension || tracked.resolver !== resolver || tracked.textureBudgetPerAsset !== textureBudgetPerAsset) {
      tracked?.ktx2.dispose();
      const ktx2 = new SharedKTX2Loader().setTranscoderPath(path).setWorkerLimit(MAP_TRANSCODER_WORKERS).detectSupport(renderer) as SharedKTX2Loader;
      ktx2.tracker = tracker;
      ktx2.signal = signal;
      ktx2.maxTextureDimension = maxTextureDimension;
      const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2);
      loader.register(parser => ({
        name: 'SIMFORGE_asset_urls',
        beforeRoot: async () => {
          ktx2.maxTextureDimension = textureDimensionForBudget(
            parser.json.images?.length ?? 0, textureBudgetPerAsset, ktx2.maxTextureDimension,
          );
          if (!resolver || !signal) return;
          const base = new URL(parser.options.path, document.baseURI);
          const urls = [...new Set<string>((parser.json.images ?? []).flatMap((image: { uri?: string }) =>
            image.uri && !/^(data|blob):/.test(image.uri) ? [new URL(image.uri, base).href] : []))];
          if (urls.length === 0) return;
          const resolved = await resolver(urls, signal);
          signal.throwIfAborted();
          for (const [url, target] of resolved) ktx2.resolvedUrls.set(url, target);
        },
      }));
      tracked = { loader, ktx2, path, signal, maxTextureDimension, resolver, textureBudgetPerAsset };
      trackedLoaders.set(tracker, tracked);
    }
    return tracked.loader;
  }
  return sharedLoader;
}

export function disposeTrackedLoader(tracker: AssetDownloadTracker): void {
  const tracked = trackedLoaders.get(tracker);
  trackedLoaders.delete(tracker);
  tracked?.ktx2.dispose();
}

export function disposeSharedLoader(): void {
  for (const { ktx2 } of trackedLoaders.values()) ktx2.dispose();
  trackedLoaders.clear();
  sharedKtx2?.dispose();
  sharedKtx2 = null;
  sharedKtx2Path = '';
  sharedLoader = null;
  sharedTextures.clear();
}

/** Directory URL of `fileUrl`, the base GLTFLoader resolves relative image URIs against. */
export function resourceDirectory(fileUrl: string): string {
  return fileUrl.replace(/[^/]*(?:[?#].*)?$/, '');
}

export interface AssetResources {
  geometries: BufferGeometry[];
  materials: Material[];
  textures: Texture[];
}

export function collectResources(root: Object3D): AssetResources {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!(mesh as unknown as { isMesh?: boolean }).isMesh) return;
    if (mesh.geometry) geometries.add(mesh.geometry);
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat) continue;
      materials.add(mat);
      for (const value of Object.values(mat as unknown as Record<string, unknown>)) {
        const tex = value as Texture | null;
        if (tex && (tex as unknown as { isTexture?: boolean }).isTexture) textures.add(tex);
      }
    }
  });
  return {
    geometries: [...geometries],
    materials: [...materials],
    textures: [...textures],
  };
}

function compressedBytes(tex: CompressedTexture): number {
  let bytes = 0;
  for (const mip of tex.mipmaps ?? []) bytes += (mip as { data?: ArrayBufferView }).data?.byteLength ?? 0;
  return bytes;
}

function textureBytes(tex: Texture): number {
  if ((tex as CompressedTexture).isCompressedTexture) return compressedBytes(tex as CompressedTexture);
  const img = tex.image as { width?: number; height?: number } | undefined;
  const w = img?.width ?? 0;
  const h = img?.height ?? 0;
  if (!w || !h) return 0;
  const mip = tex.generateMipmaps ? 4 / 3 : 1;
  return w * h * 4 * mip;
}

function geometryBytes(geo: BufferGeometry): number {
  let bytes = 0;
  for (const attr of Object.values(geo.attributes)) {
    const a = attr as { array?: ArrayBufferView };
    bytes += a.array?.byteLength ?? 0;
  }
  if (geo.index) bytes += geo.index.array.byteLength;
  return bytes;
}

/**
 * Estimated GPU-resident bytes of an asset. Textures count once per
 * distinct source within the asset, and a source shared with other resident
 * assets through the KTX2 cache counts its fair share (bytes / holders).
 */
export function estimateResourceBytes(res: AssetResources): number {
  let bytes = 0;
  for (const geo of res.geometries) bytes += geometryBytes(geo);
  const seen = new Set<object>();
  for (const tex of res.textures) {
    if (seen.has(tex.source)) continue;
    seen.add(tex.source);
    const shared = sharedTextures.entryFor(tex);
    bytes += shared ? shared.bytes / Math.max(1, shared.refs) : textureBytes(tex);
  }
  return bytes;
}

/**
 * Push one texture to the GPU and drop the CPU-side copy.
 *
 * ImageBitmaps stay resident in the renderer process until explicitly closed,
 * so an un-closed tile would cost its texture footprint twice. Once
 * uploaded, three never reads `texture.image` again unless `needsUpdate` is set
 * (we never do for streamed assets). Compressed mip data stays with the
 * shared cache entry so a later cell can re-upload after eviction.
 */
export function uploadTexture(renderer: WebGLRenderer, tex: Texture): void {
  renderer.initTexture(tex);
  const data = tex.image as unknown;
  if (typeof ImageBitmap !== 'undefined' && data instanceof ImageBitmap) {
    data.close();
  }
}

/** Release the asset's hold on every cache-shared source, once per source. */
function releaseSharedTextures(textures: readonly Texture[]): void {
  const released = new Set<object>();
  for (const tex of textures) {
    const entry = sharedTextures.entryFor(tex);
    if (!entry || released.has(tex.source)) continue;
    released.add(tex.source);
    sharedTextures.release(entry);
  }
}

export function disposeResources(res: AssetResources): void {
  for (const geo of res.geometries) geo.dispose();
  for (const tex of res.textures) {
    const data = tex.image as unknown;
    if (typeof ImageBitmap !== 'undefined' && data instanceof ImageBitmap) data.close();
    tex.dispose();
  }
  releaseSharedTextures(res.textures);
  for (const mat of res.materials) mat.dispose();
}
