import type { BufferGeometry, Material, Object3D, Texture, WebGLRenderer } from 'three';
import { CompressedTexture, Mesh, RGBA_S3TC_DXT1_Format } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { AssetDownloadTracker, readResponseBufferWithProgress } from './download-progress';

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

class SharedKTX2Loader extends KTX2Loader {
  tracker?: AssetDownloadTracker;
  signal?: AbortSignal;
  private activeDownloads = 0;
  private readonly waiting: (() => void)[] = [];
  private disposeWhenIdle = false;

  override dispose(): void {
    // Terminating a worker mid-transcode leaves its parser promise unresolved.
    // Aborted queued requests drain without starting work; active decodes finish.
    if (this.activeDownloads > 0) this.disposeWhenIdle = true;
    else super.dispose();
  }

  private async fetchTracked(url: string): Promise<CompressedTexture> {
    const tracker = this.tracker!;
    const decoded = tracker.trackDecode();
    const signal = this.signal;
    if (this.activeDownloads >= 4) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.activeDownloads++;
    try {
      signal?.throwIfAborted();
      const response = await fetch(url, { signal, credentials: this.withCredentials ? 'include' : 'same-origin' });
      if (!response.ok) throw new Error(`downloading texture ${response.status} ${url}`);
      const buffer = await readResponseBufferWithProgress(response, tracker);
      signal?.throwIfAborted();
      const texture = await new Promise<CompressedTexture>((resolve, reject) => this.parse(buffer, resolve, reject));
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
      if (this.activeDownloads === 0 && this.disposeWhenIdle) super.dispose();
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
    sharedTextures
      .acquire(url, () => this.tracker
        ? this.fetchTracked(url)
        : new Promise<CompressedTexture>((resolve, reject) => {
          super.load(url, resolve, onProgress, reject);
        }))
      .then(onLoad, (error: unknown) => onError?.(error));
    return placeholder;
  }
}

let sharedLoader: GLTFLoader | null = null;
let sharedKtx2: SharedKTX2Loader | null = null;
let sharedKtx2Path = '';
const trackedLoaders = new Map<AssetDownloadTracker, { loader: GLTFLoader; ktx2: SharedKTX2Loader; path: string }>();

/**
 * One GLTFLoader for the whole app.
 *
 * - meshopt decoding runs on a small worker pool (every web-tier cell is
 *   EXT_meshopt_compression, and decoding on the main thread stalls it for
 *   tens of ms).
 * - KTX2 is always wired once a renderer is known: cells carry no other
 *   image encoding. The transcoder path is the embedder's, else `/basis/`
 *   at the origin root, independent of the current application route.
 */
export function getGLTFLoader(renderer?: WebGLRenderer, ktx2TranscoderPath = '', tracker?: AssetDownloadTracker, signal?: AbortSignal): GLTFLoader {
  if (!sharedLoader) {
    const loader = new GLTFLoader();
    MeshoptDecoder.useWorkers(Math.min(4, Math.max(1, (navigator.hardwareConcurrency ?? 4) - 2)));
    loader.setMeshoptDecoder(MeshoptDecoder);
    sharedLoader = loader;
  }
  if (renderer && !tracker) {
    const path = ktx2TranscoderPath || defaultKtx2TranscoderPath();
    if (!sharedKtx2 || sharedKtx2Path !== path) {
      sharedKtx2?.dispose();
      sharedKtx2 = new SharedKTX2Loader().setTranscoderPath(path).detectSupport(renderer) as SharedKTX2Loader;
      sharedKtx2Path = path;
      sharedLoader.setKTX2Loader(sharedKtx2);
    }
  }
  if (renderer && tracker) {
    const path = ktx2TranscoderPath || defaultKtx2TranscoderPath();
    let tracked = trackedLoaders.get(tracker);
    if (!tracked || tracked.path !== path) {
      tracked?.ktx2.dispose();
      const ktx2 = new SharedKTX2Loader().setTranscoderPath(path).setWorkerLimit(4).detectSupport(renderer) as SharedKTX2Loader;
      ktx2.tracker = tracker;
      ktx2.signal = signal;
      const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2);
      tracked = { loader, ktx2, path };
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
