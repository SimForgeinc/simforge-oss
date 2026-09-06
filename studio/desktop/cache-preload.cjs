// Renderer bridge for the desktop map cache (sandboxed preload; CommonJS).
//
// Exposes exactly `window.simforgeDesktop = { version: 1, mapCache }` where
// every mapCache method forwards to a `simforge:map-cache:*` IPC handler in
// desktop/map-cache.mjs and resolves with its value. No fs paths, Node
// objects or IPC handles cross into the page; asset bytes never travel here,
// they stream through simforge-cache:// capability URLs.
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

contextBridge.exposeInMainWorld("simforgeDesktop", {
  version: 1,
  mapCache: {
    status: () => call("status"),
    has: (query) => call("has", query),
    ensure: (request) => call("ensure", request),
    cancel: (requestId) => call("cancel", requestId),
    receipt: (key) => call("receipt", key),
    writeReceipt: (key, receipt) => call("writeReceipt", key, receipt),
    clear: () => call("clear"),
    chooseDirectory: () => call("chooseDirectory"),
  },
});
