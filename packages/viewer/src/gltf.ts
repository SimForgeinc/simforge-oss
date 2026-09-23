/// <reference path="./ktx-parse.d.ts" />

import type { BufferGeometry, Light, Material, Object3D, Texture, WebGLRenderer } from 'three';
import { CompressedTexture, Mesh, RGBAFormat, RGBA_S3TC_DXT1_Format } from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { ktx2MipInfo, selectKtx2MipLevels } from '@simforge-oss/maps/ktx2';
import { AssetDownloadTracker, readResponseBufferWithProgress } from './download-progress';
import type { CityViewerOptions } from './types';
import { inspectAlbedoTexture, setIngestAlbedoClassification } from './albedo-color';
import type { MapPackReader } from './map-pack';

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

/** Bounded download/transcode width; geometry streaming bounds concurrent parsers. */
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


export interface MapTextureSource {
  url: string;
  digest: string;
  codec: 'uastc' | 'bc7' | 'astc' | 'etc2' | 'rgba';
  authoredWidth: number;
  authoredHeight: number;
}

interface FetchedContainer {
  promise: Promise<ArrayBuffer>;
  refs: number;
}

let textureLoaderIdentity = 0;

class SharedKTX2Loader extends KTX2Loader {
  maxTextureDimension = Infinity;
  tracker?: AssetDownloadTracker;
  signal?: AbortSignal;
  /** The map's browser pack: members come out of its chunks instead of one request each. */
  packReader: MapPackReader | null = null;
  readonly resolvedUrls = new Map<string, string>();
  readonly containers = new Map<string, FetchedContainer>();
  readonly telemetry = { fetchedBytes: 0, fetchedContainers: 0, containerCacheHits: 0, packedContainers: 0 };
  private activeDownloads = 0;
  private activeRequests = 0;
  private readonly cacheIdentity = ++textureLoaderIdentity;
  private readonly waiting: (() => void)[] = [];
  private disposeWhenIdle = false;
  private rgbaLoader: KTX2Loader | null = null;

  private disposeLoaders(): void {
    super.dispose();
    this.rgbaLoader?.dispose();
    this.rgbaLoader = null;
    this.containers.clear();
  }

  private parseAtLimit(buffer: ArrayBuffer, maxDimension: number, onLoad?: (texture: CompressedTexture) => void, onError?: (error: unknown) => void): void {
    const selected = selectKtx2MipLevels(buffer, maxDimension);
    // Basis workers transfer ownership. Never detach a reusable fetched container.
    const input = selected.buffer === buffer ? buffer.slice(0) : selected.buffer;
    if (!selected.forceRgba) {
      super.parse(input, onLoad, onError);
      return;
    }
    if (!this.rgbaLoader) {
      this.rgbaLoader = new KTX2Loader(this.manager).setTranscoderPath(this.transcoderPath).setWorkerLimit(1);
      this.rgbaLoader.workerConfig = {
        astcSupported: false, astcHDRSupported: false, etc1Supported: false,
        etc2Supported: false, dxtSupported: false, bptcSupported: false, pvrtcSupported: false,
      };
    }
    this.rgbaLoader.parse(input, onLoad, onError);
  }

  override parse(buffer: ArrayBuffer, onLoad?: (texture: CompressedTexture) => void, onError?: (error: unknown) => void): void {
    this.parseAtLimit(buffer, this.maxTextureDimension, onLoad, onError);
  }

  private async fetchContainer(url: string): Promise<ArrayBuffer> {
    const tracker = this.tracker;
    const sessionId = tracker?.sessionId;
    const signal = this.signal;
    if (this.activeDownloads >= MAP_TEXTURE_DOWNLOADS) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.activeDownloads++;
    try {
      signal?.throwIfAborted();
      const pack = this.packReader;
      if (pack?.has(url)) {
        const buffer = await pack.read(url, signal);
        signal?.throwIfAborted();
        this.telemetry.packedContainers++;
        return buffer;
      }
      const resolvedUrl = this.resolvedUrls.get(url) ?? url;
      const response = await fetch(resolvedUrl, { signal, credentials: this.withCredentials ? 'include' : 'same-origin' });
      if (!response.ok) throw new Error(`downloading texture ${response.status} ${url}`);
      const buffer = tracker
        ? await readResponseBufferWithProgress(response, tracker, undefined, sessionId)
        : await response.arrayBuffer();
      signal?.throwIfAborted();
      this.telemetry.fetchedContainers++;
      this.telemetry.fetchedBytes += buffer.byteLength;
      return buffer;
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.activeDownloads--;
      if (this.disposeWhenIdle && this.activeDownloads === 0 && this.activeRequests === 0) this.disposeLoaders();
    }
  }

  loadAtLimit(url: string, maxDimension: number, source: MapTextureSource | undefined,
    onLoad: (texture: CompressedTexture) => void, onError?: (error: unknown) => void): CompressedTexture {
    const placeholder = new CompressedTexture([], 0, 0, RGBA_S3TC_DXT1_Format);
    const identity = source?.digest ?? url;
    // Keep abort/lifetime ownership per worker pool; caps share fetched bytes.
    const format = `${this.cacheIdentity}|${JSON.stringify(this.workerConfig)}`;
    this.activeRequests++;
    sharedTextures.acquire(`${identity}|${format}|${maxDimension}`, async () => {
      let container = this.containers.get(identity);
      if (!container) {
        container = { promise: this.fetchContainer(url), refs: 0 };
        this.containers.set(identity, container);
      } else this.telemetry.containerCacheHits++;
      const held = container;
      held.refs++;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        held.refs--;
        if (held.refs === 0 && this.containers.get(identity) === held) this.containers.delete(identity);
      };
      try {
        const buffer = await held.promise;
        const authored = ktx2MipInfo(buffer);
        const decoded = this.tracker?.trackDecode();
        const texture = await new Promise<CompressedTexture>((resolve, reject) => this.parseAtLimit(buffer, maxDimension, resolve, reject));
        const rgbaFallbackReason = (texture as Texture).format === RGBAFormat
          ? source?.codec === 'rgba' ? 'authored-uncompressed-rgba'
            : texture.image.width % 4 !== 0 || texture.image.height % 4 !== 0
              ? 'non-block-aligned-basis-base' : 'no-supported-compressed-transcode-target'
          : undefined;
        limitCompressedTextureMipmaps(texture, maxDimension);
        // Ingest classified this image's albedo; no GPU readback is needed.
        const rgbMissing = this.packReader?.albedoRgbMissingFor(url) ?? null;
        if (rgbMissing !== null) setIngestAlbedoClassification(texture, rgbMissing);
        texture.addEventListener('dispose', release);
        texture.userData.mapTexture = {
          url, authoredWidth: source?.authoredWidth ?? authored.width, authoredHeight: source?.authoredHeight ?? authored.height,
          width: texture.image.width, height: texture.image.height, allocatedMaxDimension: maxDimension,
          rgbaFallbackReason,
        };
        decoded?.();
        if (this.signal?.aborted) {
          texture.dispose();
          this.signal.throwIfAborted();
        }
        return texture;
      } catch (error) {
        release();
        throw error;
      }
    }).then(onLoad, onError).finally(() => {
      this.activeRequests--;
      if (this.disposeWhenIdle && this.activeDownloads === 0 && this.activeRequests === 0) this.disposeLoaders();
    });
    return placeholder;
  }

  override load(url: string, onLoad: (texture: CompressedTexture) => void,
    _onProgress?: (event: ProgressEvent) => void, onError?: (error: unknown) => void): CompressedTexture {
    return this.loadAtLimit(url, this.maxTextureDimension, undefined, onLoad, onError);
  }

  override dispose(): void {
    if (this.activeDownloads > 0 || this.activeRequests > 0) {
      this.disposeWhenIdle = true;
      return;
    }
    this.disposeLoaders();
  }
}

let sharedLoader: GLTFLoader | null = null;
let sharedKtx2: SharedKTX2Loader | null = null;
let sharedKtx2Path = '';
const trackedLoaders = new Map<AssetDownloadTracker, { ktx2: SharedKTX2Loader; path: string; signal?: AbortSignal }>();

export function trackedTextureStats(tracker: AssetDownloadTracker): { fetchedBytes: number; fetchedContainers: number; containerCacheHits: number; packedContainers: number } {
  return trackedLoaders.get(tracker)?.ktx2.telemetry ?? { fetchedBytes: 0, fetchedContainers: 0, containerCacheHits: 0, packedContainers: 0 };
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
export function getGLTFLoader(renderer?: WebGLRenderer, ktx2TranscoderPath = '', tracker?: AssetDownloadTracker, signal?: AbortSignal,
  maxTextureDimension = Infinity, resolver: CityViewerOptions['resolveAssetUrls'] = null,
  textureSources: ReadonlyMap<string, MapTextureSource> = new Map(), packReader: MapPackReader | null = null): GLTFLoader {
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
    if (!tracked || tracked.path !== path || tracked.signal !== signal) {
      tracked?.ktx2.dispose();
      const ktx2 = new SharedKTX2Loader().setTranscoderPath(path).setWorkerLimit(MAP_TRANSCODER_WORKERS).detectSupport(renderer) as SharedKTX2Loader;
      ktx2.tracker = tracker;
      ktx2.signal = signal;
      tracked = { ktx2, path, signal };
      trackedLoaders.set(tracker, tracked);
    }
    const ktx2 = tracked.ktx2;
    ktx2.packReader = packReader;
    const limit = Math.min(maxTextureDimension, renderer.capabilities.maxTextureSize || Infinity);
    // Only the worker pool is shared. Every parser closes over its own cap and
    // image bindings; interleaved road/city parses cannot mutate each other.
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2);
    loader.register(parser => {
      let failure: unknown;
      const imagePromises = new Map<string, Promise<Texture>>();
      const acquiredImages = new Set<Texture>();
      const failImages = (error: unknown): void => {
        failure ??= error;
        disposeResources({ geometries: [], materials: [], textures: [...acquiredImages] });
        acquiredImages.clear();
      };
      const scoped = {
        load: (url: string, onLoad: (texture: CompressedTexture) => void, _progress: unknown, onError: (error: unknown) => void) => {
          const absolute = new URL(url, document.baseURI).href;
          const source = textureSources.get(absolute);
          return ktx2.loadAtLimit(source?.url ?? absolute, limit, source, onLoad, error => { failure = error; onError(error); });
        },
      } as unknown as KTX2Loader;
      const originalImageSource = parser.loadImageSource.bind(parser);
      parser.loadImageSource = (index, imageLoader) => {
        const image = parser.json.images[index];
        if (!image?.uri || !image.uri.endsWith('.ktx2')) return originalImageSource(index, imageLoader);
        const url = new URL(image.uri, new URL(parser.options.path, document.baseURI)).href;
        const key = textureSources.get(url)?.digest ?? url;
        const cached = imagePromises.get(key);
        if (cached) return cached.then(texture => texture.clone());
        // Three's generic image boundary prints every rejection, including
        // cancelled fetches. Map KTX sources instead propagate typed failures
        // to the asset owner, which distinguishes abort from required errors.
        const promise = new Promise<Texture>((resolve, reject) => scoped.load(url, resolve, undefined, reject))
          .then(texture => {
            if (failure) {
              disposeResources({ geometries: [], materials: [], textures: [texture] });
              throw failure;
            }
            acquiredImages.add(texture);
            if (image.extras && typeof image.extras === 'object') Object.assign(texture.userData, image.extras);
            texture.userData.mimeType = image.mimeType ?? 'image/ktx2';
            return texture;
          }).catch(error => { failImages(error); throw error; });
        imagePromises.set(key, promise);
        return promise;
      };
      return {
        name: 'SIMFORGE_map_textures',
        beforeRoot: async () => {
          parser.options.ktx2Loader = scoped;
          const base = new URL(parser.options.path, document.baseURI);
          const urls = [...new Set<string>((parser.json.images ?? []).flatMap((image: { uri?: string }) =>
            image.uri && !/^(data|blob):/.test(image.uri) ? [new URL(image.uri, base).href] : []))];
          // Native BC7/ASTC is not KHR_texture_basisu. Bind it explicitly with
          // our KTX image hook instead of mislabelling an authored glTF extension.
          if (textureSources.size > 0) {
            for (const url of urls) if (url.endsWith('.ktx2') && !textureSources.has(url)) {
              throw new Error(`Published texture tier omits ${url}`);
            }
          }
          for (const texture of parser.json.textures ?? []) {
            const index = texture.extensions?.KHR_texture_basisu?.source;
            const image = parser.json.images?.[index];
            const source = image?.uri ? textureSources.get(new URL(image.uri, base).href) : undefined;
            if (source && source.codec !== 'uastc') {
              texture.source = index;
              delete texture.extensions.KHR_texture_basisu;
            }
          }
          if (!resolver || !signal || urls.length === 0) return;
          const targets = [...new Set(urls.map(url => textureSources.get(url)?.url ?? url))];
          const resolved = await resolver(targets, signal);
          signal.throwIfAborted();
          for (const [url, target] of resolved) ktx2.resolvedUrls.set(url, target);
        },
        loadTexture: (index: number) => {
          const texture = parser.json.textures[index];
          const image = parser.json.images?.[texture.source];
          if (!image?.uri?.endsWith('.ktx2')) return null;
          return parser.loadTextureImage(index, texture.source, scoped).then(result => {
            if (!result) throw failure ?? new Error(`KTX2 image failed: ${image.uri}`);
            return result;
          });
        },
        afterRoot: async () => { if (failure) throw failure; },
      };
    });
    return loader;
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
  inspectAlbedoTexture(renderer, tex);
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
