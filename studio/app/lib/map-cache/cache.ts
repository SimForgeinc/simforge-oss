// The local map asset service: ONE content-addressed store shared by the
// Studio viewport (through the desktop bridge and the local endpoints under
// /api/simforge/map-cache/**) and by native jobs (through `./service`). It
// lives in the local host, not in a GUI window, so it survives the window and
// serves renders without one.
//
// Authorization is the injected map access policy (`@/app/lib/cloud/access`
// in the host): every has/ensure/stream call asks it whether the CURRENT
// session may read the canonical map URL. A content digest, a cached file, or
// a delivery URL a caller supplies is never access by itself.

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type {
  DesktopMapCacheEnsureRequest,
  DesktopMapCacheEnsureResult,
  DesktopMapCacheReceipt,
  DesktopMapCacheStatus,
} from "@simforge-oss/studio-host";

import {
  abortError,
  assertWritable,
  availableBytes,
  CacheStore,
  errorCode,
  errorMessage,
  isReceipt,
  MapCacheError,
  parseRange,
  readJson,
  SHA256,
  statOrNull,
  unlinkQuietly,
  type VerifiedFile,
  writeJsonAtomic,
} from "./store";
import { assetName, type ResolvedSource, type Transferred, transferIntoStore } from "./transfer";

export const MAP_CACHE_STREAM_PATH = "/api/simforge/map-cache/stream";
/** Sidecar `materializeMapAssets` keeps beside a materialized map root. */
export const MATERIALIZED_SIDECAR = ".simforge-materialized.json";
const MAX_RECEIPT_KEY_LENGTH = 1024;
const MATERIALIZE_CONCURRENCY = 4;
/** `link(2)` failures that mean "copy instead", not "give up". */
const COPY_INSTEAD_OF_LINK = ["EXDEV", "EPERM", "EMLINK", "ENOTSUP", "EOPNOTSUPP", "EACCES", "ENOSYS"];

/** The map access policy the service defers to (owned by LocalCloudMaps). */
export type MapCacheAccess = {
  /** Throws when the current session may not read `url`; otherwise its stable scope and registry-verified digest/size. */
  authorize(url: string): Promise<{ scope: string; sha256?: string; sizeBytes?: number }>;
  /** Where a MISS is fetched from; called only after `authorize` passed. */
  resolveSource(url: string, signal?: AbortSignal): Promise<ResolvedSource>;
};

export type MapCacheServiceOptions = {
  /** Control directory; the data root unless the user chose another. */
  controlDir: string;
  access: MapCacheAccess;
};

export type MaterializeMapAssetsInput = {
  members: Array<{ path: string; url: string; sha256: string; sizeBytes: number }>;
  directory: string;
};

type Canonical = { key: string; url: URL };

type Transfer = {
  controller: AbortController;
  waiters: Map<string, { resolve: (value: Transferred) => void; reject: (error: unknown) => void }>;
  promise: Promise<Transferred>;
};

type Capability = { sha256: string; key: string; store: CacheStore };

type MaterializedEntry = { sha256: string; bytes: number; mtimeMs: number };

/**
 * Local map asset URLs are root-relative paths on this host. Absolute forms are
 * accepted only for loopback origins and reduced to their path so hostnames
 * never split the cache.
 */
function parseCanonicalUrl(raw: unknown): Canonical {
  if (typeof raw !== "string" || raw === "") throw new MapCacheError("A map asset URL is required");
  let url: URL;
  try {
    url = new URL(raw, "http://localhost");
  } catch {
    throw new MapCacheError(`Invalid map asset URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new MapCacheError(`Invalid map asset URL: ${raw}`);
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//");
  if (absolute && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new MapCacheError("Only map assets served by this SimForge host can be stored on this device");
  }
  url.hash = "";
  return { key: `${url.pathname}${url.search}`, url };
}

function parseSha256(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new MapCacheError("The map asset digest must be a SHA-256 hex string");
  const normalized = value.toLowerCase();
  if (!SHA256.test(normalized)) throw new MapCacheError("The map asset digest must be a SHA-256 hex string");
  return normalized;
}

function parseSize(value: unknown) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new MapCacheError("The map asset size must be a non-negative integer");
  return value as number;
}

function parseRequestId(value: unknown) {
  if (typeof value !== "string" || value === "" || value.length > 256) throw new MapCacheError("A request id is required");
  return value;
}

function parseReceiptKey(value: unknown) {
  if (typeof value !== "string" || value === "" || value.length > MAX_RECEIPT_KEY_LENGTH) {
    throw new MapCacheError("A cache receipt key is required");
  }
  return value;
}

/**
 * A manifest member path confined to its map root: relative, forward slashes,
 * no empty/dot segments, never the sidecar.
 */
function confinedSegments(path: unknown): string[] {
  if (typeof path !== "string" || path === "" || path.length > 1024 || path.includes("\0") || path.includes("\\")) {
    throw new MapCacheError(`Invalid map member path: ${String(path)}`);
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || segment === MATERIALIZED_SIDECAR) {
      throw new MapCacheError(`Map member path escapes its map root: ${path}`);
    }
  }
  return segments;
}

function inside(child: string, parent: string) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export class MapCacheService {
  private readonly controlDir: string;
  private readonly locationPath: string;
  private readonly access: MapCacheAccess;
  /**
   * The chosen root that could not be opened (unplugged drive, revoked
   * permission). The cache then refuses work with that reason instead of
   * quietly filling another disk; it reopens by itself once the root is back.
   */
  private unavailable: { root: string; reason: string } | null = null;
  private store: CacheStore | null = null;
  private reopening: Promise<void> | null = null;
  private switching: Promise<void> | null = null;
  private disposed = false;
  private readonly capabilities = new Map<string, Capability>();
  /** `${scope}\n${sha256}\n${key}` → capability id */
  private readonly capabilityIds = new Map<string, string>();
  /** keyed by sha256 or `url:<key>` */
  private readonly transfers = new Map<string, Transfer>();
  /** requestId → transfer */
  private readonly subscribers = new Map<string, Transfer>();
  /** requestId → ensure() call not yet subscribed to a transfer */
  private readonly pending = new Map<string, { cancelled: boolean }>();

  private constructor(controlDir: string, access: MapCacheAccess) {
    this.controlDir = controlDir;
    this.locationPath = join(controlDir, "location.json");
    this.access = access;
  }

  /** Resolves once the configured root is reconciled (or recorded as unavailable). */
  static async open({ controlDir, access }: MapCacheServiceOptions) {
    if (!isAbsolute(controlDir)) throw new Error("MapCacheService: controlDir must be an absolute path");
    const service = new MapCacheService(resolve(controlDir), access);
    await mkdir(service.controlDir, { recursive: true });
    service.store = await service.openConfiguredStore();
    return service;
  }

  // ---- data root ----------------------------------------------------------

  private async openRoot(root: string) {
    // Never recreate the path: an unmounted volume must not become a
    // same-named folder on the system disk.
    if (!(await statOrNull(root))?.isDirectory()) throw new MapCacheError("the directory does not exist");
    const opened = await CacheStore.open(root);
    await assertWritable(root);
    return opened;
  }

  private async openConfiguredStore() {
    const location = (await readJson(this.locationPath, null)) as { directory?: unknown } | null;
    const chosen = typeof location?.directory === "string" && isAbsolute(location.directory) ? resolve(location.directory) : null;
    if (!chosen || chosen === this.controlDir) return CacheStore.open(this.controlDir);
    try {
      return await this.openRoot(chosen);
    } catch (error) {
      console.warn(`[map-cache] chosen cache directory ${chosen} is unavailable: ${errorMessage(error)}`);
      this.unavailable = { root: chosen, reason: errorMessage(error) };
      return null;
    }
  }

  private async reopenUnavailable() {
    const root = this.unavailable?.root;
    if (!root) return;
    try {
      const opened = await this.openRoot(root);
      if (this.store === null && this.unavailable?.root === root) {
        this.store = opened;
        this.unavailable = null;
      }
    } catch (error) {
      if (this.unavailable?.root === root) this.unavailable.reason = errorMessage(error);
    }
  }

  /** The current data root, once any location change settled. */
  private async activeStore(): Promise<CacheStore> {
    if (this.switching) await this.switching.catch(() => undefined);
    if (this.store) return this.store;
    this.reopening ??= this.reopenUnavailable().finally(() => {
      this.reopening = null;
    });
    await this.reopening;
    if (this.store) return this.store;
    throw new MapCacheError(
      `The map cache location ${this.unavailable?.root} is unavailable (${this.unavailable?.reason}). Reconnect the drive or choose another cache location.`,
    );
  }

  // ---- capabilities -------------------------------------------------------

  private capabilityPath(scope: string, canonical: Canonical, sha256: string, target: CacheStore) {
    const key = `${scope}\n${sha256}\n${canonical.key}`;
    let id = this.capabilityIds.get(key);
    if (!id || this.capabilities.get(id)?.store !== target) {
      id = randomBytes(16).toString("hex");
      this.capabilityIds.set(key, id);
      this.capabilities.set(id, { sha256, key: canonical.key, store: target });
    }
    return `${MAP_CACHE_STREAM_PATH}/${id}/${encodeURIComponent(assetName(canonical.url))}`;
  }

  /**
   * Stream the verified bytes behind a capability (GET/HEAD, byte ranges,
   * ETag). The current session must still be allowed to read the URL the
   * capability was issued for: sign-out or an account change revokes it.
   */
  async serveCapability(request: Request, capabilityId: string): Promise<Response> {
    const deny = (status: number, message: string) =>
      new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    if (request.method !== "GET" && request.method !== "HEAD") return deny(405, "Method not allowed");
    const capability = this.capabilities.get(capabilityId);
    if (!capability) return deny(404, "Not found");
    const file = await capability.store.verified(capability.sha256);
    if (!file) return deny(404, "Cached asset is no longer verified");
    try {
      await this.access.authorize(capability.key);
    } catch {
      return deny(403, "Forbidden");
    }

    const headers: Record<string, string> = {
      "content-type": file.mediaType,
      "accept-ranges": "bytes",
      etag: `"${capability.sha256}"`,
      // The file is the cache; Chromium must not duplicate 30 GB in its own.
      "cache-control": "no-store",
    };
    if (file.contentEncoding) headers["content-encoding"] = file.contentEncoding;
    if (request.headers.get("if-none-match") === headers.etag) return new Response(null, { status: 304, headers });
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
    return new Response(Readable.toWeb(createReadStream(file.path, { start, end })) as ReadableStream, { status, headers });
  }

  // ---- transfers ----------------------------------------------------------

  /**
   * Join or start the transfer for `key`; the returned promise belongs to
   * `requestId` alone and rejects with AbortError when it is cancelled. A
   * transfer whose last subscriber cancelled is not joined: the newcomer's
   * transfer starts once it settled, so a retry after a cancel neither
   * inherits the abort nor races the still-open part file.
   */
  private subscribe(requestId: string, key: string, start: (signal: AbortSignal) => Promise<Transferred>) {
    const previous = this.transfers.get(key);
    let transfer = previous && !previous.controller.signal.aborted ? previous : null;
    if (!transfer) {
      const controller = new AbortController();
      const waiters: Transfer["waiters"] = new Map();
      const settled = previous ? previous.promise.then(() => undefined, () => undefined) : Promise.resolve();
      const created: Transfer = { controller, waiters, promise: settled.then(() => start(controller.signal)) };
      created.promise = created.promise.finally(() => {
        if (this.transfers.get(key) === created) this.transfers.delete(key);
      });
      this.transfers.set(key, created);
      created.promise.then(
        (result) => {
          for (const waiter of waiters.values()) waiter.resolve(result);
        },
        (error: unknown) => {
          for (const waiter of waiters.values()) waiter.reject(error);
        },
      ).finally(() => {
        for (const id of waiters.keys()) this.subscribers.delete(id);
        waiters.clear();
      });
      transfer = created;
    }
    const joined = transfer;
    const promise = new Promise<Transferred>((resolvePromise, reject) => {
      joined.waiters.set(requestId, { resolve: resolvePromise, reject });
      this.subscribers.set(requestId, joined);
    });
    return promise;
  }

  private abortAllTransfers(message: string) {
    const pendingTransfers: Array<Promise<unknown>> = [];
    for (const transfer of this.transfers.values()) {
      for (const [id, waiter] of transfer.waiters) {
        this.subscribers.delete(id);
        waiter.reject(new MapCacheError(message));
      }
      transfer.waiters.clear();
      transfer.controller.abort();
      pendingTransfers.push(transfer.promise.catch(() => undefined));
    }
    return Promise.all(pendingTransfers);
  }

  /**
   * The verified object for `canonical`, downloading it when absent. The
   * current session is authorized for the URL first; the registry's digest
   * and size (when known) are the ground truth a caller's claims must agree with.
   */
  private async acquire(
    requestId: string,
    canonical: Canonical,
    claimedSha256: string | null,
    claimedSize: number | null,
    call: { cancelled: boolean },
  ): Promise<{ scope: string; sha256: string; file: VerifiedFile; cacheHit: boolean; store: CacheStore }> {
    const target = await this.activeStore();
    if (this.disposed) throw new MapCacheError("The map cache service is shutting down");
    const grant = await this.access.authorize(canonical.key);
    const registrySha256 = parseSha256(grant.sha256);
    const registrySize = parseSize(grant.sizeBytes);
    if (registrySha256 && claimedSha256 && registrySha256 !== claimedSha256) {
      throw new MapCacheError(`The requested digest for ${canonical.key} does not match the registered map member`, "IntegrityError");
    }
    if (registrySize !== null && claimedSize !== null && registrySize !== claimedSize) {
      throw new MapCacheError(`The requested size for ${canonical.key} does not match the registered map member`, "IntegrityError");
    }
    const expected = registrySha256 ?? claimedSha256;
    const sizeBytes = registrySize ?? claimedSize;

    const known = expected ?? target.urls.get(canonical.key) ?? null;
    if (known) {
      const file = await target.verified(known);
      if (file) {
        target.alias(canonical.key, known);
        return { scope: grant.scope, sha256: known, file, cacheHit: true, store: target };
      }
    }
    if (call.cancelled) throw abortError("Map asset download was cancelled");

    const transferKey = known ?? `url:${canonical.key}`;
    const partKey = expected ?? `u-${createHash("sha256").update(canonical.key).digest("hex")}`;
    const result = await this.subscribe(requestId, transferKey, async (signal) => {
      const source = await this.access.resolveSource(canonical.key, signal);
      if ("url" in source) {
        // A source on this host must be an object store path, never a map route
        // that would itself ask this service (recursion) or the stream endpoint.
        const upstream = new URL(source.url, "http://localhost");
        const local = ["localhost", "127.0.0.1", "[::1]"].includes(upstream.hostname);
        if (local && (upstream.pathname.startsWith("/api/simforge/map-cache/") || upstream.pathname.startsWith("/api/simforge/maps/"))) {
          throw new MapCacheError(`The map source for ${canonical.key} points back at this service`);
        }
      }
      return transferIntoStore({ store: target, canonicalUrl: canonical.url, source, expectedSha256: expected, partKey, sizeBytes, signal });
    });
    target.alias(canonical.key, result.sha256);
    const file = await target.verified(result.sha256);
    if (!file) throw new MapCacheError(`${assetName(canonical.url)} disappeared from the cache right after it was stored`);
    return { scope: grant.scope, sha256: result.sha256, file, cacheHit: false, store: target };
  }

  // ---- endpoint methods ---------------------------------------------------

  async status(): Promise<DesktopMapCacheStatus> {
    if (this.switching) await this.switching.catch(() => undefined);
    if (!this.store) {
      return {
        backend: "filesystem",
        directory: this.unavailable?.root ?? this.controlDir,
        usedBytes: 0,
        availableBytes: null,
        assetCount: 0,
        activeDownloads: this.transfers.size,
        unavailable: this.unavailable?.reason ?? "the cache is not open",
      };
    }
    return {
      backend: "filesystem",
      directory: this.store.root,
      usedBytes: this.store.usedBytes,
      availableBytes: await availableBytes(this.store.root),
      assetCount: this.store.content.size,
      activeDownloads: this.transfers.size,
      unavailable: null,
    };
  }

  /** Is the asset verified on disk AND readable by the current session? Never touches the network. */
  async has(query: unknown): Promise<boolean> {
    if (!query || typeof query !== "object") throw new MapCacheError("has() expects { url, sha256? }");
    const { url, sha256 } = query as { url?: unknown; sha256?: unknown };
    const canonical = parseCanonicalUrl(url);
    const claimed = parseSha256(sha256);
    let target: CacheStore;
    try {
      target = await this.activeStore();
    } catch {
      return false;
    }
    let grant: { sha256?: string };
    try {
      grant = await this.access.authorize(canonical.key);
    } catch {
      return false;
    }
    const registry = parseSha256(grant.sha256);
    if (registry && claimed && registry !== claimed) return false;
    const known = registry ?? claimed ?? target.urls.get(canonical.key);
    if (!known) return false;
    const file = await target.verified(known);
    if (!file) return false;
    target.alias(canonical.key, known);
    return true;
  }

  /**
   * Make one asset resident and hand back its capability path. `signal`
   * cancels this subscriber (peers sharing the transfer keep it alive).
   */
  async ensure(request: unknown, signal?: AbortSignal): Promise<DesktopMapCacheEnsureResult> {
    if (!request || typeof request !== "object") throw new MapCacheError("ensure() expects { requestId, url, sha256?, sizeBytes? }");
    const raw = request as Partial<Record<keyof DesktopMapCacheEnsureRequest, unknown>>;
    const requestId = parseRequestId(raw.requestId);
    const canonical = parseCanonicalUrl(raw.url);
    const claimedSha256 = parseSha256(raw.sha256);
    const claimedSize = parseSize(raw.sizeBytes);
    if (this.pending.has(requestId) || this.subscribers.has(requestId)) throw new MapCacheError(`Map asset request ${requestId} is already in progress`);
    if (signal?.aborted) throw abortError("Map asset download was cancelled");
    // A cancel that arrives while this call is still verifying must not be
    // lost, or the transfer would run to completion for nobody.
    const call = { cancelled: false };
    this.pending.set(requestId, call);
    const onAbort = () => this.cancel(requestId);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const { scope, sha256, file, cacheHit, store } = await this.acquire(requestId, canonical, claimedSha256, claimedSize, call);
      return { url: this.capabilityPath(scope, canonical, sha256, store), sha256, sizeBytes: file.bytes, cacheHit };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.pending.delete(requestId);
    }
  }

  cancel(requestId: unknown) {
    if (typeof requestId !== "string") return;
    const transfer = this.subscribers.get(requestId);
    if (!transfer) {
      const call = this.pending.get(requestId);
      if (call) call.cancelled = true;
      return;
    }
    this.subscribers.delete(requestId);
    const waiter = transfer.waiters.get(requestId);
    transfer.waiters.delete(requestId);
    waiter?.reject(abortError("Map asset download was cancelled"));
    if (transfer.waiters.size === 0) transfer.controller.abort();
  }

  async receipt(key: unknown): Promise<DesktopMapCacheReceipt | null> {
    const receiptKey = parseReceiptKey(key);
    let target: CacheStore;
    try {
      target = await this.activeStore();
    } catch {
      return null;
    }
    return target.receipts.get(receiptKey) ?? null;
  }

  async writeReceipt(key: unknown, value: unknown) {
    const receiptKey = parseReceiptKey(key);
    if (!isReceipt(value)) throw new MapCacheError("A cache receipt needs completedAt, assets and bytes");
    const target = await this.activeStore();
    target.writeReceipt(receiptKey, { completedAt: value.completedAt, assets: value.assets, bytes: value.bytes });
  }

  /**
   * Explicit user action: every cached object, alias, receipt and partial
   * transfer of the active root. Materialized map roots and job artifacts live
   * outside the cache and are untouched.
   */
  async clear() {
    const target = await this.activeStore();
    await this.abortAllTransfers("The map cache was cleared while this download was in progress");
    this.capabilities.clear();
    this.capabilityIds.clear();
    await target.clear();
  }

  /**
   * Switch the data root to `directory` (chosen by the desktop shell's native
   * picker). In-flight downloads finish into the root they started in; nothing
   * is moved or deleted; the previous root stays readable for issued capabilities.
   */
  async setLocation(directory: unknown): Promise<DesktopMapCacheStatus> {
    if (this.switching) throw new MapCacheError("A cache location change is already in progress");
    if (typeof directory !== "string" || !isAbsolute(directory)) throw new MapCacheError("The selected cache location must be an absolute directory path");
    const target = resolve(directory);
    if (this.store && target === this.store.root) return this.status();
    if (this.store && (inside(target, this.store.objectsDir) || inside(target, this.store.incompleteDir))) {
      throw new MapCacheError("The cache location cannot be inside the current cache's object directories");
    }
    this.switching = (async () => {
      await mkdir(target, { recursive: true });
      await assertWritable(target);
      await Promise.allSettled([...this.transfers.values()].map((transfer) => transfer.promise));
      const next = await CacheStore.open(target);
      if (this.store) {
        await this.store.flush();
        this.store.readOnly = true;
      }
      this.store = next;
      this.unavailable = null;
      await writeJsonAtomic(this.locationPath, { version: 1, directory: target === this.controlDir ? null : target });
    })();
    try {
      await this.switching;
    } finally {
      this.switching = null;
    }
    return this.status();
  }

  // ---- native consumers ---------------------------------------------------

  /** Verified on-disk object by digest; server-only, the caller authorized its map already. */
  async resolveCached(sha256: unknown): Promise<{ path: string; sizeBytes: number } | null> {
    const digest = parseSha256(sha256);
    if (!digest) throw new MapCacheError("A SHA-256 digest is required");
    let target: CacheStore;
    try {
      target = await this.activeStore();
    } catch {
      return null;
    }
    const file = await target.verified(digest);
    return file ? { path: file.path, sizeBytes: file.bytes } : null;
  }

  /**
   * Lay out verified members under `directory` for a native job: hardlinks
   * from the store where the filesystem allows, bounded streaming copies
   * otherwise; missing members are downloaded through the same authorized
   * transfer path the viewport uses. A sidecar records what was placed so a
   * re-run only stats.
   */
  async materialize({ members, directory }: MaterializeMapAssetsInput, signal?: AbortSignal) {
    if (typeof directory !== "string" || !isAbsolute(directory)) throw new MapCacheError("materializeMapAssets needs an absolute directory");
    if (!Array.isArray(members)) throw new MapCacheError("materializeMapAssets needs a member list");
    const root = resolve(directory);
    const target = await this.activeStore();
    if (inside(root, target.objectsDir) || inside(root, target.incompleteDir)) {
      throw new MapCacheError("A map cannot be materialized inside the cache's object directories");
    }
    const seen = new Set<string>();
    const planned = members.map((member) => {
      const segments = confinedSegments(member.path);
      if (seen.has(member.path)) throw new MapCacheError(`Duplicate map member path: ${member.path}`);
      seen.add(member.path);
      const sha256 = parseSha256(member.sha256);
      const sizeBytes = parseSize(member.sizeBytes);
      if (!sha256 || sizeBytes === null) throw new MapCacheError(`Map member ${member.path} needs a digest and size`);
      return { path: member.path, segments, canonical: parseCanonicalUrl(member.url), sha256, sizeBytes };
    });
    await mkdir(root, { recursive: true });
    const sidecarPath = join(root, MATERIALIZED_SIDECAR);
    const sidecar = (await readJson(sidecarPath, null)) as { version?: unknown; files?: unknown } | null;
    const files = new Map<string, MaterializedEntry>();
    if (sidecar?.version === 1 && typeof sidecar.files === "object" && sidecar.files !== null) {
      for (const [path, raw] of Object.entries(sidecar.files as Record<string, Partial<MaterializedEntry>>)) {
        if (typeof raw?.sha256 === "string" && typeof raw.bytes === "number" && typeof raw.mtimeMs === "number") {
          files.set(path, { sha256: raw.sha256, bytes: raw.bytes, mtimeMs: raw.mtimeMs });
        }
      }
    }
    let dirty = false;
    const queue = planned.slice();
    const worker = async () => {
      for (let member = queue.shift(); member; member = queue.shift()) {
        if (signal?.aborted) throw abortError("Map materialization was cancelled");
        if (await this.placeMember(target, root, member, files, signal)) dirty = true;
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(MATERIALIZE_CONCURRENCY, planned.length) }, worker));
    } finally {
      if (dirty) {
        const entries: Record<string, MaterializedEntry> = {};
        for (const [path, entry] of files) {
          if (seen.has(path)) entries[path] = entry;
        }
        await writeJsonAtomic(sidecarPath, { version: 1, files: entries }).catch((error: unknown) =>
          console.warn(`[map-cache] could not record materialized members in ${root}: ${errorMessage(error)}`));
      }
    }
  }

  private async placeMember(
    target: CacheStore,
    root: string,
    member: { path: string; segments: string[]; canonical: Canonical; sha256: string; sizeBytes: number },
    files: Map<string, MaterializedEntry>,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const destination = join(root, ...member.segments);
    const placed = files.get(member.path);
    const existing = await statOrNull(destination);
    if (placed && existing?.isFile() && placed.sha256 === member.sha256 && existing.size === member.sizeBytes
      && existing.size === placed.bytes && existing.mtimeMs === placed.mtimeMs) {
      return false;
    }
    const requestId = `materialize-${randomBytes(8).toString("hex")}`;
    const call = { cancelled: false };
    this.pending.set(requestId, call);
    const onAbort = () => this.cancel(requestId);
    signal?.addEventListener("abort", onAbort, { once: true });
    let file: VerifiedFile;
    try {
      ({ file } = await this.acquire(requestId, member.canonical, member.sha256, member.sizeBytes, call));
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.pending.delete(requestId);
    }
    await mkdir(dirname(destination), { recursive: true });
    const temp = `${destination}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      try {
        await link(file.path, temp);
      } catch (error) {
        if (!COPY_INSTEAD_OF_LINK.includes(errorCode(error) ?? "")) throw error;
        await pipeline(createReadStream(file.path), createWriteStream(temp, { flags: "wx" }), { signal });
      }
      const copied = await stat(temp);
      if (copied.size !== member.sizeBytes) {
        throw new MapCacheError(`${member.path} came out as ${copied.size} bytes, the map manifest declares ${member.sizeBytes}`, "IntegrityError");
      }
      await rename(temp, destination);
    } catch (error) {
      await unlinkQuietly(temp);
      if (signal?.aborted) throw abortError("Map materialization was cancelled");
      if (error instanceof MapCacheError) throw error;
      if (errorCode(error) === "ENOSPC") throw new MapCacheError(`The disk holding ${root} is full; ${member.path} could not be written`, "QuotaExceededError");
      throw new MapCacheError(`Could not place ${member.path} in ${root}: ${errorMessage(error)}`);
    }
    const info = await stat(destination);
    files.set(member.path, { sha256: member.sha256, bytes: info.size, mtimeMs: info.mtimeMs });
    return true;
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await this.abortAllTransfers("SimForge is closing");
    if (this.switching) await this.switching.catch(() => undefined);
    this.capabilities.clear();
    this.capabilityIds.clear();
    await this.store?.flush();
  }
}
