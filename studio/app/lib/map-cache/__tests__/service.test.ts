// Behavioral regressions for the local map cache service: integrity, raw
// Content-Encoding storage, ranges, cancellation, access-policy scoping, root
// switching, journal replay and native materialization, against a real HTTP
// origin and a fake map access policy.
//
//   env -u NODE_CHANNEL_FD -u NODE_CHANNEL_SERIALIZATION_MODE \
//     pnpm --filter ./studio exec tsx --test app/lib/map-cache/__tests__/service.test.ts

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { gzipSync } from "node:zlib";

import { MapCacheService, MATERIALIZED_SIDECAR, type MapCacheAccess } from "../cache";
import { MapCacheError } from "../store";
import type { ResolvedSource } from "../transfer";

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const MAP = "/api/simforge/maps/v1/browser-assets";
/**
 * Wait for an observable condition instead of a guessed duration. The only
 * clock involved is the retry interval; the assertion is the condition itself.
 */
async function until(condition: () => Promise<boolean> | boolean, what: string) {
  const deadline = Date.now() + 5000;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, what);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

/** A held origin response: `arrived` resolves when the request reached the server. */
type Gate = { arrived: Promise<void>; release: () => void };

type Origin = {
  origin: string;
  assets: Map<string, Asset>;
  requests: Seen[];
  gets: (since?: number) => Seen[];
  truncate: (path: string, afterBytes: number) => void;
  stall: (path: string, afterBytes: number) => () => void;
  hold: (path: string) => Gate;
  close: () => Promise<void>;
};

type Asset = {
  bytes: Buffer;
  contentType?: string;
  contentEncoding?: string;
  /** Required `Authorization` header value(s); others get 403. */
  auth?: string | string[];
  /** 307 to this delivery URL (a presigned object). */
  redirect?: string;
  etag?: string;
};
type Seen = { method: string; path: string; range: string | null; ifRange: string | null; authorization: string | null };

/** Minimal asset origin with Range, HEAD, redirects and scripted faults. */
async function startOrigin(): Promise<Origin> {
  const assets = new Map<string, Asset>();
  const requests: Seen[] = [];
  let truncateNext: { path: string; after: number } | null = null;
  const held = new Map<string, { arrived: () => void; released: Promise<void> }>();
  let stallNext: { path: string; after: number; stalled: Promise<void> } | null = null;

  const server: Server = createServer(async (req, res) => {
    // The fake policy points misses at `${origin}/upstream<canonical path>`: a
    // real upstream is never a map route of this host (the service refuses those).
    const url = new URL((req.url ?? "/").replace(/^\/upstream(?=\/)/, ""), "http://127.0.0.1");
    const path = url.pathname + url.search;
    requests.push({
      method: req.method ?? "GET",
      path,
      range: req.headers.range ?? null,
      ifRange: typeof req.headers["if-range"] === "string" ? req.headers["if-range"] : null,
      authorization: req.headers.authorization ?? null,
    });
    const asset = assets.get(path) ?? assets.get(url.pathname);
    if (!asset) {
      res.writeHead(404).end();
      return;
    }
    if (asset.auth && !(Array.isArray(asset.auth) ? asset.auth : [asset.auth]).includes(req.headers.authorization ?? "")) {
      res.writeHead(403).end();
      return;
    }
    if (asset.redirect) {
      res.writeHead(307, { location: asset.redirect, "cache-control": "private, max-age=300" }).end();
      return;
    }
    const gate = held.get(url.pathname);
    if (gate) {
      held.delete(url.pathname);
      gate.arrived();
      await gate.released;
    }
    let bytes = asset.bytes;
    let status = 200;
    const headers: Record<string, string> = { "content-type": asset.contentType ?? "application/octet-stream", "accept-ranges": "bytes" };
    if (asset.etag) headers.etag = asset.etag;
    if (asset.contentEncoding) headers["content-encoding"] = asset.contentEncoding;
    const range = req.headers.range ? /^bytes=(\d+)-(\d*)$/.exec(req.headers.range) : null;
    if (range) {
      const start = Number(range[1]);
      if (start >= bytes.length) {
        res.writeHead(416, { "content-range": `bytes */${bytes.length}` }).end();
        return;
      }
      const end = range[2] === "" ? bytes.length - 1 : Math.min(Number(range[2]), bytes.length - 1);
      headers["content-range"] = `bytes ${start}-${end}/${bytes.length}`;
      bytes = bytes.subarray(start, end + 1);
      status = 206;
    }
    headers["content-length"] = String(bytes.length);
    if (req.method === "HEAD") {
      res.writeHead(status, headers).end();
      return;
    }
    if (truncateNext && truncateNext.path === url.pathname) {
      const partial = bytes.subarray(0, truncateNext.after);
      truncateNext = null;
      res.writeHead(status, headers);
      res.write(partial, () => res.destroy());
      return;
    }
    if (stallNext && stallNext.path === url.pathname) {
      const { after: afterBytes, stalled } = stallNext;
      stallNext = null;
      res.writeHead(status, headers);
      res.write(bytes.subarray(0, afterBytes));
      await stalled;
      res.end(bytes.subarray(afterBytes));
      return;
    }
    res.writeHead(status, headers).end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return {
    origin,
    assets,
    requests,
    gets: (since = 0) => requests.slice(since).filter((request) => request.method === "GET"),
    truncate(path: string, afterBytes: number) {
      truncateNext = { path, after: afterBytes };
    },
    /** Send `after` bytes of the next body for `path`, then stall until the returned function is called. */
    stall(path: string, afterBytes: number) {
      let release!: () => void;
      stallNext = { path, after: afterBytes, stalled: new Promise<void>((resolve) => { release = resolve; }) };
      return release;
    },
    /** Hold the next body for `path` until `release()` is called. */
    hold(path: string): Gate {
      let arrived!: () => void;
      let release!: () => void;
      const arrivedPromise = new Promise<void>((resolve) => { arrived = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      held.set(path, { arrived, released });
      return { arrived: arrivedPromise, release };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type Registered = { sha256?: string; sizeBytes?: number; private?: boolean; path?: string; /** misbehaving policy: point at this host's own map route */ loopbackRoute?: boolean };

/**
 * Fake of `@/app/lib/cloud/access`: a registry of allowed local URLs with
 * their verified metadata, and one current session whose scope every private
 * map needs. Upstream is the test origin with the session's bearer token.
 */
function fakeAccess(origin: string) {
  const registry = new Map<string, Registered>();
  let session: string | null = null;
  const calls = { authorize: 0, resolve: 0 };
  const access: MapCacheAccess = {
    async authorize(url) {
      calls.authorize++;
      if (!url.startsWith("/api/simforge/")) throw new MapCacheError(`Not a local map asset URL: ${url}`);
      const entry = registry.get(url) ?? {};
      if (entry.private && !session) throw new MapCacheError("This map requires an active SimCloud connection", "NotAuthorized");
      return { scope: session ? `cloud:${session}` : "public", sha256: entry.sha256, sizeBytes: entry.sizeBytes };
    },
    async resolveSource(url): Promise<ResolvedSource> {
      calls.resolve++;
      const entry = registry.get(url);
      if (entry?.path) return { path: entry.path };
      if (entry?.loopbackRoute) return { url: `${origin}${url}` };
      return { url: `${origin}/upstream${url}`, headers: session ? { authorization: `Bearer ${session}` } : {} };
    },
  };
  return {
    access,
    registry,
    calls,
    setSession(next: string | null) {
      session = next;
    },
  };
}

describe("local map cache service", () => {
  let origin: Origin;
  let workspace: string;
  const newRoot = async (name: string) => mkdtemp(join(workspace, `${name}-`));
  const open = (controlDir: string, access: MapCacheAccess) => MapCacheService.open({ controlDir, access });
  const serve = (service: MapCacheService, url: string, init: RequestInit = {}) => {
    // "/api/simforge/map-cache/stream/<capability>/<name>"
    const capability = url.split("/")[5] ?? "";
    return service.serveCapability(new Request(`http://127.0.0.1${url}`, init), capability);
  };

  before(async () => {
    origin = await startOrigin();
    workspace = await mkdtemp(join(tmpdir(), "simforge-map-cache-test-"));
  });
  beforeEach(() => {
    origin.requests.length = 0;
    origin.assets.clear();
  });
  after(async () => {
    await origin.close();
    await rm(workspace, { recursive: true, force: true });
  });

  it("stores a verified asset, streams byte ranges and answers after restart without the network", async () => {
    const bytes = Buffer.from("0123456789abcdef");
    const digest = sha256(bytes);
    origin.assets.set(`${MAP}/tiles/a.bin`, { bytes, contentType: "application/x-tile" });
    const root = await newRoot("restart");
    const policy = fakeAccess(origin.origin);
    let service = await open(root, policy.access);

    const first = await service.ensure({ requestId: "r1", url: `${MAP}/tiles/a.bin`, sha256: digest, sizeBytes: bytes.length });
    assert.equal(first.cacheHit, false);
    assert.equal(first.sha256, digest);
    assert.equal(first.sizeBytes, bytes.length);
    assert.match(first.url, /^\/api\/simforge\/map-cache\/stream\/[a-f0-9]{32}\/a\.bin$/);
    assert.equal((await stat(join(root, "objects", digest.slice(0, 2), digest))).size, bytes.length);

    const full = await serve(service, first.url);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "application/x-tile");
    assert.equal(full.headers.get("cache-control"), "no-store");
    assert.equal(full.headers.get("content-encoding"), null);
    assert.equal(Buffer.from(await full.arrayBuffer()).toString(), "0123456789abcdef");

    const middle = await serve(service, first.url, { headers: { range: "bytes=2-5" } });
    assert.equal(middle.status, 206);
    assert.equal(middle.headers.get("content-range"), "bytes 2-5/16");
    assert.equal(middle.headers.get("content-length"), "4");
    assert.equal(Buffer.from(await middle.arrayBuffer()).toString(), "2345");

    const tail = await serve(service, first.url, { headers: { range: "bytes=-3" } });
    assert.equal(tail.headers.get("content-range"), "bytes 13-15/16");
    assert.equal(Buffer.from(await tail.arrayBuffer()).toString(), "def");

    const beyond = await serve(service, first.url, { headers: { range: "bytes=16-" } });
    assert.equal(beyond.status, 416);
    assert.equal(beyond.headers.get("content-range"), "bytes */16");

    const head = await serve(service, first.url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "16");
    assert.equal(head.headers.get("accept-ranges"), "bytes");
    assert.equal((await serve(service, first.url, { headers: { "if-none-match": `"${digest}"` } })).status, 304);

    const status = await service.status();
    assert.deepEqual({ ...status, availableBytes: typeof status.availableBytes }, {
      backend: "filesystem", directory: root, usedBytes: 16, availableBytes: "number", assetCount: 1, activeDownloads: 0, unavailable: null,
    });
    assert.deepEqual(await service.resolveCached(digest), { path: join(root, "objects", digest.slice(0, 2), digest), sizeBytes: 16 });
    await service.dispose();

    // Restart: same root, new process state, no browser storage, no upstream.
    const requestsBefore = origin.requests.length;
    service = await open(root, policy.access);
    assert.equal(await service.has({ url: `${MAP}/tiles/a.bin`, sha256: digest }), true);
    assert.equal(await service.has({ url: `http://127.0.0.1:5199${MAP}/tiles/a.bin` }), true, "verified URL alias answers without a digest, hostname-independent");
    const warm = await service.ensure({ requestId: "r2", url: `${MAP}/tiles/a.bin`, sha256: digest });
    assert.equal(warm.cacheHit, true);
    assert.equal(origin.requests.length, requestsBefore, "warm restart made no HTTP requests");
    assert.equal(policy.calls.resolve, 1, "the source is resolved only on a miss");
    assert.equal(Buffer.from(await (await serve(service, warm.url)).arrayBuffer()).toString(), "0123456789abcdef");
    await service.dispose();
  });

  it("never publishes corrupt or short downloads and resumes an interrupted transfer", async () => {
    const bytes = Buffer.from("the quick brown fox jumps over the lazy dog");
    const digest = sha256(bytes);
    origin.assets.set(`${MAP}/fox.bin`, { bytes });
    const root = await newRoot("integrity");
    const policy = fakeAccess(origin.origin);
    const service = await open(root, policy.access);

    const wrongDigest = sha256("something else");
    await assert.rejects(service.ensure({ requestId: "bad-digest", url: `${MAP}/fox.bin`, sha256: wrongDigest }), (error: Error) => error.name === "IntegrityError");
    assert.equal(await service.has({ url: `${MAP}/fox.bin`, sha256: wrongDigest }), false);
    assert.equal(await service.has({ url: `${MAP}/fox.bin`, sha256: digest }), false, "a failed transfer teaches no alias");

    await assert.rejects(
      service.ensure({ requestId: "bad-size", url: `${MAP}/fox.bin`, sha256: digest, sizeBytes: bytes.length + 1 }),
      (error: Error) => error.name === "IntegrityError",
    );
    assert.deepEqual(await readdir(join(root, "objects")), [], "nothing published");

    origin.truncate(`${MAP}/fox.bin`, 10);
    await assert.rejects(
      service.ensure({ requestId: "cut", url: `${MAP}/fox.bin`, sha256: digest, sizeBytes: bytes.length }),
      (error: Error) => error.name === "NetworkError",
    );
    assert.equal(await service.has({ url: `${MAP}/fox.bin`, sha256: digest }), false);
    // A TCP reset may discard every buffered body byte. Establish a durable
    // partial download explicitly, then prove restart resumes that exact prefix.
    await service.dispose();
    await writeFile(join(root, "incomplete", `${digest}.part`), bytes.subarray(0, 10));
    const restarted = await open(root, policy.access);

    const before = origin.requests.length;
    const resumed = await restarted.ensure({ requestId: "resume", url: `${MAP}/fox.bin`, sha256: digest, sizeBytes: bytes.length });
    assert.equal(resumed.cacheHit, false);
    assert.equal(resumed.sizeBytes, bytes.length);
    assert.equal(origin.gets(before)[0]?.range, "bytes=10-");
    assert.equal(Buffer.from(await (await serve(restarted, resumed.url)).arrayBuffer()).toString(), bytes.toString());
    assert.deepEqual(await readdir(join(root, "incomplete")), []);
    await restarted.dispose();
  });

  it("re-verifies changed files and keeps unchanged ones without re-downloading", async () => {
    const bytes = Buffer.from("immutable-content-v1");
    const digest = sha256(bytes);
    origin.assets.set(`${MAP}/verify.bin`, { bytes });
    const root = await newRoot("tamper");
    const policy = fakeAccess(origin.origin);
    const service = await open(root, policy.access);
    await service.ensure({ requestId: "v1", url: `${MAP}/verify.bin`, sha256: digest });
    const objectPath = join(root, "objects", digest.slice(0, 2), digest);

    // Same bytes, new mtime (a copy or restore): rehash once, no download.
    const touched = new Date(Date.now() - 60_000);
    await utimes(objectPath, touched, touched);
    let downloads = origin.gets().length;
    assert.equal((await service.ensure({ requestId: "v2", url: `${MAP}/verify.bin`, sha256: digest })).cacheHit, true);
    assert.equal(origin.gets().length, downloads);

    // Same length, different bytes: the stored verification is not trusted.
    await writeFile(objectPath, Buffer.from("immutable-content-vX"));
    downloads = origin.gets().length;
    const replaced = await service.ensure({ requestId: "v3", url: `${MAP}/verify.bin`, sha256: digest });
    assert.equal(replaced.cacheHit, false);
    assert.equal(origin.gets().length, downloads + 1);
    assert.equal(sha256(await readFile(objectPath)), digest);
    assert.equal(Buffer.from(await (await serve(service, replaced.url)).arrayBuffer()).toString(), "immutable-content-v1");
    await service.dispose();
  });

  it("coalesces concurrent requests for one digest and cancels per subscriber", async () => {
    const bytes = Buffer.alloc(4096, 7);
    const digest = sha256(bytes);
    origin.assets.set(`${MAP}/shared.bin`, { bytes });
    const ALIAS = "/api/simforge/maps/v2/browser-assets/alias-of-shared.bin";
    origin.assets.set(ALIAS, { bytes });
    const root = await newRoot("dedup");
    const policy = fakeAccess(origin.origin);
    const service = await open(root, policy.access);

    // Subscriber bookkeeping is private; the test waits on it only to order the
    // cancel after the join, never to assert it.
    const subscribers = (service as unknown as { subscribers: Map<string, unknown> }).subscribers;
    let gate = origin.hold(`${MAP}/shared.bin`);
    const before = origin.requests.length;
    const first = service.ensure({ requestId: "c1", url: `${MAP}/shared.bin`, sha256: digest }).catch((error: Error) => error);
    await gate.arrived;
    const second = service.ensure({ requestId: "c2", url: ALIAS, sha256: digest });
    await until(() => subscribers.has("c2"), "the second request joined the transfer");
    assert.equal((await service.status()).activeDownloads, 1, "one transfer for one digest");
    service.cancel("c1");
    assert.equal(((await first) as Error).name, "AbortError");
    gate.release();
    const result = await second;
    assert.equal(result.sha256, digest);
    assert.equal(result.cacheHit, false);
    assert.deepEqual(origin.gets(before).map((request) => request.path), [`${MAP}/shared.bin`], "peer kept the single transfer alive");
    assert.equal(await service.has({ url: ALIAS }), true, "the joiner's URL is aliased to the shared bytes");

    // Cancelling the last subscriber aborts the transfer itself.
    origin.assets.set(`${MAP}/lonely.bin`, { bytes: Buffer.alloc(1024, 1) });
    const lonelyDigest = sha256(Buffer.alloc(1024, 1));
    gate = origin.hold(`${MAP}/lonely.bin`);
    const lonely = service.ensure({ requestId: "c3", url: `${MAP}/lonely.bin`, sha256: lonelyDigest }).catch((error: Error) => error);
    await gate.arrived;
    service.cancel("c3");
    assert.equal(((await lonely) as Error).name, "AbortError");
    gate.release();
    await until(async () => (await service.status()).activeDownloads === 0, "the abandoned transfer was aborted");
    assert.equal(await service.has({ url: `${MAP}/lonely.bin`, sha256: lonelyDigest }), false);

    // An AbortSignal on ensure() is the same cancel for that subscriber only.
    gate = origin.hold(`${MAP}/lonely.bin`);
    const controller = new AbortController();
    const viaSignal = service.ensure({ requestId: "c4", url: `${MAP}/lonely.bin`, sha256: lonelyDigest }, controller.signal).catch((error: Error) => error);
    await gate.arrived;
    controller.abort();
    assert.equal(((await viaSignal) as Error).name, "AbortError");
    gate.release();
    await until(async () => (await service.status()).activeDownloads === 0, "the signalled transfer was aborted");
    await service.dispose();
  });

  it("refuses foreign URLs, digests the registry disagrees with, and unknown capabilities; clear revokes", async () => {
    const bytes = Buffer.from("guarded");
    const digest = sha256(bytes);
    origin.assets.set(`${MAP}/guarded.bin`, { bytes });
    const root = await newRoot("security");
    const policy = fakeAccess(origin.origin);
    policy.registry.set(`${MAP}/guarded.bin`, { sha256: digest, sizeBytes: bytes.length });
    const service = await open(root, policy.access);

    await assert.rejects(service.ensure({ requestId: "x1", url: `https://other.example${MAP}/a`, sha256: digest }), /served by this SimForge host/);
    await assert.rejects(service.ensure({ requestId: "x2", url: "/api/other/thing.bin" }), /Not a local map asset URL/);
    await assert.rejects(service.ensure({ requestId: "x3", url: `${MAP}/guarded.bin`, sha256: "nope" }), /SHA-256/);
    await assert.rejects(
      service.ensure({ requestId: "x4", url: `${MAP}/guarded.bin`, sha256: sha256("other") }),
      (error: Error) => error.name === "IntegrityError" && /registered map member/.test(error.message),
    );
    await assert.rejects(
      service.ensure({ requestId: "x5", url: `${MAP}/guarded.bin`, sizeBytes: 1 }),
      (error: Error) => error.name === "IntegrityError",
    );
    assert.equal(await service.has({ url: `${MAP}/guarded.bin`, sha256: sha256("other") }), false);
    policy.registry.set(`${MAP}/recursive.bin`, { loopbackRoute: true });
    origin.assets.set(`${MAP}/recursive.bin`, { bytes });
    await assert.rejects(service.ensure({ requestId: "x6", url: `${MAP}/recursive.bin` }), /points back at this service/);
    assert.equal(origin.gets().length, 0, "nothing was fetched for refused requests");

    // The registry's digest is the ground truth; a digest-less request uses it.
    const stored = await service.ensure({ requestId: "s1", url: `${MAP}/guarded.bin` });
    assert.equal(stored.sha256, digest);
    assert.match(stored.url, /^\/api\/simforge\/map-cache\/stream\/[a-f0-9]{32}\/guarded\.bin$/);
    assert.equal((await serve(service, `/api/simforge/map-cache/stream/${"0".repeat(32)}/x`)).status, 404);
    assert.equal((await serve(service, stored.url, { method: "POST" })).status, 405);

    await service.clear();
    assert.equal((await serve(service, stored.url)).status, 404, "clear() revokes capabilities");
    assert.equal(await service.has({ url: `${MAP}/guarded.bin`, sha256: digest }), false);
    assert.deepEqual(await readdir(join(root, "objects")), []);
    assert.equal((await service.status()).usedBytes, 0);
    await service.dispose();
  });

  it("gates private maps on the current session: no digest, file or observed capability grants access", async () => {
    const bytes = Buffer.from("alice-private-map");
    const digest = sha256(bytes);
    origin.assets.set(`${MAP}/private.bin`, { bytes, auth: ["Bearer alice", "Bearer carol"] });
    const root = await newRoot("scope");
    const policy = fakeAccess(origin.origin);
    policy.registry.set(`${MAP}/private.bin`, { sha256: digest, sizeBytes: bytes.length, private: true });
    const service = await open(root, policy.access);

    await assert.rejects(service.ensure({ requestId: "anon", url: `${MAP}/private.bin`, sha256: digest }), (error: Error) => error.name === "NotAuthorized");
    assert.equal(origin.gets().length, 0, "an unauthorized request never reaches upstream");

    policy.setSession("alice");
    const stored = await service.ensure({ requestId: "a1", url: `${MAP}/private.bin`, sha256: digest });
    assert.equal(origin.gets()[0]?.authorization, "Bearer alice", "the session's credentials fetched the miss");
    assert.equal((await serve(service, stored.url)).status, 200);

    // Signed out: the bytes are on disk, the digest is known, the capability was observed. None of it is access.
    policy.setSession(null);
    const before = origin.requests.length;
    assert.equal(await service.has({ url: `${MAP}/private.bin`, sha256: digest }), false);
    assert.equal((await serve(service, stored.url)).status, 403, "sign-out revokes an issued capability");
    await assert.rejects(service.ensure({ requestId: "b1", url: `${MAP}/private.bin`, sha256: digest }), (error: Error) => error.name === "NotAuthorized");
    assert.equal(await service.resolveCached(digest) !== null, true, "server-side callers authorize their map themselves");

    // Another authorized account reads the same bytes without a second download.
    policy.setSession("carol");
    const hit = await service.ensure({ requestId: "c1", url: `${MAP}/private.bin`, sha256: digest });
    assert.equal(hit.cacheHit, true);
    assert.notEqual(hit.url, stored.url, "capabilities are issued per scope");
    assert.equal((await serve(service, hit.url)).status, 200);
    assert.equal((await serve(service, stored.url)).status, 200, "alice's old capability answers carol too: the policy, not the id, is the gate");
    assert.equal(origin.requests.length, before, "no upstream traffic for warm authorized reads");
    await service.dispose();
  });

  it("follows the delivery redirect without leaking credentials and stores Content-Encoding members raw", async () => {
    const delivery = await startOrigin();
    try {
      const bytes = Buffer.from("signed-delivery-content");
      const digest = sha256(bytes);
      delivery.assets.set("/blob/signed.bin", { bytes, etag: '"blob-md5"' });
      origin.assets.set(`${MAP}/signed.bin`, { bytes, auth: "Bearer alice", redirect: `${delivery.origin}/blob/signed.bin` });
      const root = await newRoot("delivery");
      const policy = fakeAccess(origin.origin);
      policy.setSession("alice");
      const service = await open(root, policy.access);

      const stored = await service.ensure({ requestId: "d1", url: `${MAP}/signed.bin`, sha256: digest, sizeBytes: bytes.length });
      assert.equal(stored.cacheHit, false);
      assert.equal(origin.gets()[0]?.authorization, "Bearer alice");
      assert.equal(delivery.gets()[0]?.authorization, null, "credentials never follow a cross-origin redirect");
      assert.equal((await serve(service, stored.url)).status, 200);

      // A gzip member: the digest and size name the ENCODED bytes, which are what
      // is stored and replayed with the same Content-Encoding.
      const json = Buffer.from(JSON.stringify({ overlay: "x".repeat(200) }));
      const encoded = gzipSync(json);
      const encodedDigest = sha256(encoded);
      delivery.assets.set("/blob/enc.json", { bytes: encoded, contentEncoding: "gzip", contentType: "application/json", etag: '"enc-1"' });
      origin.assets.set(`${MAP}/enc.json`, { bytes: encoded, auth: "Bearer alice", redirect: `${delivery.origin}/blob/enc.json` });
      const member = await service.ensure({ requestId: "d3", url: `${MAP}/enc.json`, sha256: encodedDigest, sizeBytes: encoded.length });
      assert.equal(member.sizeBytes, encoded.length, "stored size is the encoded member size");
      assert.equal(sha256(await readFile(join(root, "objects", encodedDigest.slice(0, 2), encodedDigest))), encodedDigest);
      const served = await serve(service, member.url);
      assert.equal(served.headers.get("content-encoding"), "gzip");
      assert.equal(served.headers.get("content-type"), "application/json");
      assert.equal(served.headers.get("content-length"), String(encoded.length));
      assert.ok(encoded.equals(Buffer.from(await served.arrayBuffer())), "raw encoded bytes go out exactly once-decodable");
      await assert.rejects(
        service.ensure({ requestId: "d4", url: `${MAP}/enc.json`, sha256: sha256(json) }),
        (error: Error) => error.name === "IntegrityError",
        "the decoded digest does not identify the stored member",
      );
      await service.dispose();
    } finally {
      await delivery.close();
    }
  });

  it("copies a packaged local file source into the store with the same verification", async () => {
    const bytes = gzipSync(Buffer.from('{"topology":true}'));
    const digest = sha256(bytes);
    const source = join(workspace, "packaged-topology.json.gz");
    await writeFile(source, bytes);
    const root = await newRoot("file-source");
    const policy = fakeAccess(origin.origin);
    policy.registry.set(`${MAP}/topology-index.json.gz`, { sha256: digest, sizeBytes: bytes.length, path: source });
    policy.registry.set(`${MAP}/wrong.json.gz`, { sha256: sha256("not these bytes"), sizeBytes: bytes.length, path: source });
    const service = await open(root, policy.access);

    const stored = await service.ensure({ requestId: "f1", url: `${MAP}/topology-index.json.gz` });
    assert.equal(stored.sha256, digest);
    assert.equal(origin.requests.length, 0, "no HTTP for a packaged file");
    const served = await serve(service, stored.url);
    assert.equal(served.headers.get("content-type"), "application/gzip");
    assert.equal(served.headers.get("content-encoding"), null);
    assert.ok(bytes.equals(Buffer.from(await served.arrayBuffer())));
    await assert.rejects(service.ensure({ requestId: "f2", url: `${MAP}/wrong.json.gz` }), (error: Error) => error.name === "IntegrityError");
    assert.deepEqual(await readdir(join(root, "incomplete")), []);
    await service.dispose();
  });

  it("switches the cache root without moving data and keeps receipts per root", async () => {
    const bytes = Buffer.from("root-a-content");
    const digest = sha256(bytes);
    origin.assets.set(`${MAP}/rootswitch.bin`, { bytes });
    const rootA = await newRoot("root-a");
    const rootB = await newRoot("root-b");
    const policy = fakeAccess(origin.origin);
    let service = await open(rootA, policy.access);

    const stored = await service.ensure({ requestId: "m1", url: `${MAP}/rootswitch.bin`, sha256: digest });
    await service.writeReceipt("map::v1::closure", { completedAt: 1700000000000, assets: 1, bytes: bytes.length });
    assert.deepEqual(await service.receipt("map::v1::closure"), { completedAt: 1700000000000, assets: 1, bytes: bytes.length });
    await assert.rejects(service.writeReceipt("bad", { completedAt: 1, assets: -1, bytes: 0 }), /receipt/);

    await assert.rejects(service.setLocation("relative/path"), /absolute/);
    await assert.rejects(service.setLocation(join(rootA, "objects", "ab")), /inside the current cache/);
    const switched = await service.setLocation(rootB);
    assert.equal(switched.directory, rootB);
    assert.equal(switched.assetCount, 0);
    assert.equal((await stat(join(rootA, "objects", digest.slice(0, 2), digest))).size, bytes.length, "old root left intact");
    assert.equal((await serve(service, stored.url)).status, 200, "capabilities issued before the switch keep streaming");
    assert.equal(await service.has({ url: `${MAP}/rootswitch.bin`, sha256: digest }), false);
    assert.equal(await service.receipt("map::v1::closure"), null);
    const again = await service.ensure({ requestId: "m2", url: `${MAP}/rootswitch.bin`, sha256: digest });
    assert.equal(again.cacheHit, false);
    assert.equal((await stat(join(rootB, "objects", digest.slice(0, 2), digest))).size, bytes.length);
    await service.dispose();

    // The selection survives a restart; control files stay in the default root.
    assert.deepEqual(JSON.parse(await readFile(join(rootA, "location.json"), "utf8")), { version: 1, directory: rootB });
    service = await open(rootA, policy.access);
    const status = await service.status();
    assert.equal(status.directory, rootB);
    assert.equal(status.assetCount, 1);
    await service.dispose();
  });

  it("replays the journal after an unclean stop instead of rehashing or forgetting receipts", async () => {
    const bytes = Buffer.from("journaled-content");
    const digest = sha256(bytes);
    origin.assets.set(`${MAP}/journal.bin`, { bytes });
    const root = await newRoot("journal");
    const policy = fakeAccess(origin.origin);
    const service = await open(root, policy.access);
    await service.ensure({ requestId: "j1", url: `${MAP}/journal.bin` });
    await service.writeReceipt("map::journal", { completedAt: 1, assets: 1, bytes: bytes.length });
    await service.dispose();

    // The snapshot never saw this content; the journal did. Tear both the way a power loss would.
    const torn = await readFile(join(root, "index.json"), "utf8").catch(() => null);
    assert.equal(torn === null ? undefined : JSON.parse(torn).content[digest], undefined);
    assert.match(await readFile(join(root, "index.log"), "utf8"), new RegExp(`"c":"${digest}"`));
    await writeFile(join(root, "index.json"), "{\"version\":1,\"content\":{");
    await writeFile(join(root, "index.log"), "{\"u\":\"torn", { flag: "a" });

    const reopened = await open(root, policy.access);
    const before = origin.requests.length;
    assert.equal(await reopened.has({ url: `${MAP}/journal.bin` }), true, "URL alias came back from the journal");
    assert.deepEqual(await reopened.receipt("map::journal"), { completedAt: 1, assets: 1, bytes: bytes.length });
    assert.equal(origin.requests.length, before);
    const snapshot = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
    assert.equal(snapshot.content[digest].bytes, bytes.length, "startup compacted the journal into the snapshot");
    assert.equal(await readFile(join(root, "index.log"), "utf8"), "");
    await reopened.dispose();
  });

  it("refuses work while the chosen location is missing and reopens it when it returns", async () => {
    const control = await newRoot("control");
    const unplugged = join(workspace, `unplugged-${Date.now()}`);
    await writeFile(join(control, "location.json"), JSON.stringify({ version: 1, directory: unplugged }));
    const bytes = Buffer.from("external-drive-content");
    const digest = sha256(bytes);
    origin.assets.set(`${MAP}/external.bin`, { bytes });
    const policy = fakeAccess(origin.origin);
    const service = await open(control, policy.access);

    const offline = await service.status();
    assert.equal(offline.directory, unplugged);
    assert.match(offline.unavailable ?? "", /does not exist/);
    assert.equal(await service.has({ url: `${MAP}/external.bin`, sha256: digest }), false);
    await assert.rejects(service.ensure({ requestId: "u1", url: `${MAP}/external.bin`, sha256: digest }), /unavailable/);
    assert.equal(await service.receipt("anything"), null);
    assert.equal(await service.resolveCached(digest), null);
    await assert.rejects(service.materialize({ members: [], directory: join(workspace, "mat-unavailable") }), /unavailable/);
    assert.ok(!(await readdir(control)).includes("objects"), "nothing was downloaded into the default directory");
    assert.equal(await stat(unplugged).catch((error: NodeJS.ErrnoException) => error.code), "ENOENT", "the missing path was not recreated");

    await mkdir(unplugged);
    const stored = await service.ensure({ requestId: "u2", url: `${MAP}/external.bin`, sha256: digest });
    assert.equal(stored.cacheHit, false);
    const online = await service.status();
    assert.equal(online.directory, unplugged);
    assert.equal(online.unavailable, null);
    assert.equal(online.assetCount, 1);
    assert.equal((await stat(join(unplugged, "objects", digest.slice(0, 2), digest))).size, bytes.length);
    await service.dispose();
  });

  it("honours a cancel that races the transfer start and lets a retry start clean", async () => {
    const bytes = Buffer.alloc(2048, 3);
    const digest = sha256(bytes);
    origin.assets.set(`${MAP}/retry.bin`, { bytes });
    origin.assets.set(`${MAP}/early.bin`, { bytes });
    const root = await newRoot("retry");
    const policy = fakeAccess(origin.origin);
    const service = await open(root, policy.access);

    let before = origin.requests.length;
    const early = service.ensure({ requestId: "e1", url: `${MAP}/early.bin`, sha256: digest }).catch((error: Error) => error);
    service.cancel("e1");
    assert.equal(((await early) as Error).name, "AbortError");
    assert.equal(origin.requests.slice(before).filter((request) => request.path === `${MAP}/early.bin`).length, 0);

    const gate = origin.hold(`${MAP}/retry.bin`);
    before = origin.requests.length;
    const first = service.ensure({ requestId: "t1", url: `${MAP}/retry.bin`, sha256: digest }).catch((error: Error) => error);
    await gate.arrived;
    service.cancel("t1");
    const second = service.ensure({ requestId: "t2", url: `${MAP}/retry.bin`, sha256: digest });
    assert.equal(((await first) as Error).name, "AbortError");
    gate.release();
    const result = await second;
    assert.equal(result.sha256, digest);
    assert.equal(result.cacheHit, false);
    assert.ok(Buffer.from(await (await serve(service, result.url)).arrayBuffer()).equals(bytes));
    assert.equal(origin.gets(before).length, 2, "the retry ran its own transfer");
    await service.dispose();
  });

  it("resumes an aborted digest-less tile under If-Range within the process, never across a restart", async () => {
    const bytes = Buffer.from("tile-bytes-0123456789abcdefghijklmnopqrstuvwxyz");
    const digest = sha256(bytes);
    origin.assets.set(`${MAP}/tiles/t1.glb`, { bytes, etag: '"tile-v1"' });
    const root = await newRoot("tile-resume");
    const policy = fakeAccess(origin.origin);
    const service = await open(root, policy.access);
    const partName = `u-${sha256(`${MAP}/tiles/t1.glb`)}.part`;

    const proceed = origin.stall(`${MAP}/tiles/t1.glb`, 16);
    const aborted = service.ensure({ requestId: "tile1", url: `${MAP}/tiles/t1.glb` }).catch((error: Error) => error);
    await until(async () => (await stat(join(root, "incomplete", partName)).catch(() => null))?.size === 16, "the first 16 bytes reached the part file");
    service.cancel("tile1");
    assert.equal(((await aborted) as Error).name, "AbortError");
    proceed();
    assert.equal((await stat(join(root, "incomplete", partName))).size, 16, "the prefix is kept for resuming");

    const before = origin.requests.length;
    const resumed = await service.ensure({ requestId: "tile2", url: `${MAP}/tiles/t1.glb` });
    assert.equal(resumed.sha256, digest);
    const resume = origin.gets(before)[0];
    assert.equal(resume?.range, "bytes=16-");
    assert.equal(resume?.ifRange, '"tile-v1"', "the server must vouch the object is unchanged before a prefix is reused");
    assert.ok(Buffer.from(await (await serve(service, resumed.url)).arrayBuffer()).equals(bytes));
    assert.deepEqual(await readdir(join(root, "incomplete")), []);

    await writeFile(join(root, "incomplete", partName), bytes.subarray(0, 8));
    await service.dispose();
    const reopened = await open(root, policy.access);
    assert.deepEqual(await readdir(join(root, "incomplete")), []);
    await reopened.dispose();
  });

  it("materializes verified members for native jobs by hardlink, confined to the map root, surviving clear()", async () => {
    const mesh = Buffer.alloc(3000, 5);
    const manifest = Buffer.from('{"members":2}');
    const meshDigest = sha256(mesh);
    const manifestDigest = sha256(manifest);
    const SEM = "/api/simforge/maps/v9/semantic-assets";
    origin.assets.set(`${SEM}/3d/mesh.glb`, { bytes: mesh, auth: "Bearer alice" });
    origin.assets.set(`${SEM}/manifest.json`, { bytes: manifest, auth: "Bearer alice" });
    const root = await newRoot("materialize");
    const target = join(workspace, "maps", "v9", "semantic");
    const policy = fakeAccess(origin.origin);
    policy.registry.set(`${SEM}/3d/mesh.glb`, { sha256: meshDigest, sizeBytes: mesh.length, private: true });
    policy.registry.set(`${SEM}/manifest.json`, { sha256: manifestDigest, sizeBytes: manifest.length, private: true });
    const service = await open(root, policy.access);
    const members = [
      { path: "3d/mesh.glb", url: `${SEM}/3d/mesh.glb`, sha256: meshDigest, sizeBytes: mesh.length },
      { path: "manifest.json", url: `${SEM}/manifest.json`, sha256: manifestDigest, sizeBytes: manifest.length },
    ];

    await assert.rejects(service.materialize({ members, directory: target }), (error: Error) => error.name === "NotAuthorized");
    assert.equal(await stat(join(target, "manifest.json")).catch(() => null), null, "nothing placed for an unauthorized session");

    policy.setSession("alice");
    for (const path of ["../escape.bin", "/abs.bin", "a//b", "a/./b", "a/../b", "a\\b", MATERIALIZED_SIDECAR]) {
      await assert.rejects(service.materialize({ members: [{ ...members[0]!, path }], directory: target }), /member path/);
    }
    await assert.rejects(service.materialize({ members, directory: join(root, "objects", "aa") }), /inside the cache/);
    await assert.rejects(service.materialize({ members: [members[0]!, { ...members[0]!, url: `${SEM}/manifest.json` }], directory: target }), /Duplicate/);

    await service.materialize({ members, directory: target });
    const placedMesh = await stat(join(target, "3d", "mesh.glb"));
    const cachedMesh = await stat(join(root, "objects", meshDigest.slice(0, 2), meshDigest));
    assert.equal(placedMesh.size, mesh.length);
    assert.equal(placedMesh.ino, cachedMesh.ino, "same filesystem: a hardlink, not a copy");
    assert.ok(manifest.equals(await readFile(join(target, "manifest.json"))));
    assert.equal(origin.gets().length, 2, "each member downloaded once");
    assert.equal(await service.has({ url: `${SEM}/3d/mesh.glb` }), true, "the viewport shares the same object");

    // Re-run: only stats, no access or network work.
    const authorizeBefore = policy.calls.authorize;
    await service.materialize({ members, directory: target });
    assert.equal(policy.calls.authorize, authorizeBefore);
    assert.equal(origin.gets().length, 2);

    // A member rewritten under the job is detected and re-placed. The hardlink
    // shares the store's inode, so the store notices its object changed too,
    // discards it and fetches the verified bytes again instead of trusting either copy.
    await writeFile(join(target, "manifest.json"), "tampered");
    await service.materialize({ members, directory: target });
    assert.ok(manifest.equals(await readFile(join(target, "manifest.json"))));
    assert.equal(origin.gets().length, 3, "the corrupted shared object was re-verified and re-fetched once");
    assert.equal(sha256(await readFile(join(root, "objects", manifestDigest.slice(0, 2), manifestDigest))), manifestDigest);

    // Clear map cache: the job's inputs are untouched.
    await service.clear();
    assert.equal((await stat(join(target, "3d", "mesh.glb"))).size, mesh.length);
    assert.ok(manifest.equals(await readFile(join(target, "manifest.json"))));
    assert.deepEqual(await readdir(join(root, "objects")), []);
    const sidecar = JSON.parse(await readFile(join(target, MATERIALIZED_SIDECAR), "utf8"));
    assert.deepEqual(Object.keys(sidecar.files).sort(), ["3d/mesh.glb", "manifest.json"]);
    await service.dispose();
  });
});
