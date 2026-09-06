// Behavioral regressions for desktop/map-cache.mjs: integrity, ranges,
// cancellation, authorization scope and root switching, against a real HTTP
// origin and fakes for the Electron session/ipcMain/window surface.
//
//   node --test studio/desktop/__tests__/map-cache.test.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { installDesktopMapCache } from "../map-cache.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MAP = "/api/simforge/maps/v1/browser-assets";

/** Minimal authenticated asset origin with Range, HEAD and scripted faults. */
async function startOrigin() {
  /** @type {Map<string, { bytes: Buffer, contentType?: string, cookie?: string }>} */
  const assets = new Map();
  /** @type {Array<{ method: string, path: string, range: string | null, cookie: string | null }>} */
  const requests = [];
  /** @type {{ path: string, after: number } | null} */
  let truncateNext = null;
  /** @type {Map<string, () => void>} path → release the held response */
  const held = new Map();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname + url.search;
    requests.push({ method: req.method, path, range: req.headers.range ?? null, cookie: req.headers.cookie ?? null });
    const asset = assets.get(path) ?? assets.get(url.pathname);
    if (!asset) {
      res.writeHead(404).end();
      return;
    }
    if (asset.cookie && req.headers.cookie !== asset.cookie) {
      res.writeHead(403).end();
      return;
    }
    if (held.has(url.pathname)) {
      await new Promise((release) => held.set(url.pathname, release));
      held.delete(url.pathname);
    }
    let bytes = asset.bytes;
    let status = 200;
    const headers = { "content-type": asset.contentType ?? "application/octet-stream", "accept-ranges": "bytes" };
    const range = req.headers.range ? /^bytes=(\d+)-$/.exec(req.headers.range) : null;
    if (range) {
      const start = Number(range[1]);
      if (start >= bytes.length) {
        res.writeHead(416, { "content-range": `bytes */${bytes.length}` }).end();
        return;
      }
      headers["content-range"] = `bytes ${start}-${bytes.length - 1}/${bytes.length}`;
      bytes = bytes.subarray(start);
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
    res.writeHead(status, headers).end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    assets,
    requests,
    truncate(path, after) {
      truncateNext = { path, after };
    },
    /** Hold the next body for `path` until the returned function is called. */
    hold(path) {
      held.set(path, () => undefined);
      return () => held.get(path)?.();
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Fakes for the Electron surface installDesktopMapCache touches. */
function fakeElectron(trustedOrigin, cookies = []) {
  let cookieList = cookies;
  const cookieListeners = new Set();
  let protocolHandler = null;
  const handlers = new Map();
  const session = {
    async fetch(input, init = {}) {
      const headers = new Headers(init.headers);
      if (init.credentials === "include" && new URL(input).origin === trustedOrigin && cookieList.length > 0) {
        headers.set("cookie", cookieList.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "));
      }
      return fetch(input, { ...init, headers });
    },
    cookies: {
      get: async () => cookieList,
      on: (_event, fn) => cookieListeners.add(fn),
      removeListener: (_event, fn) => cookieListeners.delete(fn),
    },
    protocol: {
      handle: (_scheme, fn) => {
        protocolHandler = fn;
      },
      unhandle: () => {
        protocolHandler = null;
      },
      isProtocolHandled: () => protocolHandler !== null,
    },
  };
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const webContents = { id: 7, mainFrame: { processId: 3, routingId: 1, url: `${trustedOrigin}/dashboard/scenario` } };
  const window = { isDestroyed: () => false, webContents };
  const trustedEvent = () => ({ sender: webContents, senderFrame: { ...webContents.mainFrame } });
  const raw = (event, method, ...args) => handlers.get(`simforge:map-cache:${method}`)(event, ...args);
  return {
    session,
    ipcMain,
    window,
    trustedEvent,
    raw,
    /** Call like the preload does: unwrap `{ ok, value | error }`. */
    async invoke(method, ...args) {
      const reply = await raw(trustedEvent(), method, ...args);
      if (reply.ok) return reply.value;
      const error = new Error(reply.error.message);
      error.name = reply.error.name;
      throw error;
    },
    setCookies(next) {
      cookieList = next;
      for (const fn of cookieListeners) fn();
    },
    serve: (url, init) => protocolHandler(new Request(url, init)),
    handled: () => protocolHandler !== null,
  };
}

describe("desktop map cache", () => {
  let origin;
  let workspace;
  const roots = [];
  const newRoot = async (name) => {
    const root = await mkdtemp(join(workspace, `${name}-`));
    roots.push(root);
    return root;
  };
  const install = (electron, root, extra = {}) =>
    installDesktopMapCache({
      session: electron.session,
      ipcMain: electron.ipcMain,
      window: electron.window,
      trustedOrigin: origin.origin,
      defaultCacheRoot: root,
      chooseDirectory: async () => null,
      ...extra,
    });

  before(async () => {
    origin = await startOrigin();
    workspace = await mkdtemp(join(tmpdir(), "simforge-map-cache-test-"));
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
    let electron = fakeElectron(origin.origin);
    let cache = await install(electron, root);

    const first = await electron.invoke("ensure", { requestId: "r1", url: `${MAP}/tiles/a.bin`, sha256: digest, sizeBytes: bytes.length });
    assert.equal(first.cacheHit, false);
    assert.equal(first.sha256, digest);
    assert.equal(first.sizeBytes, bytes.length);
    assert.match(first.url, /^simforge-cache:\/\/[a-f0-9]{32}\/[a-f0-9]{32}\/a\.bin$/);
    assert.equal((await stat(join(root, "objects", digest.slice(0, 2), digest))).size, bytes.length);

    const full = await electron.serve(first.url, { headers: { origin: origin.origin } });
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "application/x-tile");
    assert.equal(full.headers.get("access-control-allow-origin"), origin.origin);
    assert.equal(Buffer.from(await full.arrayBuffer()).toString(), "0123456789abcdef");

    const middle = await electron.serve(first.url, { headers: { range: "bytes=2-5" } });
    assert.equal(middle.status, 206);
    assert.equal(middle.headers.get("content-range"), "bytes 2-5/16");
    assert.equal(middle.headers.get("content-length"), "4");
    assert.equal(Buffer.from(await middle.arrayBuffer()).toString(), "2345");

    const tail = await electron.serve(first.url, { headers: { range: "bytes=-3" } });
    assert.equal(tail.headers.get("content-range"), "bytes 13-15/16");
    assert.equal(Buffer.from(await tail.arrayBuffer()).toString(), "def");

    const open = await electron.serve(first.url, { headers: { range: "bytes=12-" } });
    assert.equal(Buffer.from(await open.arrayBuffer()).toString(), "cdef");

    const beyond = await electron.serve(first.url, { headers: { range: "bytes=16-" } });
    assert.equal(beyond.status, 416);
    assert.equal(beyond.headers.get("content-range"), "bytes */16");

    const head = await electron.serve(first.url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "16");
    assert.equal(head.headers.get("accept-ranges"), "bytes");

    const status = await electron.invoke("status");
    assert.deepEqual({ ...status, availableBytes: typeof status.availableBytes }, {
      backend: "filesystem", directory: root, usedBytes: 16, availableBytes: "number", assetCount: 1, activeDownloads: 0,
    });

    await cache.dispose();
    assert.equal(electron.handled(), false);

    // Restart: same root, new process state, no browser storage involved.
    const requestsBefore = origin.requests.length;
    electron = fakeElectron(origin.origin);
    cache = await install(electron, root);
    assert.equal(await electron.invoke("has", { url: `${MAP}/tiles/a.bin`, sha256: digest }), true);
    assert.equal(await electron.invoke("has", { url: `${MAP}/tiles/a.bin` }), true, "verified URL alias answers without a digest");
    const warm = await electron.invoke("ensure", { requestId: "r2", url: `${MAP}/tiles/a.bin`, sha256: digest });
    assert.equal(warm.cacheHit, true);
    assert.equal(origin.requests.length, requestsBefore, "warm restart made no HTTP requests");
    const served = await electron.serve(warm.url);
    assert.equal(Buffer.from(await served.arrayBuffer()).toString(), "0123456789abcdef");
    await cache.dispose();
  });

  it("never publishes corrupt or short downloads and resumes an interrupted transfer", async () => {
    const bytes = Buffer.from("the quick brown fox jumps over the lazy dog");
    const digest = sha256(bytes);
    origin.assets.set(`${MAP}/fox.bin`, { bytes });
    const root = await newRoot("integrity");
    const electron = fakeElectron(origin.origin);
    const cache = await install(electron, root);

    const wrongDigest = sha256("something else");
    await assert.rejects(
      electron.invoke("ensure", { requestId: "bad-digest", url: `${MAP}/fox.bin`, sha256: wrongDigest }),
      (error) => error.name === "IntegrityError",
    );
    assert.equal(await electron.invoke("has", { url: `${MAP}/fox.bin`, sha256: wrongDigest }), false);
    assert.equal(await electron.invoke("has", { url: `${MAP}/fox.bin`, sha256: digest }), false, "a failed transfer teaches no alias");

    await assert.rejects(
      electron.invoke("ensure", { requestId: "bad-size", url: `${MAP}/fox.bin`, sha256: digest, sizeBytes: bytes.length + 1 }),
      (error) => error.name === "IntegrityError",
    );
    assert.deepEqual(await readdir(join(root, "objects")), [], "nothing published");

    origin.truncate(`${MAP}/fox.bin`, 10);
    await assert.rejects(
      electron.invoke("ensure", { requestId: "cut", url: `${MAP}/fox.bin`, sha256: digest, sizeBytes: bytes.length }),
      (error) => error.name === "NetworkError",
    );
    assert.equal(await electron.invoke("has", { url: `${MAP}/fox.bin`, sha256: digest }), false);
    // A TCP reset may discard every buffered body byte. Establish a durable
    // partial download explicitly, then prove restart resumes that exact prefix.
    await cache.dispose();
    await writeFile(join(root, "incomplete", `${digest}.part`), bytes.subarray(0, 10));
    const restartedElectron = fakeElectron(origin.origin);
    const restartedCache = await install(restartedElectron, root);

    const before = origin.requests.length;
    const resumed = await restartedElectron.invoke("ensure", { requestId: "resume", url: `${MAP}/fox.bin`, sha256: digest, sizeBytes: bytes.length });
    assert.equal(resumed.cacheHit, false);
    assert.equal(resumed.sizeBytes, bytes.length);
    const resumeRequest = origin.requests.slice(before).find((request) => request.method === "GET");
    assert.equal(resumeRequest.range, "bytes=10-");
    const served = await restartedElectron.serve(resumed.url);
    assert.equal(Buffer.from(await served.arrayBuffer()).toString(), bytes.toString());
    assert.deepEqual(await readdir(join(root, "incomplete")), []);
    await restartedCache.dispose();
  });

  it("re-verifies changed files and keeps unchanged ones without re-downloading", async () => {
    const bytes = Buffer.from("immutable-content-v1");
    const digest = sha256(bytes);
    origin.assets.set(`${MAP}/verify.bin`, { bytes });
    const root = await newRoot("tamper");
    const electron = fakeElectron(origin.origin);
    const cache = await install(electron, root);
    await electron.invoke("ensure", { requestId: "v1", url: `${MAP}/verify.bin`, sha256: digest });
    const objectPath = join(root, "objects", digest.slice(0, 2), digest);

    // Same bytes, new mtime (a copy or restore): rehash once, no download.
    const touched = new Date(Date.now() - 60_000);
    await utimes(objectPath, touched, touched);
    let downloads = origin.requests.filter((request) => request.method === "GET").length;
    const same = await electron.invoke("ensure", { requestId: "v2", url: `${MAP}/verify.bin`, sha256: digest });
    assert.equal(same.cacheHit, true);
    assert.equal(origin.requests.filter((request) => request.method === "GET").length, downloads);

    // Same length, different bytes: the stored verification is not trusted.
    await writeFile(objectPath, Buffer.from("immutable-content-vX"));
    downloads = origin.requests.filter((request) => request.method === "GET").length;
    const replaced = await electron.invoke("ensure", { requestId: "v3", url: `${MAP}/verify.bin`, sha256: digest });
    assert.equal(replaced.cacheHit, false);
    assert.equal(origin.requests.filter((request) => request.method === "GET").length, downloads + 1);
    assert.equal(sha256(await readFile(objectPath)), digest);

    const served = await electron.serve(replaced.url);
    assert.equal(Buffer.from(await served.arrayBuffer()).toString(), "immutable-content-v1");
    await cache.dispose();
  });

  it("coalesces concurrent requests and cancels per subscriber", async () => {
    const bytes = Buffer.alloc(4096, 7);
    const digest = sha256(bytes);
    origin.assets.set(`${MAP}/shared.bin`, { bytes });
    // Same bytes published by another map version: a different authorization unit.
    const ALIAS = "/api/simforge/maps/v2/browser-assets/alias-of-shared.bin";
    origin.assets.set(ALIAS, { bytes });
    const root = await newRoot("dedup");
    const electron = fakeElectron(origin.origin);
    const cache = await install(electron, root);

    let release = origin.hold(`${MAP}/shared.bin`);
    const before = origin.requests.length;
    const first = electron.invoke("ensure", { requestId: "c1", url: `${MAP}/shared.bin`, sha256: digest }).catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = electron.invoke("ensure", { requestId: "c2", url: ALIAS, sha256: digest });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await electron.invoke("status")).activeDownloads, 1, "one transfer for one digest");
    await electron.invoke("cancel", "c1");
    assert.equal((await first).name, "AbortError");
    release();
    const result = await second;
    assert.equal(result.sha256, digest);
    assert.equal(result.cacheHit, false);
    const gets = origin.requests.slice(before).filter((request) => request.method === "GET");
    assert.equal(gets.length, 1, "peer kept the single transfer alive");
    assert.equal(gets[0].path, `${MAP}/shared.bin`);
    // The joiner's own URL was never fetched, so its access was probed before a capability was issued.
    assert.ok(origin.requests.slice(before).some((request) => request.method === "HEAD" && request.path === ALIAS));

    // Cancelling the last subscriber aborts the transfer itself.
    origin.assets.set(`${MAP}/lonely.bin`, { bytes: Buffer.alloc(1024, 1) });
    const lonelyDigest = sha256(Buffer.alloc(1024, 1));
    release = origin.hold(`${MAP}/lonely.bin`);
    const lonely = electron.invoke("ensure", { requestId: "c3", url: `${MAP}/lonely.bin`, sha256: lonelyDigest }).catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await electron.invoke("cancel", "c3");
    assert.equal((await lonely).name, "AbortError");
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await electron.invoke("status")).activeDownloads, 0);
    assert.equal(await electron.invoke("has", { url: `${MAP}/lonely.bin`, sha256: lonelyDigest }), false);
    await cache.dispose();
  });

  it("refuses untrusted senders, foreign URLs, mutable paths and unknown capabilities", async () => {
    const bytes = Buffer.from("guarded");
    const digest = sha256(bytes);
    origin.assets.set(`${MAP}/guarded.bin`, { bytes });
    const root = await newRoot("security");
    const electron = fakeElectron(origin.origin);
    const cache = await install(electron, root);
    const stored = await electron.invoke("ensure", { requestId: "s1", url: `${MAP}/guarded.bin`, sha256: digest });

    const foreignFrame = { sender: electron.window.webContents, senderFrame: { processId: 3, routingId: 1, url: "https://evil.example/" } };
    assert.equal((await electron.raw(foreignFrame, "status")).error.name, "SecurityError");
    const childFrame = { sender: electron.window.webContents, senderFrame: { processId: 3, routingId: 9, url: `${origin.origin}/embed` } };
    assert.equal((await electron.raw(childFrame, "has", { url: `${MAP}/guarded.bin`, sha256: digest })).error.name, "SecurityError");
    const otherContents = { sender: { id: 99 }, senderFrame: electron.trustedEvent().senderFrame };
    assert.equal((await electron.raw(otherContents, "receipt", "k")).error.name, "SecurityError");

    await assert.rejects(electron.invoke("ensure", { requestId: "x1", url: "https://other.example/api/simforge/maps/v1/browser-assets/a", sha256: digest }), /Only map assets from/);
    await assert.rejects(electron.invoke("ensure", { requestId: "x2", url: "/api/map-assets/m1/3d-asset/manifest.json" }), /content digest/);
    await assert.rejects(electron.invoke("ensure", { requestId: "x3", url: `${MAP}/guarded.bin`, sha256: digest, downloadUrl: "http://cdn.example/x" }), /HTTPS/);
    await assert.rejects(electron.invoke("ensure", { requestId: "x4", url: `${MAP}/guarded.bin`, sha256: "nope" }), /SHA-256/);
    assert.equal(await electron.invoke("has", { url: "/api/map-assets/m1/3d-asset/mesh.glb" }), false);

    const [, , host, id] = stored.url.split("/");
    assert.equal((await electron.serve(`simforge-cache://${host}/${"0".repeat(32)}/x`)).status, 404);
    assert.equal((await electron.serve(`simforge-cache://${"0".repeat(32)}/${id}/x`)).status, 404);
    assert.equal((await electron.serve(stored.url, { headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await electron.serve(stored.url, { method: "POST" })).status, 405);

    await electron.invoke("clear");
    assert.equal((await electron.serve(stored.url)).status, 404, "clear() revokes capabilities");
    assert.equal(await electron.invoke("has", { url: `${MAP}/guarded.bin`, sha256: digest }), false);
    assert.deepEqual(await readdir(join(root, "objects")), []);
    assert.equal((await electron.invoke("status")).usedBytes, 0);
    await cache.dispose();
  });

  it("scopes cached private assets to the login that is authorized for them", async () => {
    const bytes = Buffer.from("alice-private-map");
    const digest = sha256(bytes);
    const alice = [{ name: "session", value: "alice", httpOnly: true }];
    const bob = [{ name: "session", value: "bob", httpOnly: true }];
    origin.assets.set(`${MAP}/private.bin`, { bytes, cookie: "session=alice" });
    const root = await newRoot("scope");
    const electron = fakeElectron(origin.origin, alice);
    const cache = await install(electron, root);

    const stored = await electron.invoke("ensure", { requestId: "a1", url: `${MAP}/private.bin`, sha256: digest });
    assert.equal((await electron.serve(stored.url)).status, 200);

    electron.setCookies(bob);
    const before = origin.requests.length;
    assert.equal(await electron.invoke("has", { url: `${MAP}/private.bin`, sha256: digest }), false);
    const probe = origin.requests.slice(before).find((request) => request.method === "HEAD");
    assert.equal(probe?.cookie, "session=bob", "the new login is checked with its own session");
    assert.equal((await electron.serve(stored.url)).status, 403, "another account cannot read through an observed capability");
    await assert.rejects(
      electron.invoke("ensure", { requestId: "b1", url: `${MAP}/private.bin`, sha256: digest }),
      (error) => error.name === "NotAuthorized",
    );

    electron.setCookies(alice);
    const requestsBefore = origin.requests.length;
    assert.equal((await electron.serve(stored.url)).status, 200);
    assert.equal(await electron.invoke("has", { url: `${MAP}/private.bin`, sha256: digest }), true);
    assert.equal(origin.requests.length, requestsBefore, "alice's grant was remembered");
    await cache.dispose();
  });

  it("switches the cache root without moving data and keeps receipts per root", async () => {
    const bytes = Buffer.from("root-a-content");
    const digest = sha256(bytes);
    origin.assets.set(`${MAP}/rootswitch.bin`, { bytes });
    const rootA = await newRoot("root-a");
    const rootB = await newRoot("root-b");
    let chosen = null;
    const electron = fakeElectron(origin.origin);
    let cache = await install(electron, rootA, { chooseDirectory: async () => chosen });

    const stored = await electron.invoke("ensure", { requestId: "m1", url: `${MAP}/rootswitch.bin`, sha256: digest });
    await electron.invoke("writeReceipt", "map::v1::closure", { completedAt: 1700000000000, assets: 1, bytes: bytes.length });
    assert.deepEqual(await electron.invoke("receipt", "map::v1::closure"), { completedAt: 1700000000000, assets: 1, bytes: bytes.length });
    await assert.rejects(electron.invoke("writeReceipt", "bad", { completedAt: 1, assets: -1, bytes: 0 }), /receipt/);

    assert.equal((await electron.invoke("chooseDirectory")).directory, rootA, "cancelled picker keeps the current root");
    chosen = rootB;
    const switched = await electron.invoke("chooseDirectory");
    assert.equal(switched.directory, rootB);
    assert.equal(switched.assetCount, 0);
    assert.equal((await stat(join(rootA, "objects", digest.slice(0, 2), digest))).size, bytes.length, "old root left intact");
    assert.equal((await electron.serve(stored.url)).status, 200, "capabilities issued before the switch keep streaming");
    assert.equal(await electron.invoke("has", { url: `${MAP}/rootswitch.bin`, sha256: digest }), false);
    assert.equal(await electron.invoke("receipt", "map::v1::closure"), null);
    const again = await electron.invoke("ensure", { requestId: "m2", url: `${MAP}/rootswitch.bin`, sha256: digest });
    assert.equal(again.cacheHit, false);
    assert.equal((await stat(join(rootB, "objects", digest.slice(0, 2), digest))).size, bytes.length);
    await cache.dispose();

    // The selection survives a restart; control files stay in the default root.
    assert.deepEqual(JSON.parse(await readFile(join(rootA, "location.json"), "utf8")), { version: 1, directory: rootB });
    const restarted = fakeElectron(origin.origin);
    cache = await install(restarted, rootA);
    const status = await restarted.invoke("status");
    assert.equal(status.directory, rootB);
    assert.equal(status.assetCount, 1);
    await cache.dispose();
  });
});
