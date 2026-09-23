/**
 * Browser map packs (`simforge.map-browser-pack.v1`, built at ingest by
 * `@simforge-oss/map-pipeline` `buildBrowserPacks`).
 *
 * A pack holds one texture tier's scene members (`tiles/*.glb` and the tier's
 * `variants/objects/*.ktx2`) in a few large content-addressed chunks, in
 * streaming order. The viewer reads a chunk once (one Cache Storage entry or
 * one network transfer) and serves every member inside it from memory, instead
 * of paying a request, a cache lookup and a Response per member. Everything in
 * the index that depends only on the map (member layout, the albedo
 * classification the viewer used to derive with a GPU readback per texture)
 * was computed at ingest.
 *
 * A chunk is dropped once every member in it has been read; a later re-read
 * (a tile evicted and wanted again) reads the chunk again, which the map
 * asset cache answers from Cache Storage.
 */

export const BROWSER_PACK_SCHEMA = 'simforge.map-browser-pack.v1';

export type BrowserPackGroup = 'core' | 'vegetation';

export interface BrowserPackChunk {
  file: string;
  sha256: string;
  bytes: number;
  group: BrowserPackGroup;
  kind: 'geometry' | 'textures';
}

export interface BrowserPackIndex {
  schema: typeof BROWSER_PACK_SCHEMA;
  revision: string;
  id: string;
  sourceManifestSha256: string;
  tier: { id: string; outputSha256: string };
  focus: number[];
  chunks: BrowserPackChunk[];
  /** Member path (relative to the asset root) -> [chunk index, byte offset, byte length]. */
  members: Record<string, [number, number, number]>;
  albedo: { classifiedFrom: string; sources: number; rgbMissing: string[] };
}

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_MEMBER = /^[A-Za-z0-9._/-]+$/;

/** Validate a pack index against the tier it claims to pack. Throws on any mismatch. */
export function parseBrowserPackIndex(
  value: unknown,
  expected: { tierId: string; tierOutputSha256: string; sourceManifestSha256: string },
): BrowserPackIndex {
  const fail = (reason: string): never => { throw new Error(`Invalid browser pack for ${expected.tierId}: ${reason}`); };
  if (!value || typeof value !== 'object') fail('not an object');
  const index = value as Partial<BrowserPackIndex>;
  if (index.schema !== BROWSER_PACK_SCHEMA) fail(`schema ${String(index.schema)}`);
  if (index.id !== expected.tierId || index.tier?.id !== expected.tierId) fail('packs another tier');
  if (index.tier?.outputSha256 !== expected.tierOutputSha256) fail('bound to another tier index');
  if (index.sourceManifestSha256 !== expected.sourceManifestSha256) fail('bound to another map manifest');
  if (!Array.isArray(index.chunks) || index.chunks.length === 0) fail('no chunks');
  for (const chunk of index.chunks!) {
    if (!chunk || !SHA256.test(chunk.sha256) || chunk.file !== `packs/objects/${chunk.sha256}.bin`
      || !Number.isSafeInteger(chunk.bytes) || chunk.bytes <= 0
      || (chunk.group !== 'core' && chunk.group !== 'vegetation')) fail(`bad chunk ${JSON.stringify(chunk)}`);
  }
  if (!index.members || typeof index.members !== 'object') fail('no members');
  for (const [member, range] of Object.entries(index.members!)) {
    if (!SAFE_MEMBER.test(member) || member.split('/').some((part) => !part || part === '.' || part === '..')) fail(`unsafe member ${member}`);
    if (!Array.isArray(range) || range.length !== 3) fail(`bad range for ${member}`);
    const [chunk, offset, length] = range;
    const target = index.chunks![chunk];
    if (!target || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0
      || offset + length > target.bytes) fail(`range out of chunk for ${member}`);
  }
  if (!index.albedo || !Array.isArray(index.albedo.rgbMissing)) fail('no albedo classification');
  return index as BrowserPackIndex;
}

export interface MapPackChunkLoader {
  (url: string, chunk: BrowserPackChunk, signal: AbortSignal): Promise<ArrayBuffer>;
}

/**
 * Transforms a chunk once after it is read (the viewer inflates the
 * zstd-supercompressed KTX2 members of texture chunks in a worker). Returns the
 * transformed chunk and the new [offset, length] of each member, by member path.
 */
export interface MapPackChunkDecoder {
  (chunk: ArrayBuffer, members: readonly { path: string; offset: number; length: number }[], info: BrowserPackChunk): Promise<{
    buffer: ArrayBuffer;
    ranges: ReadonlyMap<string, readonly [number, number]>;
  }>;
}

export interface MapPackStats {
  tier: string;
  chunks: number;
  chunksRead: number;
  chunkBytesRead: number;
  memberReads: number;
  residentChunkBytes: number;
  decodeMs: number;
}

interface LoadedChunk {
  buffer: ArrayBuffer;
  ranges: ReadonlyMap<string, readonly [number, number]> | null;
  unread: Set<string>;
  /** Read again after it was dropped: serve the waiting readers, then drop it at once. */
  reread: boolean;
}

export class MapPackReader {
  readonly index: BrowserPackIndex;
  private readonly base: URL;
  private readonly loaded = new Map<number, Promise<LoadedChunk>>();
  private readonly everLoaded = new Set<number>();
  private readonly membersByChunk = new Map<number, string[]>();
  private readonly albedoRgbMissing: ReadonlySet<string>;
  private readonly abort = new AbortController();
  private chunksRead = 0;
  private chunkBytesRead = 0;
  private memberReads = 0;
  private residentChunkBytes = 0;
  private decodeMs = 0;

  constructor(
    index: BrowserPackIndex,
    assetBase: string,
    private readonly loadChunk: MapPackChunkLoader,
    private readonly decodeChunk: MapPackChunkDecoder | null = null,
  ) {
    this.index = index;
    this.base = new URL(assetBase, typeof document !== 'undefined' ? document.baseURI : undefined);
    for (const [member, [chunk]] of Object.entries(index.members)) {
      let list = this.membersByChunk.get(chunk);
      if (!list) this.membersByChunk.set(chunk, list = []);
      list.push(member);
    }
    this.albedoRgbMissing = new Set(index.albedo.rgbMissing);
  }

  /** Member path relative to the asset root, or null when `url` is not under it. */
  memberPath(url: string): string | null {
    const absolute = new URL(url, this.base);
    if (absolute.origin !== this.base.origin || !absolute.pathname.startsWith(this.base.pathname)) return null;
    return decodeURIComponent(absolute.pathname.slice(this.base.pathname.length));
  }

  has(url: string): boolean {
    const member = this.memberPath(url);
    return member !== null && Object.hasOwn(this.index.members, member);
  }

  /** Ingest classification of a base-colour image in this pack: all-zero RGB at the tier's base level. */
  albedoRgbMissingFor(url: string): boolean | null {
    const member = this.memberPath(url);
    if (member === null || !Object.hasOwn(this.index.members, member)) return null;
    return this.albedoRgbMissing.has(member);
  }

  /** Start reading every chunk of a group in streaming order (bounded by the caller's needs). */
  prefetch(group: BrowserPackGroup, limit = Infinity): void {
    let started = 0;
    this.index.chunks.forEach((chunk, i) => {
      if (chunk.group !== group || started >= limit) return;
      started++;
      void this.chunk(i).catch(() => undefined);
    });
  }

  /** A private copy of one member's bytes (callers transfer them to workers). */
  async read(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    const member = this.memberPath(url);
    const range = member === null ? undefined : this.index.members[member];
    if (!member || !range) throw new Error(`${url} is not a member of browser pack ${this.index.id}`);
    const [chunkIndex, offset, length] = range;
    const loaded = await this.chunk(chunkIndex);
    signal?.throwIfAborted();
    const [start, size] = loaded.ranges?.get(member) ?? [offset, length];
    const bytes = loaded.buffer.slice(start, start + size);
    this.memberReads++;
    loaded.unread.delete(member);
    if ((loaded.unread.size === 0 || loaded.reread) && this.loaded.has(chunkIndex)) {
      // Every member has been handed out once: drop the chunk. A re-read reads it again.
      this.loaded.delete(chunkIndex);
      this.residentChunkBytes -= loaded.buffer.byteLength;
    }
    return bytes;
  }

  private chunk(index: number): Promise<LoadedChunk> {
    let pending = this.loaded.get(index);
    if (pending) return pending;
    const info = this.index.chunks[index];
    if (!info) return Promise.reject(new Error(`browser pack ${this.index.id} has no chunk ${index}`));
    const url = new URL(info.file, this.base).href;
    const reread = this.everLoaded.has(index);
    this.everLoaded.add(index);
    pending = this.loadChunk(url, info, this.abort.signal).then(async (buffer) => {
      if (buffer.byteLength !== info.bytes) throw new Error(`browser pack chunk ${info.file} is ${buffer.byteLength} bytes, index says ${info.bytes}`);
      this.chunksRead++;
      this.chunkBytesRead += buffer.byteLength;
      const members = this.membersByChunk.get(index) ?? [];
      let ranges: ReadonlyMap<string, readonly [number, number]> | null = null;
      if (this.decodeChunk && info.kind === 'textures') {
        const started = performance.now();
        const decoded = await this.decodeChunk(buffer, members.map((path) => {
          const [, offset, length] = this.index.members[path]!;
          return { path, offset, length };
        }), info);
        this.decodeMs += performance.now() - started;
        buffer = decoded.buffer;
        ranges = decoded.ranges;
      }
      this.residentChunkBytes += buffer.byteLength;
      return { buffer, ranges, unread: new Set(members), reread };
    });
    pending.catch(() => {
      if (this.loaded.get(index) === pending) this.loaded.delete(index);
    });
    this.loaded.set(index, pending);
    return pending;
  }

  stats(): MapPackStats {
    return {
      tier: this.index.id,
      chunks: this.index.chunks.length,
      chunksRead: this.chunksRead,
      chunkBytesRead: this.chunkBytesRead,
      memberReads: this.memberReads,
      residentChunkBytes: this.residentChunkBytes,
      decodeMs: this.decodeMs,
    };
  }

  dispose(): void {
    this.abort.abort();
    this.loaded.clear();
    this.residentChunkBytes = 0;
  }
}
