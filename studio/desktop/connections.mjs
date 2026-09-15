// Which Studio host this shell attaches to: this computer, or a daemon on
// another machine. Everything here runs before any host page loads and is
// Electron-free so it can be tested under plain Node; the window that shows
// the chooser is desktop/connections-window.mjs.
//
// Targets are shell-side state: a small JSON file under the app's user-data
// directory lists the remote hosts the user has paired with and which one was
// chosen last. Their control tokens are NOT in that file. They are sealed by
// the OS credential store through Electron's `safeStorage` and kept in a
// second file, `host-tokens.json`, keyed `remote-host:<host origin>`.
//
// That namespace is the shell's own. The product's vault
// (studio/app/lib/cloud/vault.ts) is `@napi-rs/keyring` keyed by
// `(OS user, "simforge-studio", cloud origin)`, so two daemons that happen to
// share one SimCloud origin would collide there. The shell cannot use that
// keyring at all: it is a native `.node` binding and the shell ships as one
// esbuild bundle in app.asar with no node_modules (desktop/stage-app.mjs), so
// importing it makes the desktop package unbuildable. `safeStorage` is part of
// the Electron binary and its key lives in the OS store under the
// application's own Safe Storage entry — Keychain on macOS, DPAPI on Windows,
// libsecret/kwallet on Linux — which cannot collide with `simforge-studio` by
// construction.
//
// Sealing is required, never assumed: on Linux with no keyring daemon Chromium
// falls back to a `basic_text` backend whose key is hardcoded, which is a
// plaintext file with extra steps. That backend, and an unavailable
// `safeStorage`, both degrade to process memory — the row then reports that
// the host must be paired again after a relaunch. It never degrades to a file.
//
// Pairing replaces pasting a bearer token: `simforge host pair` on the host
// machine mints a short-lived, one-use code; the chooser exchanges it once
// through POST /api/simforge/host/pair and stores the token it receives. The
// token crosses the wire in a response body and is never part of a URL, the
// same discipline the browser ticket in /api/simforge/host/session keeps.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HostOrigin, hostPath, InvalidOriginError } from "@simforge-oss/studio-host/node";

export const CONNECTIONS_FILE = "connections.json";
const CONNECTIONS_SCHEMA = "simforge.desktop-connections/v1";
/** Sealed host control tokens, beside the target list; never the tokens themselves in the clear. */
export const SHELL_TOKEN_FILE = "host-tokens.json";
const TOKENS_SCHEMA = "simforge.desktop-host-tokens/v1";
/** The launch argument that shows the chooser even when a target is remembered. */
export const CHOOSE_CONNECTION_ARG = "--choose-connection";
export const PAIR_PATH = "/api/simforge/host/pair";
export const CONNECT_LINK_PROTOCOL = "simforge:";

/**
 * The exact origin of a Studio host, or a thrown explanation. Validation is
 * `HostOrigin.fromConfigured`, never a second copy of those rules; the shell
 * always applies the packaged rule, whatever build it is, because the rule is
 * about the link and not about the build. A plain-HTTP network origin is
 * reported as such and the caller decides whether an acknowledgement (a
 * ticked box, an environment variable) covers it.
 * @param {string} configured
 * @returns {{ origin: string; plaintextNetwork: boolean }}
 */
export function parseHostOrigin(configured) {
  const value = configured.trim();
  try {
    return { origin: HostOrigin.fromConfigured(value, "packaged").hrefForCookie(), plaintextNetwork: false };
  } catch (error) {
    if (!(error instanceof InvalidOriginError) || error.code !== "host_origin_plaintext_network") throw error;
    // The origin itself is valid; only the plaintext rule refused it, and
    // whether an acknowledgement covers that is the caller's to decide.
    const acknowledged = HostOrigin.fromConfigured(value, "packaged", { plaintextNetworkAcknowledged: true });
    return { origin: acknowledged.hrefForCookie(), plaintextNetwork: true };
  }
}

/**
 * Why a plain-HTTP network host is refused until the operator acknowledges
 * the link is private. Over plain HTTP the control token and the session
 * cookie cross the network in cleartext, and either is full access to the
 * host: database, artifacts, filesystem endpoints, job submission.
 * @param {string} origin
 * @param {string} acknowledgement how the acknowledgement is given in this surface
 */
export function plaintextRefusal(origin, acknowledgement) {
  return `${origin} is plain HTTP on a network address. The control token and the session cookie would cross the network in cleartext, and either one is full access to the host. `
    + `Put the host behind HTTPS, or reach it over a private tailnet (WireGuard/Tailscale) and acknowledge that ${acknowledgement}.`;
}

/**
 * One remote target the user may attach to.
 * @typedef {{ id: string; label: string; origin: string; plaintextAcknowledged: boolean; pairedAt: string }} RemoteTarget
 */

/**
 * The persisted selection: `"local"` for this computer, a remote target's id,
 * or null when nothing was chosen yet (first launch) or the user asked to
 * choose again.
 * @typedef {{ selected: string | null; remotes: RemoteTarget[] }} ConnectionsState
 */

/** @param {unknown} raw @returns {ConnectionsState} */
function parseState(raw) {
  const empty = { selected: null, remotes: [] };
  if (!raw || typeof raw !== "object" || raw.schema !== CONNECTIONS_SCHEMA || !Array.isArray(raw.remotes)) return empty;
  /** @type {RemoteTarget[]} */
  const remotes = [];
  for (const entry of raw.remotes) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || typeof entry.origin !== "string") continue;
    let origin;
    try {
      origin = parseHostOrigin(entry.origin).origin;
    } catch {
      continue;
    }
    if (remotes.some((known) => known.origin === origin)) continue;
    remotes.push({
      id: entry.id,
      label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : origin,
      origin,
      plaintextAcknowledged: entry.plaintextAcknowledged === true,
      pairedAt: typeof entry.pairedAt === "string" ? entry.pairedAt : "",
    });
  }
  const selected = raw.selected === "local" || remotes.some((remote) => remote.id === raw.selected) ? raw.selected : null;
  return { selected, remotes };
}

/**
 * The connections file under `dir`, read once and rewritten atomically on
 * every change. Tokens never pass through here.
 * @param {string} dir
 */
export async function openConnectionStore(dir) {
  const file = join(dir, CONNECTIONS_FILE);
  /** @type {ConnectionsState} */
  let state = { selected: null, remotes: [] };
  try {
    state = parseState(JSON.parse(await readFile(file, "utf8")));
  } catch {
    // Missing or unreadable: a fresh installation, or a file to overwrite.
  }
  async function save() {
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ schema: CONNECTIONS_SCHEMA, ...state }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }
  return {
    file,
    /** @returns {RemoteTarget[]} */
    remotes: () => state.remotes.map((remote) => ({ ...remote })),
    /** @returns {string | null} */
    selected: () => state.selected,
    /** @param {string} id */
    remote: (id) => state.remotes.find((remote) => remote.id === id) ?? null,
    /** @param {string | null} selected */
    async select(selected) {
      if (selected !== null && selected !== "local" && !state.remotes.some((remote) => remote.id === selected)) {
        throw new Error(`Unknown connection ${selected}`);
      }
      state.selected = selected;
      await save();
    },
    /**
     * Records a paired host. Origins are identities: pairing the same origin
     * again replaces the earlier entry rather than listing it twice.
     * @param {{ origin: string; label?: string; plaintextAcknowledged: boolean }} input
     * @returns {Promise<RemoteTarget>}
     */
    async add({ origin, label, plaintextAcknowledged }) {
      const parsed = parseHostOrigin(origin);
      const existing = state.remotes.find((remote) => remote.origin === parsed.origin);
      /** @type {RemoteTarget} */
      const remote = {
        id: existing?.id ?? randomBytes(9).toString("base64url"),
        label: label?.trim() || existing?.label || parsed.origin,
        origin: parsed.origin,
        plaintextAcknowledged: parsed.plaintextNetwork && plaintextAcknowledged,
        pairedAt: new Date().toISOString(),
      };
      state.remotes = [...state.remotes.filter((known) => known.id !== remote.id), remote];
      await save();
      return { ...remote };
    },
    /** @param {string} id @returns {Promise<RemoteTarget | null>} */
    async remove(id) {
      const removed = state.remotes.find((remote) => remote.id === id) ?? null;
      state.remotes = state.remotes.filter((remote) => remote.id !== id);
      if (state.selected === id) state.selected = null;
      await save();
      return removed;
    },
  };
}

/**
 * Whether `storage` really seals a secret. Electron reports encryption as
 * available on Linux even when Chromium picked the `basic_text` backend,
 * whose key is a constant in the binary: that is not a vault, and a token
 * sealed with it is a token written to disk in an obfuscated form.
 * @param {ShellStorage | undefined} storage
 */
function sealsSecrets(storage) {
  if (!storage || !storage.isEncryptionAvailable()) return false;
  const backend = storage.getSelectedStorageBackend?.();
  return backend !== "basic_text";
}

/**
 * Control tokens for remote hosts, sealed by the OS credential store through
 * Electron's `safeStorage` and held in `host-tokens.json` beside the target
 * list, keyed `remote-host:<host origin>` — the shell's own namespace, which
 * cannot collide with the product's `simforge-studio` keyring entries. When
 * the platform cannot actually seal a secret (no keyring daemon, so the
 * `basic_text` backend; or `safeStorage` unavailable outright) the tokens are
 * held in process memory and the vault says so. It never degrades to a file.
 *
 * @typedef {{ isEncryptionAvailable(): boolean; encryptString(plain: string): Buffer; decryptString(sealed: Buffer): string; getSelectedStorageBackend?: () => string }} ShellStorage
 * @param {{ dir: string; storage?: ShellStorage }} options
 *   `storage` is Electron's `safeStorage`; tests inject a fake, and omitting
 *   it (plain Node, no Electron) is the memory-only vault.
 */
export async function openShellVault({ dir, storage }) {
  const account = (origin) => `remote-host:${parseHostOrigin(origin).origin}`;
  if (!sealsSecrets(storage)) {
    /** @type {Map<string, string>} */
    const memory = new Map();
    return {
      persistence: /** @type {const} */ ("session"),
      /** @param {string} origin @returns {Promise<string | null>} */
      async get(origin) {
        return memory.get(account(origin)) ?? null;
      },
      /** @param {string} origin @param {string} token */
      async set(origin, token) {
        memory.set(account(origin), token);
      },
      /** @param {string} origin */
      async delete(origin) {
        return memory.delete(account(origin));
      },
    };
  }
  const file = join(dir, SHELL_TOKEN_FILE);
  /** @type {Record<string, string>} sealed tokens, base64, by account */
  let sealed = {};
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    if (raw?.schema === TOKENS_SCHEMA && raw.tokens && typeof raw.tokens === "object") sealed = raw.tokens;
  } catch {
    // Missing, unreadable or another schema: nothing is paired on this computer.
  }
  async function save() {
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ schema: TOKENS_SCHEMA, tokens: sealed }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }
  return {
    persistence: /** @type {const} */ ("os-sealed"),
    /** @param {string} origin @returns {Promise<string | null>} */
    async get(origin) {
      const entry = sealed[account(origin)];
      if (typeof entry !== "string") return null;
      try {
        return storage.decryptString(Buffer.from(entry, "base64"));
      } catch {
        // Sealed by another OS user, another machine, or a rotated key.
        return null;
      }
    },
    /** @param {string} origin @param {string} token */
    async set(origin, token) {
      sealed[account(origin)] = storage.encryptString(token).toString("base64");
      await save();
    },
    /** @param {string} origin */
    async delete(origin) {
      const key = account(origin);
      if (!(key in sealed)) return false;
      delete sealed[key];
      await save();
      return true;
    },
  };
}

/**
 * A `simforge://connect?origin=…&code=…` link as `simforge host pair` prints
 * it. It carries the host's origin and the one-use pairing code; the control
 * token is what the code is later exchanged for and is never in the link.
 * @param {string} link
 * @returns {{ origin: string; code: string }}
 */
export function parseConnectLink(link) {
  let url;
  try {
    url = new URL(link.trim());
  } catch {
    throw new Error("Expected a simforge://connect link");
  }
  if (url.protocol !== CONNECT_LINK_PROTOCOL || url.hostname !== "connect" && url.pathname.replace(/^\/+/, "") !== "connect") {
    throw new Error(`Expected a simforge://connect link — got ${link}`);
  }
  const origin = url.searchParams.get("origin") ?? "";
  const code = normalizePairingCode(url.searchParams.get("code") ?? "");
  if (!origin || !code) throw new Error("The connect link must carry both origin and code");
  return { origin: parseHostOrigin(origin).origin, code };
}

/** @param {string} origin @param {string} code */
export function connectLink(origin, code) {
  const params = new URLSearchParams({ origin: parseHostOrigin(origin).origin, code });
  return `simforge://connect?${params}`;
}

/** Codes are shown grouped for reading; the host compares them normalized. */
export function normalizePairingCode(code) {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Exchange a pairing code for the host's control token, once. The code
 * travels in a POST body to the pairing route, which deletes it whether or
 * not the exchange succeeds. Nothing here is persisted: the caller decides
 * what to store and where.
 * @param {{ origin: string; code: string; fetch?: typeof fetch }} input
 * @returns {Promise<{ controlToken: string }>}
 */
export async function claimPairingCode({ origin, code, fetch: doFetch = fetch }) {
  const base = parseHostOrigin(origin).origin;
  // Absolute URLs come from the origin module, never from `new URL(path, base)`.
  const url = HostOrigin.fromConfigured(base, "packaged", { plaintextNetworkAcknowledged: true }).toURL(hostPath(PAIR_PATH));
  const response = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: normalizePairingCode(code) }),
    signal: AbortSignal.timeout(10_000),
  }).catch((error) => {
    throw new Error(`No Studio host answered at ${base}: ${error?.message ?? error}`);
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const reason = body?.error === "pairing_code_invalid"
      ? "The pairing code was not accepted: it may have expired, been used already, or been mistyped. Run `simforge host pair` on the host again."
      : `The host at ${base} answered ${response.status}${body?.error ? ` (${body.error})` : ""}.`;
    throw new Error(reason);
  }
  if (!body || typeof body.controlToken !== "string" || !body.controlToken) {
    throw new Error(`The host at ${base} did not return a control token.`);
  }
  return { controlToken: body.controlToken };
}

/**
 * Pair with a host and remember it: the one place a token enters the vault.
 * Refuses a plain-HTTP network origin unless acknowledged, before any request
 * is made — the pairing exchange itself would already carry the token in
 * cleartext.
 * @param {{
 *   store: Awaited<ReturnType<typeof openConnectionStore>>;
 *   vault: Awaited<ReturnType<typeof openShellVault>>;
 *   origin: string;
 *   code: string;
 *   label?: string;
 *   plaintextAcknowledged: boolean;
 *   fetch?: typeof fetch;
 * }} input
 * @returns {Promise<RemoteTarget>}
 */
export async function pairRemoteHost({ store, vault, origin, code, label, plaintextAcknowledged, fetch: doFetch }) {
  const parsed = parseHostOrigin(origin);
  if (parsed.plaintextNetwork && !plaintextAcknowledged) {
    const refusal = new Error(plaintextRefusal(parsed.origin, "by ticking the private-link acknowledgement"));
    refusal.name = "PlaintextRefused";
    throw refusal;
  }
  const claimed = await claimPairingCode({ origin: parsed.origin, code, fetch: doFetch });
  await vault.set(parsed.origin, claimed.controlToken);
  const remote = await store.add({
    origin: parsed.origin,
    label,
    plaintextAcknowledged,
  });
  return remote;
}

/**
 * Forget a host: its row and its token, together.
 * @param {{ store: Awaited<ReturnType<typeof openConnectionStore>>; vault: Awaited<ReturnType<typeof openShellVault>>; id: string }} input
 */
export async function forgetRemoteHost({ store, vault, id }) {
  const removed = await store.remove(id);
  if (removed) await vault.delete(removed.origin);
  return removed;
}

/**
 * The attach target for a remembered remote, with its token from the vault.
 * The plaintext rule is re-checked here, not only at pairing time: the
 * acknowledgement is stored with the target and a target without it never
 * becomes a plaintext network attach.
 * @param {{ store: Awaited<ReturnType<typeof openConnectionStore>>; vault: Awaited<ReturnType<typeof openShellVault>>; id: string }} input
 * @returns {Promise<{ kind: "ready"; target: { baseUrl: string; controlToken: string }; remote: RemoteTarget } | { kind: "unpaired"; remote: RemoteTarget } | { kind: "refused"; remote: RemoteTarget; reason: string }>}
 */
export async function resolveRemoteTarget({ store, vault, id }) {
  const remote = store.remote(id);
  if (!remote) throw new Error(`Unknown connection ${id}`);
  const parsed = parseHostOrigin(remote.origin);
  if (parsed.plaintextNetwork && !remote.plaintextAcknowledged) {
    return { kind: "refused", remote, reason: plaintextRefusal(remote.origin, "by pairing again with the private-link acknowledgement ticked") };
  }
  const controlToken = await vault.get(remote.origin);
  if (!controlToken) return { kind: "unpaired", remote };
  return { kind: "ready", remote, target: { baseUrl: remote.origin, controlToken } };
}
