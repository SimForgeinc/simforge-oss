// Renderer bridge for the connection chooser (sandboxed preload; CommonJS).
//
// Exposes exactly `window.simforgeConnections`, every method forwarding to a
// `simforge:connections:*` IPC handler in desktop/connections-window.mjs. The
// page never sees a token: pairing sends a code up and gets a row back, and
// the token goes from the main process into the OS vault.
//
// Runs with sandbox=true, so only `require("electron")` is available.

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const IPC_PREFIX = "simforge:connections:";

/** Handlers answer `{ ok: true, value }` or `{ ok: false, error: { name, message } }`. */
async function call(method, ...args) {
  const reply = await ipcRenderer.invoke(`${IPC_PREFIX}${method}`, ...args);
  if (reply && reply.ok === true) return reply.value;
  const detail = reply && reply.error ? reply.error : {};
  const failure = new Error(typeof detail.message === "string" ? detail.message : "The connection request failed");
  if (typeof detail.name === "string" && detail.name) failure.name = detail.name;
  throw failure;
}

contextBridge.exposeInMainWorld("simforgeConnections", {
  /** What the page shows: mode, rows, vault state. */
  state: () => call("state"),
  /** Reachability + contract check of one saved remote. */
  probe: (id) => call("probe", id),
  /** Attach to `"local"` or a remote id; the window closes on success. */
  choose: (id) => call("choose", id),
  /** Exchange a pairing code (or a simforge://connect link) for a saved, tokened row. */
  pair: (input) => call("pair", input),
  forget: (id) => call("forget", id),
  /** Lost mode: try the origin again; the window closes when it answers. */
  retry: () => call("retry"),
  /** Lost mode: relaunch into the chooser. */
  switchConnection: () => call("switch"),
  quit: () => call("quit"),
});
