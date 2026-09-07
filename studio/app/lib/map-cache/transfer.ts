// Moves one asset from its resolved source into a CacheStore, verifying it.
//
// HTTP sources are read with node:http/https so the bytes on the wire are the
// bytes stored: a `Content-Encoding: gzip` member keeps its encoded form and
// its declared digest/size describe exactly those bytes. (Node's fetch would
// transparently decode and destroy that identity.) Redirects are followed by
// hand so credentials stay on the origin they were issued for.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { extname, join } from "node:path";

import {
  abortError,
  availableBytes,
  type CacheStore,
  DEFAULT_MEDIA_TYPE,
  errorCode,
  errorMessage,
  formatBytes,
  MapCacheError,
  normalizeEtag,
  notAuthorized,
  statOrNull,
} from "./store";

const CONTENT_RANGE = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+|\*)$/;
/** Keep this much free beyond a declared download so the OS and the app keep working. */
const FREE_SPACE_HEADROOM = 64 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 30_000;
/** Socket inactivity before a transfer counts as stalled. */
const SOCKET_IDLE_MS = 60_000;
const MAX_REDIRECTS = 5;
/** Headers that carry credentials and never cross an origin boundary on redirect. */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "x-simforge-workspace-id"];

const MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  ".json": "application/json",
  ".geojson": "application/geo+json",
  ".gz": "application/gzip",
  ".wasm": "application/wasm",
  ".js": "text/javascript",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".bin": DEFAULT_MEDIA_TYPE,
  ".ktx2": "image/ktx2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".xodr": "application/xml",
  ".xml": "application/xml",
  ".txt": "text/plain",
};

export type ResolvedSource = { url: string; headers?: Record<string, string> } | { path: string };

export type Transferred = { sha256: string; sizeBytes: number; mediaType: string };

/** HTTPS anywhere, plain HTTP only on this machine. */
export function isTrustedTransport(url: URL) {
  const { hostname } = url;
  return url.protocol === "https:"
    || (url.protocol === "http:" && (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"));
}

export function assetName(url: URL) {
  const segment = url.pathname.split("/").pop() ?? "";
  try {
    return decodeURIComponent(segment) || "asset";
  } catch {
    return segment || "asset";
  }
}

function header(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}

type RawResponse = { status: number; headers: IncomingHttpHeaders; body: IncomingMessage };

/**
 * One raw HTTP exchange with manual redirect handling. Credential headers are
 * dropped the moment a redirect leaves the origin they were issued for; every
 * hop must use HTTPS or loopback HTTP.
 */
async function rawRequest(method: "GET" | "HEAD", url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<RawResponse> {
  let current = url;
  let currentHeaders = headers;
  let currentMethod = method;
  for (let hop = 0; ; hop++) {
    if (!isTrustedTransport(current)) throw new MapCacheError(`Refusing to download ${assetName(url)} over an untrusted transport (${current.origin})`);
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = (current.protocol === "https:" ? httpsRequest : httpRequest)(current, {
        method: currentMethod,
        headers: currentHeaders,
        signal,
        timeout: SOCKET_IDLE_MS,
      }, resolve);
      request.on("timeout", () => request.destroy(new MapCacheError(`The connection to ${current.host} stalled`, "NetworkError")));
      request.on("error", reject);
      request.end();
    });
    const status = response.statusCode ?? 0;
    const location = header(response.headers, "location");
    if (!(status === 301 || status === 302 || status === 303 || status === 307 || status === 308) || !location) {
      return { status, headers: response.headers, body: response };
    }
    response.resume();
    if (hop >= MAX_REDIRECTS) throw new MapCacheError(`Too many redirects while downloading ${assetName(url)}`, "NetworkError");
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new MapCacheError(`Invalid redirect while downloading ${assetName(url)}`, "NetworkError");
    }
    next.hash = "";
    if (next.origin !== current.origin) {
      currentHeaders = Object.fromEntries(Object.entries(currentHeaders).filter(([name]) => !CREDENTIAL_HEADERS.includes(name.toLowerCase())));
    }
    if (status === 303) currentMethod = method === "HEAD" ? "HEAD" : "GET";
    current = next;
  }
}

function httpError(status: number, name: string) {
  if (status === 401 || status === 403) return notAuthorized(`Your account is not authorized to download ${name}`);
  if (status === 404 || status === 410) return new MapCacheError(`${name} is no longer available on the server (HTTP ${status})`);
  return new MapCacheError(`The server answered HTTP ${status} for ${name}`, "NetworkError");
}

function contentEncodingOf(headers: IncomingHttpHeaders) {
  const value = header(headers, "content-encoding")?.trim().toLowerCase() ?? "";
  return value === "" || value === "identity" ? null : value;
}

type Delivery = { mediaType: string; etag: string | null; contentEncoding: string | null };

/**
 * Best-effort content type, validator and encoding for a recovered part, so
 * loaders that depend on the type (WebAssembly, JSON) still work; offline
 * recovery keeps the generic type.
 */
async function probeDelivery(url: URL, headers: Record<string, string>): Promise<Delivery> {
  try {
    const response = await rawRequest("HEAD", url, headers, AbortSignal.timeout(PROBE_TIMEOUT_MS));
    response.body.resume();
    if (response.status < 200 || response.status >= 300) return { mediaType: DEFAULT_MEDIA_TYPE, etag: null, contentEncoding: null };
    return {
      mediaType: header(response.headers, "content-type") || DEFAULT_MEDIA_TYPE,
      etag: normalizeEtag(header(response.headers, "etag")),
      contentEncoding: contentEncodingOf(response.headers),
    };
  } catch {
    return { mediaType: DEFAULT_MEDIA_TYPE, etag: null, contentEncoding: null };
  }
}

async function assertFreeSpace(store: CacheStore, name: string, needed: number) {
  const free = await availableBytes(store.root);
  if (free !== null && free < needed + FREE_SPACE_HEADROOM) {
    throw new MapCacheError(
      `Not enough free space in ${store.root}: ${name} needs ${formatBytes(needed)} but only ${formatBytes(free)} is available`,
      "QuotaExceededError",
    );
  }
}

type TransferArgs = {
  store: CacheStore;
  canonicalUrl: URL;
  source: ResolvedSource;
  expectedSha256: string | null;
  /** `<sha256>` or `u-<sha256 of the canonical URL>` */
  partKey: string;
  sizeBytes: number | null;
  signal: AbortSignal;
};

/**
 * Stream one asset into `store`, hashing as it goes, and publish it atomically
 * once the digest (and declared size) verified. An interrupted HTTP transfer
 * is resumed from its `.part` file via a Range request: with a known digest
 * the final hash is the ground truth; without one (immutable URL, e.g. viewer
 * tiles aborted on camera moves) only within this process, and only under
 * `If-Range` with the validator the interrupted response carried, so a
 * changed object can never be stitched onto an old prefix.
 */
export async function transferIntoStore(args: TransferArgs): Promise<Transferred> {
  if ("path" in args.source) return copyFileIntoStore(args, args.source.path);
  return downloadIntoStore(args, new URL(args.source.url), args.source.headers ?? {});
}

async function copyFileIntoStore({ store, canonicalUrl, expectedSha256, partKey, sizeBytes, signal }: TransferArgs, sourcePath: string): Promise<Transferred> {
  const name = assetName(canonicalUrl);
  if (signal.aborted) throw abortError(`Download of ${name} was cancelled`);
  const info = await statOrNull(sourcePath);
  if (!info?.isFile()) throw new MapCacheError(`${name} is not available in the local map store`);
  if (sizeBytes !== null && info.size !== sizeBytes) {
    throw new MapCacheError(`${name} is ${formatBytes(info.size)} in the local map store but the map manifest declares ${formatBytes(sizeBytes)}`, "IntegrityError");
  }
  await assertFreeSpace(store, name, info.size);
  const part = store.partPath(partKey);
  await store.discardPart(part);
  const hash = createHash("sha256");
  let written = 0;
  const handle = await open(part, "w");
  try {
    for await (const chunk of createReadStream(sourcePath, { signal })) {
      const bytes = chunk as Buffer;
      written += bytes.byteLength;
      hash.update(bytes);
      await handle.write(bytes);
    }
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await store.discardPart(part);
    if (signal.aborted) throw abortError(`Download of ${name} was cancelled`);
    if (errorCode(error) === "ENOSPC") throw new MapCacheError(`The disk holding ${store.root} is full; ${name} could not be stored`, "QuotaExceededError");
    throw new MapCacheError(`Copying ${name} into the map cache failed: ${errorMessage(error)}`, "NetworkError");
  }
  await handle.close();
  const sha256 = hash.digest("hex");
  if (expectedSha256 && sha256 !== expectedSha256) {
    await store.discardPart(part);
    throw new MapCacheError(`Integrity check failed for ${name}: the local map store bytes do not match the map manifest`, "IntegrityError");
  }
  const lower = name.toLowerCase();
  const mediaType = lower.endsWith(".gz") ? "application/gzip" : MEDIA_TYPE_BY_EXTENSION[extname(lower)] ?? DEFAULT_MEDIA_TYPE;
  return publishPart({ store, part, sha256, written, mediaType, etag: null, contentEncoding: null });
}

async function downloadIntoStore(args: TransferArgs, transferUrl: URL, sourceHeaders: Record<string, string>): Promise<Transferred> {
  const { store, canonicalUrl, expectedSha256, partKey, sizeBytes, signal } = args;
  const name = assetName(canonicalUrl);
  if (signal.aborted) throw abortError(`Download of ${name} was cancelled`);
  const part = store.partPath(partKey);
  const validator = expectedSha256 ? null : store.partValidators.get(part) ?? null;
  let hash = createHash("sha256");
  let written = 0;

  // Resume: rehash what is already on disk, then ask for the rest. A part that
  // already hashes to the expected digest was interrupted between fsync and
  // rename; publish it without touching the network.
  const existing = await statOrNull(part);
  if (existing && (expectedSha256 || validator) && existing.size > 0 && (sizeBytes === null || existing.size <= sizeBytes)) {
    for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer);
    written = existing.size;
    if (expectedSha256 && hash.copy().digest("hex") === expectedSha256) {
      const delivery = await probeDelivery(transferUrl, sourceHeaders);
      return publishPart({ store, part, sha256: expectedSha256, written, ...delivery });
    }
    if (sizeBytes !== null && written === sizeBytes) {
      // Complete length, wrong bytes: nothing to resume from.
      await store.discardPart(part);
      written = 0;
      hash = createHash("sha256");
    }
  } else if (existing) {
    await store.discardPart(part);
  }

  if (sizeBytes !== null) await assertFreeSpace(store, name, sizeBytes - written);

  const headers: Record<string, string> = { ...sourceHeaders, accept: "*/*", "accept-encoding": "identity" };
  if (written > 0) {
    headers.range = `bytes=${written}-`;
    // Without a digest the server must vouch that the object is unchanged.
    if (validator) headers["if-range"] = validator;
  }

  let response: RawResponse;
  try {
    response = await rawRequest("GET", transferUrl, headers, signal);
  } catch (error) {
    if (signal.aborted) throw abortError(`Download of ${name} was cancelled`);
    if (error instanceof MapCacheError) throw error;
    throw new MapCacheError(`Could not download ${name}: ${errorMessage(error)}`, "NetworkError");
  }

  let flags = written > 0 ? "a" : "w";
  let complete = false;
  if (written > 0) {
    if (response.status === 206) {
      const match = CONTENT_RANGE.exec(header(response.headers, "content-range") ?? "");
      const total = match && match[3] !== "*" ? Number(match[3]) : null;
      if (!match || Number(match[1]) !== written || (sizeBytes !== null && total !== null && total !== sizeBytes)
        || (validator && normalizeEtag(header(response.headers, "etag")) !== validator)) {
        response.body.resume();
        await store.discardPart(part);
        throw new MapCacheError(`The server could not resume ${name}; the partial download was discarded, try again`);
      }
    } else if (response.status === 200) {
      // Range ignored (or the object changed under If-Range): start over with the full body.
      hash = createHash("sha256");
      written = 0;
      flags = "w";
    } else if (response.status === 416 && sizeBytes === null) {
      response.body.resume();
      if (expectedSha256) {
        // Nothing past what we hold: the part is the whole object (verified below).
        complete = true;
      } else {
        // A 416 carries no validator, so a shorter replacement object is
        // indistinguishable from completion; only the digest could tell.
        await store.discardPart(part);
        return downloadIntoStore(args, transferUrl, sourceHeaders);
      }
    } else {
      response.body.resume();
      throw httpError(response.status, name);
    }
  } else if (response.status !== 200) {
    // 204/206 bodies are not the asset; a partial or empty answer must never be stored as one.
    response.body.resume();
    throw httpError(response.status, name);
  }

  if (sizeBytes !== null && response.status === 200) {
    const declared = header(response.headers, "content-length");
    if (declared !== null && Number(declared) !== sizeBytes) {
      response.body.resume();
      throw new MapCacheError(`${name} is ${formatBytes(Number(declared))} on the server but the map manifest declares ${formatBytes(sizeBytes)}`, "IntegrityError");
    }
  }
  const delivery: Delivery = complete
    ? await probeDelivery(transferUrl, sourceHeaders)
    : {
        mediaType: header(response.headers, "content-type") || DEFAULT_MEDIA_TYPE,
        etag: normalizeEtag(header(response.headers, "etag")),
        contentEncoding: contentEncodingOf(response.headers),
      };
  if (!expectedSha256) {
    if (delivery.etag) store.partValidators.set(part, delivery.etag);
    else store.partValidators.delete(part);
  }

  if (!complete) {
    const handle = await open(part, flags);
    // An interrupted part is worth keeping when a later attempt can prove
    // what it resumes into: the digest, or the delivery's validator.
    let keepPart = Boolean(expectedSha256 || delivery.etag);
    try {
      for await (const chunk of response.body) {
        const bytes = chunk as Buffer;
        written += bytes.byteLength;
        if (sizeBytes !== null && written > sizeBytes) {
          keepPart = false;
          throw new MapCacheError(`${name} is larger than the ${formatBytes(sizeBytes)} the map manifest declares`, "IntegrityError");
        }
        hash.update(bytes);
        await handle.write(bytes);
      }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      response.body.destroy();
      if (!keepPart) await store.discardPart(part);
      if (signal.aborted) throw abortError(`Download of ${name} was cancelled`);
      if (error instanceof MapCacheError) throw error;
      if (errorCode(error) === "ENOSPC") {
        throw new MapCacheError(`The disk holding ${store.root} is full; ${name} could not be stored`, "QuotaExceededError");
      }
      throw new MapCacheError(`Download of ${name} was interrupted: ${errorMessage(error)}`, "NetworkError");
    }
    await handle.close();
  }

  if (sizeBytes !== null && written !== sizeBytes) {
    await store.discardPart(part);
    throw new MapCacheError(`${name} ended after ${formatBytes(written)}, the map manifest declares ${formatBytes(sizeBytes)}`, "IntegrityError");
  }
  const sha256 = hash.digest("hex");
  if (expectedSha256 && sha256 !== expectedSha256) {
    await store.discardPart(part);
    throw new MapCacheError(`Integrity check failed for ${name}: the downloaded bytes do not match the map manifest`, "IntegrityError");
  }
  return publishPart({ store, part, sha256, written, ...delivery });
}

/**
 * Move a fully verified part into `objects/` and record it. Content dedup: if
 * the same bytes are already published *and verified*, keep that copy. A
 * same-named file of unknown provenance (adopted after an index loss) is only
 * kept when it hashes correctly; otherwise the fresh part replaces it.
 */
async function publishPart({ store, part, sha256, written, mediaType, etag, contentEncoding }: Delivery & { store: CacheStore; part: string; sha256: string; written: number }): Promise<Transferred> {
  const final = store.objectPath(sha256);
  await mkdir(join(store.objectsDir, sha256.slice(0, 2)), { recursive: true });
  const existing = await store.verified(sha256);
  if (existing) {
    await store.discardPart(part);
    return { sha256, sizeBytes: existing.bytes, mediaType: existing.mediaType };
  }
  try {
    await rename(part, final);
    store.partValidators.delete(part);
  } catch (error) {
    // Only a concurrent publisher of the same digest can win this race, and it
    // verified those bytes; Windows refuses to replace a file that is open.
    const code = errorCode(error);
    if (code !== "EEXIST" && code !== "EPERM") throw error;
    await store.discardPart(part);
  }
  await store.published(sha256, mediaType, etag, contentEncoding);
  return { sha256, sizeBytes: written, mediaType };
}
