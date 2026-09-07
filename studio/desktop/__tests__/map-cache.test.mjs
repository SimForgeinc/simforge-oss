// Regressions for desktop/map-cache.mjs, the thin bridge between the renderer's
// `window.simforgeDesktop.mapCache` IPC and the local service's protected
// /api/simforge/map-cache/** endpoints. The store itself is tested in
// studio/app/lib/map-cache/__tests__/service.test.ts.
//
//   env -u NODE_CHANNEL_FD -u NODE_CHANNEL_SERIALIZATION_MODE node --test studio/desktop/__tests__/map-cache.test.mjs

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import { installDesktopMapCache } from "../map-cache.mjs";

const TRUSTED_ORIGIN = "http://localhost:5199";

/** A scripted stand-in for the local service: records every request, answers from `replies`. */
async function startService() {
  /** @type {Array<{ method: string, path: string, headers: import("node:http").IncomingHttpHeaders, body: unknown }>} */
  const requests = [];
  /** @type {Map<string, { status?: number, body: unknown }>} `METHOD path` → reply */
  const replies = new Map();
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const path = req.url ?? "/";
    requests.push({ method: req.method, path, headers: req.headers, body: raw === "" ? undefined : JSON.parse(raw) });
    const reply = replies.get(`${req.method} ${path}`) ?? { status: 404, body: { error: { name: "NotFound", message: `no reply for ${req.method} ${path}` } } };
    res.writeHead(reply.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    replies,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Fakes for the Electron surface the bridge touches. */
function fakeElectron() {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const webContents = { id: 7, mainFrame: { processId: 3, routingId: 1, url: `${TRUSTED_ORIGIN}/dashboard/scenario` } };
  const window = { isDestroyed: () => false, webContents };
  const trustedEvent = () => ({ sender: webContents, senderFrame: { ...webContents.mainFrame } });
  const raw = (event, method, ...args) => handlers.get(`simforge:map-cache:${method}`)(event, ...args);
  return {
    ipcMain,
    window,
    trustedEvent,
    raw,
    channels: () => [...handlers.keys()].sort(),
    /** Call like the preload does: unwrap `{ ok, value | error }`. */
    async invoke(method, ...args) {
      const reply = await raw(trustedEvent(), method, ...args);
      if (reply.ok) return reply.value;
      const error = new Error(reply.error.message);
      error.name = reply.error.name;
      throw error;
    },
  };
}

describe("desktop map cache bridge", () => {
  let service;
  let electron;
  let bridge;
  let chosen = null;

  before(async () => {
    service = await startService();
    electron = fakeElectron();
    bridge = await installDesktopMapCache({
      ipcMain: electron.ipcMain,
      window: electron.window,
      trustedOrigin: TRUSTED_ORIGIN,
      hostBaseUrl: service.baseUrl,
      hostAuthorization: async () => ({ authorization: "Bearer host-token" }),
      chooseDirectory: async () => chosen,
    });
  });
  after(async () => {
    await bridge.dispose();
    await service.close();
  });

  it("exposes exactly the eight bridge methods", () => {
    assert.deepEqual(electron.channels(), [
      "simforge:map-cache:cancel",
      "simforge:map-cache:chooseDirectory",
      "simforge:map-cache:clear",
      "simforge:map-cache:ensure",
      "simforge:map-cache:has",
      "simforge:map-cache:receipt",
      "simforge:map-cache:status",
      "simforge:map-cache:writeReceipt",
    ]);
  });

  it("forwards ensure with the host credentials and hands back a same-origin capability URL", async () => {
    service.replies.set("POST /api/simforge/map-cache/ensure", {
      body: { url: "/api/simforge/map-cache/stream/0123456789abcdef0123456789abcdef/a.bin", sha256: "ab".repeat(32), sizeBytes: 16, cacheHit: false },
    });
    const request = { requestId: "r1", url: `${TRUSTED_ORIGIN}/api/simforge/maps/v1/browser-assets/a.bin`, sha256: "ab".repeat(32), sizeBytes: 16 };
    const result = await electron.invoke("ensure", request);
    assert.equal(result.url, `${TRUSTED_ORIGIN}/api/simforge/map-cache/stream/0123456789abcdef0123456789abcdef/a.bin`);
    assert.equal(result.cacheHit, false);
    const seen = service.requests.at(-1);
    assert.equal(seen.headers.authorization, "Bearer host-token", "the per-start host secret authenticates the shell");
    assert.deepEqual(seen.body, request, "the request passes through unchanged; the service resolves its own source");
  });

  it("rethrows service errors under their own name and maps has/receipt/cancel/writeReceipt/clear", async () => {
    service.replies.set("POST /api/simforge/map-cache/ensure", { status: 403, body: { error: { name: "NotAuthorized", message: "This map requires an active SimCloud connection" } } });
    await assert.rejects(
      electron.invoke("ensure", { requestId: "r2", url: "/api/simforge/maps/v1/browser-assets/p.bin" }),
      (error) => error.name === "NotAuthorized" && /SimCloud connection/.test(error.message),
    );

    service.replies.set("POST /api/simforge/map-cache/has", { body: { cached: true } });
    assert.equal(await electron.invoke("has", { url: "/api/simforge/maps/v1/browser-assets/a.bin" }), true);
    service.replies.set("POST /api/simforge/map-cache/has", { body: { cached: false } });
    assert.equal(await electron.invoke("has", { url: "/api/simforge/maps/v1/browser-assets/a.bin" }), false);

    service.replies.set("POST /api/simforge/map-cache/cancel", { body: { ok: true } });
    assert.equal(await electron.invoke("cancel", "r1"), undefined);
    assert.deepEqual(service.requests.at(-1).body, { requestId: "r1" });

    service.replies.set("GET /api/simforge/map-cache/receipt?key=map%3A%3Av1%3A%3Aclosure", { body: { receipt: { completedAt: 1, assets: 2, bytes: 3 } } });
    assert.deepEqual(await electron.invoke("receipt", "map::v1::closure"), { completedAt: 1, assets: 2, bytes: 3 });
    service.replies.set("GET /api/simforge/map-cache/receipt?key=missing", { body: { receipt: null } });
    assert.equal(await electron.invoke("receipt", "missing"), null);

    service.replies.set("PUT /api/simforge/map-cache/receipt", { body: { ok: true } });
    await electron.invoke("writeReceipt", "map::v1::closure", { completedAt: 1, assets: 2, bytes: 3 });
    assert.deepEqual(service.requests.at(-1).body, { key: "map::v1::closure", receipt: { completedAt: 1, assets: 2, bytes: 3 } });

    service.replies.set("POST /api/simforge/map-cache/clear", { body: { backend: "filesystem", usedBytes: 0 } });
    assert.equal(await electron.invoke("clear"), undefined);

    service.replies.set("GET /api/simforge/map-cache/status", { body: { backend: "filesystem", directory: "/data", usedBytes: 1, availableBytes: 2, assetCount: 3, activeDownloads: 0, unavailable: null } });
    assert.equal((await electron.invoke("status")).directory, "/data");
  });

  it("only main names a cache directory: the picker's path goes to the protected location endpoint", async () => {
    service.replies.set("GET /api/simforge/map-cache/status", { body: { backend: "filesystem", directory: "/data", usedBytes: 0, availableBytes: 0, assetCount: 0, activeDownloads: 0, unavailable: null } });
    chosen = null;
    let before = service.requests.length;
    assert.equal((await electron.invoke("chooseDirectory")).directory, "/data", "a cancelled picker reports the current status");
    assert.deepEqual(service.requests.slice(before).map((request) => `${request.method} ${request.path}`), ["GET /api/simforge/map-cache/status"]);

    chosen = "/mnt/maps";
    service.replies.set("POST /api/simforge/map-cache/location", { body: { backend: "filesystem", directory: "/mnt/maps", usedBytes: 0, availableBytes: 0, assetCount: 0, activeDownloads: 0, unavailable: null } });
    before = service.requests.length;
    assert.equal((await electron.invoke("chooseDirectory")).directory, "/mnt/maps");
    const location = service.requests.slice(before).find((request) => request.path === "/api/simforge/map-cache/location");
    assert.deepEqual(location.body, { directory: "/mnt/maps" });
    assert.equal(location.headers.authorization, "Bearer host-token");
  });

  it("refuses untrusted senders before touching the service", async () => {
    const before = service.requests.length;
    const foreignFrame = { sender: electron.window.webContents, senderFrame: { processId: 3, routingId: 1, url: "https://evil.example/" } };
    assert.equal((await electron.raw(foreignFrame, "status")).error.name, "SecurityError");
    const childFrame = { sender: electron.window.webContents, senderFrame: { processId: 3, routingId: 9, url: `${TRUSTED_ORIGIN}/embed` } };
    assert.equal((await electron.raw(childFrame, "clear")).error.name, "SecurityError");
    const otherContents = { sender: { id: 99 }, senderFrame: electron.trustedEvent().senderFrame };
    assert.equal((await electron.raw(otherContents, "chooseDirectory")).error.name, "SecurityError");
    assert.equal(service.requests.length, before);
  });

  it("reports an unreachable local service as a NetworkError and rejects non-loopback hosts", async () => {
    const unreachable = await startService();
    await unreachable.close();
    const isolated = fakeElectron();
    const installed = await installDesktopMapCache({
      ipcMain: isolated.ipcMain,
      window: isolated.window,
      trustedOrigin: TRUSTED_ORIGIN,
      hostBaseUrl: unreachable.baseUrl,
      hostAuthorization: async () => ({}),
      chooseDirectory: async () => null,
    });
    await assert.rejects(isolated.invoke("status"), (error) => error.name === "NetworkError" && /not reachable/.test(error.message));
    await installed.dispose();
    assert.deepEqual(isolated.channels(), []);
    await assert.rejects(
      installDesktopMapCache({ ipcMain: isolated.ipcMain, window: isolated.window, trustedOrigin: TRUSTED_ORIGIN, hostBaseUrl: "http://simforge.ai", hostAuthorization: async () => ({}), chooseDirectory: async () => null }),
      /loopback/,
    );
  });
});
