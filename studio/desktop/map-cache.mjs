// Filesystem map asset cache for the installed SimCloud/SimForge desktop shell.
//
// The renderer keeps the shared browser UI; instead of CacheStorage it talks to
// `window.simforgeDesktop.mapCache` (cache-preload.cjs), whose calls arrive here
// over `simforge:map-cache:*` IPC. Metadata travels IPC; asset bytes never do:
// `ensure()` answers with an unguessable `simforge-cache://<host>/<id>/<name>`
// capability and the custom protocol handler streams the verified file from
// disk with byte-range support.
//
// Layout under the control directory (`defaultCacheRoot`, owned by this module):
//   location.json   user-selected data root, absent for the default
//   grants.json     per-login authorization memos (see `Grants`)
// and under the data root (default: the control directory itself):
//   index.json      content records, URL aliases, closure receipts
//   objects/ab/<sha256>          verified, immutable content
//   incomplete/<sha256>.part     resumable transfer with a known digest
//   incomplete/<random>.tmp      transfer without a declared digest
//
// Integrity: every download streams to `incomplete/` while hashing; the file is
// renamed into `objects/` only after the digest (and declared size) verified.
// A warm hit stats the file and compares size+mtime with the record made at
// publication; a mismatch rehashes once and discards the file if the digest
// changed. Nothing is ever a hit until it was fully verified.
//
// Authorization: a content hash is not authorization. A capability for a URL
// is issued only to the login scope (hash of the trusted origin's httpOnly
// session cookies) that either downloaded it through the session or was
// allowed by a HEAD probe of the canonical URL with the session. Grants are
// persisted so a restart with unchanged cookies works offline; a different
// account re-probes and is refused other accounts' assets, including through
// capability URLs it may have observed.

import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, statfs, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";

export const DESKTOP_MAP_CACHE_SCHEME = "simforge-cache";
export const DESKTOP_MAP_CACHE_IPC_PREFIX = "simforge:map-cache:";

const SHA256 = /^[a-f0-9]{64}$/;
const PART_FILE = /^[a-f0-9]{64}\.part$/;
const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+|\*)$/;
/** Keep this much free beyond a declared download so the OS and Chromium keep working. */
const FREE_SPACE_HEADROOM = 64 * 1024 * 1024;
const PERSIST_DELAY_MS = 500;
const PROBE_TIMEOUT_MS = 30_000;
const MAX_GRANT_SCOPES = 8;
const MAX_RECEIPT_KEY_LENGTH = 1024;
const DEFAULT_MEDIA_TYPE = "application/octet-stream";

/** Errors whose messages are shown to the user verbatim by the renderer. */
class MapCacheError extends Error {
  /**
   * @param {string} message
   * @param {string} [name]
   */
  constructor(message, name = "MapCacheError") {
    super(message);
    this.name = name;
  }
}

/** @param {string} message */
function abortError(message) {
  return new MapCacheError(message, "AbortError");
}

/** @param {string} message */
function notAuthorized(message) {
  return new MapCacheError(message, "NotAuthorized");
}

/**
 * Same-origin map paths whose bytes are immutable for a given URL, so a
 * download without a declared digest may still be stored under the digest it
 * produced and answered by URL alone later. Everything else needs a digest
 * from an authenticated manifest; caching it by URL would freeze mutable data.
 * Mirrors `isMapAssetRequest` in packages/studio-ui map-asset-cache.ts.
 * @param {URL} url
 */
function isImmutableMapUrl(url) {
  const path = url.pathname;
  if (/^\/api\/simforge\/maps\/[^/]+\/browser-assets\/./.test(path)) return true;
  if (/^\/api\/simforge\/sumo-runtime\/./.test(path)) return true;
  // Digital-twin assets are rebuilt in place; only the `?v=<manifest hash>`
  // token makes a URL name one specific build.
  return /^\/api\/map-assets\/[^/]+\/3d-asset\/./.test(path) && Boolean(url.searchParams.get("v"));
}

/**
 * What the server actually authorizes: workspace membership for a map version
 * (every browser asset of that version), scenario access for the SUMO runtime,
 * a digital-twin map asset id, or, for anything else, the exact URL. Granting
 * per unit keeps a fresh login at one probe per map instead of one per member.
 * @param {URL} url
 */
function authorizationUnit(url) {
  const path = url.pathname;
  const version = /^\/api\/simforge\/maps\/[^/]+\/browser-assets\//.exec(path);
  if (version) return `${url.origin}${version[0]}`;
  if (path.startsWith("/api/simforge/sumo-runtime/")) return `${url.origin}/api/simforge/sumo-runtime/`;
  const mapAsset = /^\/api\/map-assets\/[^/]+\//.exec(path);
  if (mapAsset) return `${url.origin}${mapAsset[0]}`;
  return url.href;
}

/** @param {string} hostname */
function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/** @param {URL} url */
function isTrustedTransport(url) {
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
}

/** @param {URL} url */
function assetName(url) {
  const name = basename(url.pathname);
  return name || "asset";
}

/**
 * @param {string} path
 * @param {unknown} fallback
 */
async function readJson(path, fallback) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    // A torn or corrupt control file is rebuilt from the durable state it describes.
    return fallback;
  }
}

/**
 * @param {string} path
 * @param {unknown} value
 */
async function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(value));
  await rename(temp, path);
}

/** @param {string} path */
async function statOrNull(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** @param {string} path */
async function unlinkQuietly(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(`[map-cache] could not remove ${path}: ${error.message}`);
  }
}

/** @param {string} path */
async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Free bytes on the volume holding `directory`, or null when the platform
 * cannot tell (never a browser quota guess).
 * @param {string} directory
 */
async function availableBytes(directory) {
  try {
    const fs = await statfs(directory);
    return Number(fs.bavail) * Number(fs.bsize);
  } catch {
    return null;
  }
}

/** @param {string} directory */
async function assertWritable(directory) {
  const probe = join(directory, `.simforge-write-probe-${randomBytes(4).toString("hex")}`);
  try {
    await writeFile(probe, "");
  } catch (error) {
    throw new MapCacheError(`SimCloud cannot write to ${directory}: ${error.message}`);
  } finally {
    await unlinkQuietly(probe);
  }
}

/** Coalesces JSON writes: many mutations, one atomic write shortly after. */
class PersistedJson {
  /** @param {string} path */
  constructor(path) {
    this.path = path;
    /** @type {NodeJS.Timeout | null} */
    this.timer = null;
    /** @type {(() => unknown) | null} */
    this.serialize = null;
    this.writing = Promise.resolve();
  }

  /** @param {() => unknown} serialize */
  schedule(serialize) {
    this.serialize = serialize;
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), PERSIST_DELAY_MS);
    this.timer.unref?.();
  }

  async flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const serialize = this.serialize;
    this.serialize = null;
    if (serialize) {
      this.writing = this.writing
        .then(() => writeJsonAtomic(this.path, serialize()))
        .catch((error) => console.warn(`[map-cache] could not persist ${this.path}: ${error.message}`));
    }
    await this.writing;
  }
}

/**
 * Per-login authorization memos: which canonical URLs a login scope was
 * allowed to access. Small, so a rotated or replaced session costs at most one
 * probe per asset before the cache answers it again.
 */
class Grants {
  /**
   * @param {string} path
   * @param {{ salt: string, scopes: Record<string, { lastUsed: number, urls: Record<string, number> }> }} data
   */
  constructor(path, data) {
    this.persisted = new PersistedJson(path);
    this.salt = data.salt;
    /** @type {Map<string, { lastUsed: number, urls: Set<string> }>} */
    this.scopes = new Map();
    for (const [scopeId, scope] of Object.entries(data.scopes)) {
      this.scopes.set(scopeId, { lastUsed: scope.lastUsed, urls: new Set(Object.keys(scope.urls)) });
    }
  }

  /** @param {string} path */
  static async open(path) {
    const raw = await readJson(path, null);
    const valid = raw && raw.version === 1 && typeof raw.salt === "string" && raw.scopes && typeof raw.scopes === "object";
    const grants = new Grants(path, valid ? raw : { salt: randomBytes(32).toString("hex"), scopes: {} });
    if (!valid) await writeJsonAtomic(path, grants.toJSON());
    return grants;
  }

  /**
   * @param {string} scopeId
   * @param {string} href
   */
  has(scopeId, href) {
    const scope = this.scopes.get(scopeId);
    if (!scope?.urls.has(href)) return false;
    scope.lastUsed = Date.now();
    return true;
  }

  /**
   * @param {string} scopeId
   * @param {string} href
   */
  grant(scopeId, href) {
    let scope = this.scopes.get(scopeId);
    if (!scope) {
      scope = { lastUsed: Date.now(), urls: new Set() };
      this.scopes.set(scopeId, scope);
      while (this.scopes.size > MAX_GRANT_SCOPES) {
        let oldest = null;
        for (const [id, candidate] of this.scopes) {
          if (!oldest || candidate.lastUsed < oldest[1].lastUsed) oldest = [id, candidate];
        }
        this.scopes.delete(oldest[0]);
      }
    }
    scope.lastUsed = Date.now();
    if (scope.urls.has(href)) return;
    scope.urls.add(href);
    this.persisted.schedule(() => this.toJSON());
  }

  clear() {
    this.scopes.clear();
    this.persisted.schedule(() => this.toJSON());
  }

  toJSON() {
    /** @type {Record<string, { lastUsed: number, urls: Record<string, number> }>} */
    const scopes = {};
    for (const [scopeId, scope] of this.scopes) {
      scopes[scopeId] = { lastUsed: scope.lastUsed, urls: Object.fromEntries([...scope.urls].map((href) => [href, 1])) };
    }
    return { version: 1, salt: this.salt, scopes };
  }
}

/**
 * @typedef {{ bytes: number, mtimeMs: number, mediaType: string }} ContentRecord
 * @typedef {{ completedAt: number, assets: number, bytes: number }} Receipt
 */

/** One data root: verified objects plus the index describing them. */
class CacheStore {
  /** @param {string} root */
  constructor(root) {
    this.root = root;
    this.objectsDir = join(root, "objects");
    this.incompleteDir = join(root, "incomplete");
    this.persisted = new PersistedJson(join(root, "index.json"));
    /** @type {Map<string, ContentRecord>} */
    this.content = new Map();
    /** @type {Map<string, string>} canonical URL → sha256 */
    this.urls = new Map();
    /** @type {Map<string, Receipt>} */
    this.receipts = new Map();
    this.usedBytes = 0;
    /** Set once a newer root replaced this one; capabilities keep reading, nothing is written. */
    this.readOnly = false;
  }

  /** @param {string} root */
  static async open(root) {
    const store = new CacheStore(root);
    await mkdir(store.objectsDir, { recursive: true });
    await mkdir(store.incompleteDir, { recursive: true });
    const index = await readJson(store.persisted.path, null);
    if (index && index.version === 1) {
      for (const [sha256, record] of Object.entries(index.content ?? {})) {
        if (SHA256.test(sha256) && Number.isSafeInteger(record?.bytes) && typeof record.mtimeMs === "number") {
          store.content.set(sha256, {
            bytes: record.bytes,
            mtimeMs: record.mtimeMs,
            mediaType: typeof record.mediaType === "string" ? record.mediaType : DEFAULT_MEDIA_TYPE,
          });
        }
      }
      for (const [href, sha256] of Object.entries(index.urls ?? {})) {
        if (typeof sha256 === "string" && SHA256.test(sha256)) store.urls.set(href, sha256);
      }
      for (const [key, receipt] of Object.entries(index.receipts ?? {})) {
        if (isReceipt(receipt)) store.receipts.set(key, receipt);
      }
    }
    await store.reconcile();
    return store;
  }

  /**
   * Make the index agree with the disk after a crash, a manual copy or a lost
   * index: objects without a record are adopted (their name is their digest,
   * verified on first use), records without an object are dropped, and stray
   * temporary files go. Only unknown objects are stat'ed, so a 30 GB corpus
   * costs one readdir per shard, not one stat per asset.
   */
  async reconcile() {
    const present = new Set();
    const shards = await readdir(this.objectsDir, { withFileTypes: true });
    for (const shard of shards) {
      if (!shard.isDirectory()) continue;
      const shardDir = join(this.objectsDir, shard.name);
      for (const entry of await readdir(shardDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!SHA256.test(entry.name) || entry.name.slice(0, 2) !== shard.name) {
          await unlinkQuietly(join(shardDir, entry.name));
          continue;
        }
        present.add(entry.name);
        if (this.content.has(entry.name)) continue;
        const info = await stat(join(shardDir, entry.name));
        // Unknown provenance: record a mtime that cannot match so the first hit rehashes.
        this.content.set(entry.name, { bytes: info.size, mtimeMs: -1, mediaType: DEFAULT_MEDIA_TYPE });
      }
    }
    for (const sha256 of [...this.content.keys()]) {
      if (!present.has(sha256)) this.content.delete(sha256);
    }
    for (const [href, sha256] of [...this.urls]) {
      if (!this.content.has(sha256)) this.urls.delete(href);
    }
    for (const entry of await readdir(this.incompleteDir, { withFileTypes: true })) {
      if (!(entry.isFile() && PART_FILE.test(entry.name))) await rm(join(this.incompleteDir, entry.name), { recursive: true, force: true });
    }
    this.usedBytes = 0;
    for (const record of this.content.values()) this.usedBytes += record.bytes;
    this.persist();
  }

  /** @param {string} sha256 */
  objectPath(sha256) {
    return join(this.objectsDir, sha256.slice(0, 2), sha256);
  }

  /** @param {string | null} sha256 */
  partPath(sha256) {
    return join(this.incompleteDir, sha256 ? `${sha256}.part` : `${randomBytes(8).toString("hex")}.tmp`);
  }

  /**
   * The verified file for `sha256`, or null. Trusts the publication record only
   * while size and mtime still match; otherwise rehashes once and either
   * refreshes the record or discards the changed file.
   * @param {string} sha256
   * @returns {Promise<{ path: string, bytes: number, mediaType: string } | null>}
   */
  async verified(sha256) {
    const record = this.content.get(sha256);
    if (!record) return null;
    const path = this.objectPath(sha256);
    const info = await statOrNull(path);
    if (!info || !info.isFile()) {
      this.forget(sha256);
      return null;
    }
    if (info.size !== record.bytes || info.mtimeMs !== record.mtimeMs) {
      if ((await sha256File(path)) !== sha256) {
        await unlinkQuietly(path);
        this.forget(sha256);
        return null;
      }
      this.usedBytes += info.size - record.bytes;
      record.bytes = info.size;
      record.mtimeMs = info.mtimeMs;
      this.persist();
    }
    return { path, bytes: record.bytes, mediaType: record.mediaType };
  }

  /**
   * Record a freshly published object.
   * @param {string} sha256
   * @param {string} mediaType
   */
  async published(sha256, mediaType) {
    const info = await stat(this.objectPath(sha256));
    const previous = this.content.get(sha256);
    if (previous) this.usedBytes -= previous.bytes;
    this.content.set(sha256, { bytes: info.size, mtimeMs: info.mtimeMs, mediaType });
    this.usedBytes += info.size;
    this.persist();
  }

  /** @param {string} sha256 */
  forget(sha256) {
    const record = this.content.get(sha256);
    if (!record) return;
    this.usedBytes -= record.bytes;
    this.content.delete(sha256);
    for (const [href, target] of [...this.urls]) {
      if (target === sha256) this.urls.delete(href);
    }
    this.persist();
  }

  /**
   * @param {string} href
   * @param {string} sha256
   */
  alias(href, sha256) {
    if (this.urls.get(href) === sha256) return;
    this.urls.set(href, sha256);
    this.persist();
  }

  /**
   * @param {string} key
   * @param {Receipt} receipt
   */
  writeReceipt(key, receipt) {
    this.receipts.set(key, receipt);
    this.persist();
  }

  /** Remove every object, alias, receipt and partial transfer. */
  async clear() {
    await rm(this.objectsDir, { recursive: true, force: true });
    await rm(this.incompleteDir, { recursive: true, force: true });
    await mkdir(this.objectsDir, { recursive: true });
    await mkdir(this.incompleteDir, { recursive: true });
    this.content.clear();
    this.urls.clear();
    this.receipts.clear();
    this.usedBytes = 0;
    this.persist();
    await this.flush();
  }

  persist() {
    if (this.readOnly) return;
    this.persisted.schedule(() => this.toJSON());
  }

  flush() {
    return this.persisted.flush();
  }

  toJSON() {
    return {
      version: 1,
      content: Object.fromEntries(this.content),
      urls: Object.fromEntries(this.urls),
      receipts: Object.fromEntries(this.receipts),
    };
  }
}

/** @param {unknown} value @returns {value is Receipt} */
function isReceipt(value) {
  return Boolean(value) && typeof value === "object"
    && Number.isFinite(value.completedAt)
    && Number.isSafeInteger(value.assets) && value.assets >= 0
    && Number.isSafeInteger(value.bytes) && value.bytes >= 0;
}

/**
 * Stream one asset into `store`, hashing as it goes, and publish it atomically
 * once the digest (and declared size) verified. With a known digest an
 * interrupted transfer is resumed from its `.part` file via a Range request.
 *
 * @param {object} args
 * @param {CacheStore} args.store
 * @param {URL} args.canonicalUrl
 * @param {URL | null} args.downloadUrl
 * @param {string | null} args.expectedSha256
 * @param {number | null} args.sizeBytes
 * @param {(input: string, init: RequestInit) => Promise<Response>} args.fetch
 * @param {AbortSignal} args.signal
 * @returns {Promise<{ sha256: string, sizeBytes: number, mediaType: string }>}
 */
async function downloadIntoStore({ store, canonicalUrl, downloadUrl, expectedSha256, sizeBytes, fetch, signal }) {
  const name = assetName(canonicalUrl);
  const part = store.partPath(expectedSha256);
  let hash = createHash("sha256");
  let written = 0;

  // Resume: rehash what is already on disk, then ask for the rest. A part that
  // already hashes to the expected digest was interrupted between fsync and
  // rename; publish it without touching the network.
  if (expectedSha256) {
    const existing = await statOrNull(part);
    if (existing && existing.size > 0 && (sizeBytes === null || existing.size <= sizeBytes)) {
      for await (const chunk of createReadStream(part)) hash.update(chunk);
      written = existing.size;
      if (hash.copy().digest("hex") === expectedSha256) {
        return publishPart({ store, part, sha256: expectedSha256, mediaType: await probeMediaType(fetch, downloadUrl ?? canonicalUrl, Boolean(downloadUrl)), written });
      }
      if (sizeBytes !== null && written === sizeBytes) {
        // Complete length, wrong bytes: nothing to resume from.
        await unlinkQuietly(part);
        written = 0;
        hash = createHash("sha256");
      }
    } else if (existing) {
      await unlinkQuietly(part);
    }
  }

  if (sizeBytes !== null) {
    const free = await availableBytes(store.root);
    const needed = sizeBytes - written + FREE_SPACE_HEADROOM;
    if (free !== null && free < needed) {
      throw new MapCacheError(
        `Not enough free space in ${store.root}: ${name} needs ${formatBytes(sizeBytes - written)} but only ${formatBytes(free)} is available`,
        "QuotaExceededError",
      );
    }
  }

  const transferUrl = downloadUrl ?? canonicalUrl;
  /** @type {Record<string, string>} */
  const headers = { accept: "*/*" };
  if (written > 0) headers.range = `bytes=${written}-`;

  let response;
  try {
    response = await fetch(transferUrl.href, {
      method: "GET",
      headers,
      // Session cookies go only to the trusted origin; a signed delivery URL gets none.
      credentials: downloadUrl ? "omit" : "include",
      redirect: "follow",
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw abortError(`Download of ${name} was cancelled`);
    throw new MapCacheError(`Could not download ${name}: ${error?.message ?? String(error)}`, "NetworkError");
  }

  let flags = written > 0 ? "a" : "w";
  let complete = false;
  if (written > 0) {
    if (response.status === 206) {
      const match = CONTENT_RANGE.exec(response.headers.get("content-range") ?? "");
      const total = match && match[3] !== "*" ? Number(match[3]) : null;
      if (!match || Number(match[1]) !== written || (sizeBytes !== null && total !== null && total !== sizeBytes)) {
        await response.body?.cancel().catch(() => undefined);
        await unlinkQuietly(part);
        throw new MapCacheError(`The server could not resume ${name}; the partial download was discarded, try again`);
      }
    } else if (response.status === 200) {
      // Range ignored: start over with the full body.
      hash = createHash("sha256");
      written = 0;
      flags = "w";
    } else if (response.status === 416 && sizeBytes === null) {
      // Nothing past what we hold: the part is the whole object (verified below).
      await response.body?.cancel().catch(() => undefined);
      complete = true;
    } else {
      await response.body?.cancel().catch(() => undefined);
      throw httpError(response.status, name);
    }
  } else if (response.status !== 200) {
    // 204/206 bodies are not the asset; a partial or empty answer must never be stored as one.
    await response.body?.cancel().catch(() => undefined);
    throw httpError(response.status, name);
  }

  if (sizeBytes !== null && response.status === 200) {
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) !== sizeBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new MapCacheError(`${name} is ${formatBytes(Number(declared))} on the server but the map manifest declares ${formatBytes(sizeBytes)}`, "IntegrityError");
    }
  }
  const mediaType = complete
    ? await probeMediaType(fetch, transferUrl, Boolean(downloadUrl))
    : response.headers.get("content-type") || DEFAULT_MEDIA_TYPE;

  if (!complete) {
    const handle = await open(part, flags);
    let keepPart = Boolean(expectedSha256);
    try {
      if (response.body) {
        for await (const chunk of response.body) {
          written += chunk.byteLength;
          if (sizeBytes !== null && written > sizeBytes) {
            keepPart = false;
            throw new MapCacheError(`${name} is larger than the ${formatBytes(sizeBytes)} the map manifest declares`, "IntegrityError");
          }
          hash.update(chunk);
          await handle.write(chunk);
        }
      }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      if (!keepPart) await unlinkQuietly(part);
      if (signal.aborted) throw abortError(`Download of ${name} was cancelled`);
      if (error instanceof MapCacheError) throw error;
      if (error?.code === "ENOSPC") {
        throw new MapCacheError(`The disk holding ${store.root} is full; ${name} could not be stored`, "QuotaExceededError");
      }
      throw new MapCacheError(`Download of ${name} was interrupted: ${error?.message ?? String(error)}`, "NetworkError");
    }
    await handle.close();
  }

  if (sizeBytes !== null && written !== sizeBytes) {
    await unlinkQuietly(part);
    throw new MapCacheError(`${name} ended after ${formatBytes(written)}, the map manifest declares ${formatBytes(sizeBytes)}`, "IntegrityError");
  }
  const sha256 = hash.digest("hex");
  if (expectedSha256 && sha256 !== expectedSha256) {
    await unlinkQuietly(part);
    throw new MapCacheError(`Integrity check failed for ${name}: the downloaded bytes do not match the map manifest`, "IntegrityError");
  }
  return publishPart({ store, part, sha256, mediaType, written });
}

/**
 * Move a fully verified part into `objects/` and record it. Content dedup: if
 * the same bytes were published meanwhile under another URL, keep that copy.
 * @param {{ store: CacheStore, part: string, sha256: string, mediaType: string, written: number }} args
 */
async function publishPart({ store, part, sha256, mediaType, written }) {
  const final = store.objectPath(sha256);
  await mkdir(join(store.objectsDir, sha256.slice(0, 2)), { recursive: true });
  if (await statOrNull(final)) {
    await unlinkQuietly(part);
  } else {
    try {
      await rename(part, final);
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
      await unlinkQuietly(part);
    }
  }
  await store.published(sha256, mediaType);
  return { sha256, sizeBytes: written, mediaType };
}

/**
 * Best-effort content type for a recovered part, so loaders that depend on it
 * (WebAssembly, JSON) still work; offline recovery keeps the generic type.
 * @param {(input: string, init: RequestInit) => Promise<Response>} fetch
 * @param {URL} url
 * @param {boolean} signedDelivery
 */
async function probeMediaType(fetch, url, signedDelivery) {
  try {
    const response = await fetch(url.href, {
      method: "HEAD",
      credentials: signedDelivery ? "omit" : "include",
      redirect: "follow",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return (response.ok && response.headers.get("content-type")) || DEFAULT_MEDIA_TYPE;
  } catch {
    return DEFAULT_MEDIA_TYPE;
  }
}

/**
 * @param {number} status
 * @param {string} name
 */
function httpError(status, name) {
  if (status === 401 || status === 403) return notAuthorized(`Your account is not authorized to download ${name}`);
  if (status === 404 || status === 410) return new MapCacheError(`${name} is no longer available on the server (HTTP ${status})`);
  return new MapCacheError(`The server answered HTTP ${status} for ${name}`, "NetworkError");
}

/** @param {number} bytes */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "an unknown number of bytes";
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${bytes} bytes` : `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Parse a single-range `Range` header against `size`.
 * @param {string | null} header
 * @param {number} size
 * @returns {{ start: number, end: number } | "unsatisfiable" | null} null = serve the whole body
 */
function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, first, last] = match;
  if (first === "" && last === "") return null;
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return "unsatisfiable";
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (end < start) return "unsatisfiable";
  return { start, end };
}

/**
 * @param {unknown} raw
 * @param {string} trustedOrigin
 */
function parseCanonicalUrl(raw, trustedOrigin) {
  if (typeof raw !== "string" || raw === "") throw new MapCacheError("A map asset URL is required");
  let url;
  try {
    url = new URL(raw, trustedOrigin);
  } catch {
    throw new MapCacheError(`Invalid map asset URL: ${raw}`);
  }
  if (url.origin !== trustedOrigin) {
    throw new MapCacheError(`Only map assets from ${trustedOrigin} can be stored on this device`);
  }
  url.hash = "";
  return url;
}

/** @param {unknown} value */
function parseSha256(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new MapCacheError("The map asset digest must be a SHA-256 hex string");
  const normalized = value.toLowerCase();
  if (!SHA256.test(normalized)) throw new MapCacheError("The map asset digest must be a SHA-256 hex string");
  return normalized;
}

/** @param {unknown} value */
function parseSize(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new MapCacheError("The map asset size must be a non-negative integer");
  return value;
}

/** @param {unknown} value */
function parseDownloadUrl(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new MapCacheError("The download URL must be a string");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new MapCacheError("The download URL must be absolute");
  }
  if (!isTrustedTransport(url)) throw new MapCacheError("The download URL must use HTTPS");
  url.hash = "";
  return url;
}

/** @param {unknown} value */
function parseRequestId(value) {
  if (typeof value !== "string" || value === "" || value.length > 256) throw new MapCacheError("A request id is required");
  return value;
}

/** @param {unknown} value */
function parseReceiptKey(value) {
  if (typeof value !== "string" || value === "" || value.length > MAX_RECEIPT_KEY_LENGTH) {
    throw new MapCacheError("A cache receipt key is required");
  }
  return value;
}

/**
 * @typedef {object} InstallOptions
 * @property {import("electron").Session} session  session the trusted window uses (cookies stay inside it)
 * @property {import("electron").IpcMain} ipcMain
 * @property {import("electron").BrowserWindow} window  the only window allowed to call the bridge
 * @property {string} trustedOrigin  exact origin of the SimCloud app, e.g. https://simforge.ai
 * @property {string} defaultCacheRoot  control directory; data root unless the user chose another
 * @property {() => Promise<string | null>} chooseDirectory  native picker; null = keep current
 */

/**
 * Install the filesystem map cache for `window`. Resolves once the store is
 * reconciled, the `simforge-cache` protocol is served on `session` and the
 * `simforge:map-cache:*` IPC handlers accept calls from the trusted origin.
 * @param {InstallOptions} options
 * @returns {Promise<{ dispose(): Promise<void> }>}
 */
export async function installDesktopMapCache({ session, ipcMain, window, trustedOrigin, defaultCacheRoot, chooseDirectory }) {
  if (typeof trustedOrigin !== "string" || new URL(trustedOrigin).origin !== trustedOrigin || !isTrustedTransport(new URL(trustedOrigin))) {
    throw new Error(`installDesktopMapCache: trustedOrigin must be an exact HTTPS (or loopback HTTP) origin, got ${trustedOrigin}`);
  }
  if (typeof defaultCacheRoot !== "string" || !isAbsolute(defaultCacheRoot)) {
    throw new Error("installDesktopMapCache: defaultCacheRoot must be an absolute path");
  }
  if (typeof chooseDirectory !== "function") throw new Error("installDesktopMapCache: chooseDirectory callback is required");
  if (session.protocol.isProtocolHandled(DESKTOP_MAP_CACHE_SCHEME)) {
    throw new Error(`installDesktopMapCache: ${DESKTOP_MAP_CACHE_SCHEME} is already handled on this session`);
  }

  const controlDir = resolve(defaultCacheRoot);
  await mkdir(controlDir, { recursive: true });
  const locationPath = join(controlDir, "location.json");
  const grants = await Grants.open(join(controlDir, "grants.json"));

  /** @type {CacheStore} */
  let store = await openConfiguredStore();
  async function openConfiguredStore() {
    const location = await readJson(locationPath, null);
    const chosen = typeof location?.directory === "string" && isAbsolute(location.directory) ? resolve(location.directory) : null;
    if (chosen && chosen !== controlDir) {
      try {
        // Never recreate the path: an unmounted volume must not become a
        // same-named folder on the system disk.
        if (!(await statOrNull(chosen))?.isDirectory()) throw new Error("directory does not exist");
        const opened = await CacheStore.open(chosen);
        await assertWritable(chosen);
        return opened;
      } catch (error) {
        // An unplugged drive must not take the app down; the status card shows
        // the directory in use and location.json still names the chosen one.
        console.warn(`[map-cache] chosen cache directory ${chosen} is unavailable (${error.message}); using ${controlDir}`);
      }
    }
    return CacheStore.open(controlDir);
  }

  const fetchWithSession = session.fetch.bind(session);
  /** Unguessable per-window host; capability URLs on other hosts are refused. */
  const capabilityHost = randomBytes(16).toString("hex");
  /** @type {Map<string, { sha256: string, href: string, scopeId: string, store: CacheStore }>} */
  const capabilities = new Map();
  /** @type {Map<string, string>} `${scopeId}\n${sha256}\n${href}` → capability id */
  const capabilityIds = new Map();

  /**
   * @typedef {object} Transfer
   * @property {AbortController} controller
   * @property {string} href  canonical URL whose session fetch is authorizing this transfer
   * @property {Map<string, { resolve: (value: any) => void, reject: (error: unknown) => void }>} waiters
   * @property {Promise<{ sha256: string, sizeBytes: number, mediaType: string }>} promise
   */
  /** @type {Map<string, Transfer>} keyed by sha256 or `url:<href>` */
  const transfers = new Map();
  /** @type {Map<string, Transfer>} requestId → transfer */
  const subscribers = new Map();
  /** @type {Promise<void> | null} */
  let switching = null;
  let disposed = false;

  // ---- login scope --------------------------------------------------------

  /** @type {Promise<string> | null} */
  let scopePromise = null;
  const onCookiesChanged = () => {
    scopePromise = null;
  };
  session.cookies.on("changed", onCookiesChanged);

  function currentScope() {
    scopePromise ??= computeScope().catch((error) => {
      scopePromise = null;
      throw new MapCacheError(`Could not read the SimCloud session: ${error?.message ?? String(error)}`);
    });
    return scopePromise;
  }

  async function computeScope() {
    const cookies = await session.cookies.get({ url: trustedOrigin });
    const httpOnly = cookies.filter((cookie) => cookie.httpOnly);
    const lines = (httpOnly.length > 0 ? httpOnly : cookies).map((cookie) => `${cookie.name}=${cookie.value}`).sort();
    const hash = createHash("sha256");
    hash.update(grants.salt);
    for (const line of lines) {
      hash.update("\n");
      hash.update(line);
    }
    return hash.digest("hex");
  }

  /**
   * Does the current login have access to `url`? Answers from a persisted
   * grant, otherwise asks the server once (HEAD, or GET of the first byte when
   * HEAD is unsupported) with the session's cookies.
   * @returns {Promise<"granted" | "denied">}
   */
  async function probeAccess(url) {
    const name = assetName(url);
    const request = async (method, extra = {}) => {
      try {
        return await fetchWithSession(url.href, {
          method,
          headers: { accept: "*/*", ...extra },
          credentials: "include",
          redirect: "manual",
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
      } catch (error) {
        throw new MapCacheError(`Could not reach ${url.origin} to verify access to ${name}: ${error?.message ?? String(error)}`, "NetworkError");
      }
    };
    let response = await request("HEAD");
    if (response.status === 405 || response.status === 501) {
      response = await request("GET", { range: "bytes=0-0" });
    }
    await response.body?.cancel().catch(() => undefined);
    // Manual-redirect mode yields the 3xx itself (Electron, undici) or an opaque redirect (spec).
    if (response.type === "opaqueredirect") return "granted";
    if ((response.status >= 200 && response.status < 300) || (response.status >= 300 && response.status < 400)) return "granted";
    if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 410) return "denied";
    throw new MapCacheError(`Could not verify access to ${name}: the server answered HTTP ${response.status}`, "NetworkError");
  }

  /**
   * @param {URL} url
   * @param {string} scopeId
   */
  async function authorize(url, scopeId) {
    const unit = authorizationUnit(url);
    if (grants.has(scopeId, unit)) return true;
    if ((await probeAccess(url)) !== "granted") return false;
    grants.grant(scopeId, unit);
    return true;
  }

  // ---- capabilities -------------------------------------------------------

  /**
   * @param {string} scopeId
   * @param {URL} url
   * @param {string} sha256
   * @param {CacheStore} target
   */
  function capabilityUrl(scopeId, url, sha256, target) {
    const key = `${scopeId}\n${sha256}\n${url.href}`;
    let id = capabilityIds.get(key);
    if (!id || capabilities.get(id)?.store !== target) {
      id = randomBytes(16).toString("hex");
      capabilityIds.set(key, id);
      capabilities.set(id, { sha256, href: url.href, scopeId, store: target });
    }
    return `${DESKTOP_MAP_CACHE_SCHEME}://${capabilityHost}/${id}/${encodeURIComponent(assetName(url))}`;
  }

  const corsHeaders = {
    "access-control-allow-origin": trustedOrigin,
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "range, if-none-match",
    "access-control-expose-headers": "accept-ranges, content-length, content-range, content-type, etag",
    vary: "origin",
  };

  /**
   * @param {number} status
   * @param {string} message
   */
  function deny(status, message) {
    return new Response(message, { status, headers: { ...corsHeaders, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }

  /** @param {Request} request */
  async function serveCapability(request) {
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== trustedOrigin) return deny(403, "Forbidden");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    if (request.method !== "GET" && request.method !== "HEAD") return deny(405, "Method not allowed");
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return deny(400, "Bad request");
    }
    if (url.hostname !== capabilityHost) return deny(404, "Not found");
    const capability = capabilities.get(url.pathname.split("/")[1] ?? "");
    if (!capability) return deny(404, "Not found");

    let scopeId;
    try {
      scopeId = await currentScope();
    } catch {
      return deny(503, "Session unavailable");
    }
    if (capability.scopeId !== scopeId) {
      // The login changed since this capability was issued (rotation or
      // another account): the new login must itself be allowed to see the URL.
      let allowed = false;
      try {
        allowed = await authorize(new URL(capability.href), scopeId);
      } catch {
        allowed = false;
      }
      if (!allowed) return deny(403, "Forbidden");
      capabilityIds.delete(`${capability.scopeId}\n${capability.sha256}\n${capability.href}`);
      capability.scopeId = scopeId;
      capabilityIds.set(`${scopeId}\n${capability.sha256}\n${capability.href}`, url.pathname.split("/")[1]);
    }

    const file = await capability.store.verified(capability.sha256);
    if (!file) return deny(404, "Cached asset is no longer verified");

    const headers = {
      ...corsHeaders,
      "content-type": file.mediaType,
      "accept-ranges": "bytes",
      etag: `"${capability.sha256}"`,
      // The file is the cache; Chromium must not duplicate 30 GB in its own.
      "cache-control": "no-store",
    };
    if (request.headers.get("if-none-match") === headers.etag) {
      return new Response(null, { status: 304, headers });
    }
    const range = parseRange(request.headers.get("range"), file.bytes);
    if (range === "unsatisfiable") {
      return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${file.bytes}` } });
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : file.bytes - 1;
    const length = file.bytes === 0 ? 0 : end - start + 1;
    headers["content-length"] = String(length);
    if (range) headers["content-range"] = `bytes ${start}-${end}/${file.bytes}`;
    const status = range ? 206 : 200;
    if (request.method === "HEAD" || length === 0) return new Response(null, { status, headers });
    return new Response(Readable.toWeb(createReadStream(file.path, { start, end })), { status, headers });
  }

  // ---- transfers ----------------------------------------------------------

  /**
   * Join or start the transfer for `key`; the returned promise belongs to
   * `requestId` alone and rejects with AbortError when it is cancelled.
   * @param {string} requestId
   * @param {string} key
   * @param {string} href
   * @param {(signal: AbortSignal) => Promise<{ sha256: string, sizeBytes: number, mediaType: string }>} start
   */
  function subscribe(requestId, key, href, start) {
    if (subscribers.has(requestId)) throw new MapCacheError(`Map asset request ${requestId} is already in progress`);
    let transfer = transfers.get(key);
    if (!transfer) {
      const controller = new AbortController();
      const waiters = new Map();
      const promise = start(controller.signal).finally(() => {
        transfers.delete(key);
      });
      transfer = { controller, href, waiters, promise };
      transfers.set(key, transfer);
      promise.then(
        (result) => {
          for (const waiter of waiters.values()) waiter.resolve(result);
        },
        (error) => {
          for (const waiter of waiters.values()) waiter.reject(error);
        },
      ).finally(() => {
        for (const id of waiters.keys()) subscribers.delete(id);
        waiters.clear();
      });
    }
    const joined = transfer;
    const promise = new Promise((resolve, reject) => {
      joined.waiters.set(requestId, { resolve, reject });
      subscribers.set(requestId, joined);
    });
    return { transfer: joined, promise };
  }

  /** @param {string} message */
  function abortAllTransfers(message) {
    const pending = [];
    for (const transfer of transfers.values()) {
      for (const [id, waiter] of transfer.waiters) {
        subscribers.delete(id);
        waiter.reject(new MapCacheError(message));
      }
      transfer.waiters.clear();
      transfer.controller.abort();
      pending.push(transfer.promise.catch(() => undefined));
    }
    return Promise.all(pending);
  }

  async function settleSwitch() {
    if (switching) await switching.catch(() => undefined);
  }

  // ---- bridge methods -----------------------------------------------------

  async function status() {
    await settleSwitch();
    return {
      backend: "filesystem",
      directory: store.root,
      usedBytes: store.usedBytes,
      availableBytes: await availableBytes(store.root),
      assetCount: store.content.size,
      activeDownloads: transfers.size,
    };
  }

  /** @param {unknown} query */
  async function has(query) {
    if (!query || typeof query !== "object") throw new MapCacheError("has() expects { url, sha256? }");
    const url = parseCanonicalUrl(query.url, trustedOrigin);
    const expected = parseSha256(query.sha256);
    await settleSwitch();
    const target = store;
    const sha256 = expected ?? (isImmutableMapUrl(url) ? target.urls.get(url.href) : undefined);
    if (!sha256) return false;
    if (!(await target.verified(sha256))) return false;
    try {
      if (!(await authorize(url, await currentScope()))) return false;
    } catch {
      // Unreachable or failing server: not provably cached for this login.
      return false;
    }
    target.alias(url.href, sha256);
    return true;
  }

  /** @param {unknown} request */
  async function ensure(request) {
    if (!request || typeof request !== "object") throw new MapCacheError("ensure() expects { requestId, url, downloadUrl?, sha256?, sizeBytes? }");
    const requestId = parseRequestId(request.requestId);
    const url = parseCanonicalUrl(request.url, trustedOrigin);
    const downloadUrl = parseDownloadUrl(request.downloadUrl);
    const expected = parseSha256(request.sha256);
    const sizeBytes = parseSize(request.sizeBytes);
    if (!expected && !isImmutableMapUrl(url)) {
      throw new MapCacheError(`${url.pathname} is not an immutable map asset and cannot be stored without a content digest`);
    }
    await settleSwitch();
    if (disposed) throw new MapCacheError("The desktop map cache is shutting down");
    const target = store;
    const scopeId = await currentScope();

    const known = expected ?? target.urls.get(url.href) ?? null;
    if (known) {
      const file = await target.verified(known);
      if (file) {
        if (!(await authorize(url, scopeId))) throw notAuthorized(`Your account is not authorized to access ${url.pathname}`);
        target.alias(url.href, known);
        return { url: capabilityUrl(scopeId, url, known, target), sha256: known, sizeBytes: file.bytes, cacheHit: true };
      }
    }

    const key = known ?? `url:${url.href}`;
    const joined = subscribe(requestId, key, url.href, (signal) =>
      downloadIntoStore({ store: target, canonicalUrl: url, downloadUrl, expectedSha256: expected, sizeBytes, fetch: fetchWithSession, signal }));
    const result = await joined.promise;
    if (joined.transfer.href === url.href || downloadUrl) {
      // This login fetched the asset (or held a server-issued delivery URL for it).
      grants.grant(scopeId, authorizationUnit(url));
    } else if (!(await authorize(url, scopeId))) {
      // Joined a peer's transfer for the same content under another URL.
      throw notAuthorized(`Your account is not authorized to access ${url.pathname}`);
    }
    target.alias(url.href, result.sha256);
    return { url: capabilityUrl(scopeId, url, result.sha256, target), sha256: result.sha256, sizeBytes: result.sizeBytes, cacheHit: false };
  }

  /** @param {unknown} requestId */
  function cancel(requestId) {
    if (typeof requestId !== "string") return;
    const transfer = subscribers.get(requestId);
    if (!transfer) return;
    subscribers.delete(requestId);
    const waiter = transfer.waiters.get(requestId);
    transfer.waiters.delete(requestId);
    waiter?.reject(abortError("Map asset download was cancelled"));
    if (transfer.waiters.size === 0) transfer.controller.abort();
  }

  /** @param {unknown} key */
  async function receipt(key) {
    const receiptKey = parseReceiptKey(key);
    await settleSwitch();
    return store.receipts.get(receiptKey) ?? null;
  }

  /**
   * @param {unknown} key
   * @param {unknown} value
   */
  async function writeReceipt(key, value) {
    const receiptKey = parseReceiptKey(key);
    if (!isReceipt(value)) throw new MapCacheError("A cache receipt needs completedAt, assets and bytes");
    await settleSwitch();
    store.writeReceipt(receiptKey, { completedAt: value.completedAt, assets: value.assets, bytes: value.bytes });
  }

  async function clear() {
    await settleSwitch();
    await abortAllTransfers("The map cache was cleared while this download was in progress");
    capabilities.clear();
    capabilityIds.clear();
    grants.clear();
    await store.clear();
    await grants.persisted.flush();
  }

  async function changeDirectory() {
    if (switching) throw new MapCacheError("A cache location change is already in progress");
    const selected = await chooseDirectory();
    if (selected === null || selected === undefined) return status();
    if (typeof selected !== "string" || !isAbsolute(selected)) throw new MapCacheError("The selected cache location must be an absolute directory path");
    const target = resolve(selected);
    if (target === store.root) return status();
    const inside = (child, parent) => {
      const rel = relative(parent, child);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    };
    if (inside(target, store.objectsDir) || inside(target, store.incompleteDir)) {
      throw new MapCacheError("The cache location cannot be inside the current cache's object directories");
    }
    switching = (async () => {
      await mkdir(target, { recursive: true });
      await assertWritable(target);
      // Let in-flight downloads finish into the directory they started in;
      // new requests wait on this promise. Nothing is moved or deleted.
      await Promise.allSettled([...transfers.values()].map((transfer) => transfer.promise));
      const next = await CacheStore.open(target);
      await store.flush();
      store.readOnly = true;
      store = next;
      await writeJsonAtomic(locationPath, { version: 1, directory: target === controlDir ? null : target });
    })();
    try {
      await switching;
    } finally {
      switching = null;
    }
    return status();
  }

  // ---- IPC ----------------------------------------------------------------

  /** @param {import("electron").IpcMainInvokeEvent} event */
  function trustedSender(event) {
    if (window.isDestroyed()) return false;
    const contents = window.webContents;
    if (!event.sender || event.sender.id !== contents.id) return false;
    const frame = event.senderFrame;
    const main = contents.mainFrame;
    if (!frame || !main || frame.processId !== main.processId || frame.routingId !== main.routingId) return false;
    try {
      return new URL(frame.url).origin === trustedOrigin;
    } catch {
      return false;
    }
  }

  const methods = { status, has, ensure, cancel, receipt, writeReceipt, clear, chooseDirectory: changeDirectory };
  const channels = Object.keys(methods).map((name) => `${DESKTOP_MAP_CACHE_IPC_PREFIX}${name}`);
  for (const [name, method] of Object.entries(methods)) {
    ipcMain.handle(`${DESKTOP_MAP_CACHE_IPC_PREFIX}${name}`, async (event, ...args) => {
      if (!trustedSender(event)) {
        return { ok: false, error: { name: "SecurityError", message: "The desktop map cache is only available to the SimCloud window" } };
      }
      try {
        return { ok: true, value: await method(...args) };
      } catch (error) {
        if (!(error instanceof MapCacheError)) console.error(`[map-cache] ${name} failed:`, error);
        return {
          ok: false,
          error: {
            name: typeof error?.name === "string" ? error.name : "Error",
            message: error instanceof MapCacheError ? error.message : `Desktop map cache ${name} failed: ${error?.message ?? String(error)}`,
          },
        };
      }
    });
  }

  session.protocol.handle(DESKTOP_MAP_CACHE_SCHEME, (request) =>
    serveCapability(request).catch((error) => {
      console.error("[map-cache] capability request failed:", error);
      return deny(500, "Cached asset could not be read");
    }));

  return {
    async dispose() {
      if (disposed) return;
      disposed = true;
      session.cookies.removeListener("changed", onCookiesChanged);
      for (const channel of channels) ipcMain.removeHandler(channel);
      session.protocol.unhandle(DESKTOP_MAP_CACHE_SCHEME);
      await abortAllTransfers("SimCloud is closing");
      await settleSwitch();
      capabilities.clear();
      capabilityIds.clear();
      await Promise.all([store.flush(), grants.persisted.flush()]);
    },
  };
}
