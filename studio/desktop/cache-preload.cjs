// Renderer bridge for the desktop map cache (sandboxed preload; CommonJS).
//
// Exposes exactly `window.simforgeDesktop = { version: 1, shell: "desktop", mapCache }` where
// every mapCache method forwards to a `simforge:map-cache:*` IPC handler in
// desktop/map-cache.mjs, which relays it to the local service's protected
// /api/simforge/map-cache/** endpoints. No fs paths, Node objects or IPC
// handles cross into the page; asset bytes never travel here, they stream
// through same-origin /api/simforge/map-cache/stream/... capability URLs.
//
// Runs with sandbox=true, so only `require("electron")` is available.

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const IPC_PREFIX = "simforge:map-cache:";

/**
 * Handlers answer `{ ok: true, value }` or `{ ok: false, error: { name, message } }`
 * so the renderer sees the user-readable message and error name (e.g.
 * AbortError, NotAuthorized) instead of Electron's "Error invoking remote
 * method" wrapper.
 * @param {string} method
 * @param {...unknown} args
 */
async function call(method, ...args) {
  let reply;
  try {
    reply = await ipcRenderer.invoke(`${IPC_PREFIX}${method}`, ...args);
  } catch (error) {
    const failure = new Error("The desktop map cache is not available in this window");
    failure.name = "DesktopBridgeError";
    failure.cause = error;
    throw failure;
  }
  if (reply && reply.ok === true) return reply.value;
  const detail = reply && reply.error ? reply.error : {};
  const failure = new Error(typeof detail.message === "string" ? detail.message : "The desktop map cache request failed");
  if (typeof detail.name === "string" && detail.name) failure.name = detail.name;
  throw failure;
}

async function callNative(method, ...args) {
  return call(`native-viewport:${method}`, ...args);
}

contextBridge.exposeInMainWorld("simforgeDesktop", {
  version: 1,
  // Which shell is hosting the page, as a fact rather than an inference.
  //
  // `version` and `mapCache` describe one capability: can this window cache map
  // bytes on disk. Callers that only need to know "am I in the desktop app"
  // used to infer it from `mapCache` being present, which is a different
  // question and answered wrongly whenever this preload fails to run — as it
  // did for the whole life of the product, when an early return above the
  // bridge left every Electron window looking like a browser tab. `shell` is
  // versionless and capability-free on purpose: it must stay answerable when
  // the map-cache half is absent, unsupported or broken.
  shell: "desktop",
  mapCache: {
    status: () => call("status"),
    has: (query) => call("has", query),
    ensure: (request) => call("ensure", request),
    cancel: (requestId) => call("cancel", requestId),
    receipt: (key) => call("receipt", key),
    writeReceipt: (key, receipt) => call("writeReceipt", key, receipt),
    clear: () => call("clear"),
    chooseDirectory: (options) => call("chooseDirectory", options),
  },
  nativeViewport: {
    profile: (mapVersionId) => callNative("profile", mapVersionId),
    start: () => callNative("start"),
    camera: (position, target) => callNative("camera", position, target),
    stop: () => callNative("stop"),
    onEvent: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on("simforge:native-viewport:event", handler);
      return () => ipcRenderer.removeListener("simforge:native-viewport:event", handler);
    },
  },
});
