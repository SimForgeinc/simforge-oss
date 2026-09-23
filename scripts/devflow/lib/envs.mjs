// Agent env bookkeeping: state files, port allocation, tailnet HTTPS mappings.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { CACHE_ROOT, commandExists, trySh } from "./util.mjs";

export const ENVS_DIR = join(CACHE_ROOT, "envs");

export function statePath(repo, name) {
  return join(ENVS_DIR, repo, `${name}.json`);
}

export function readState(repo, name) {
  try {
    return JSON.parse(readFileSync(statePath(repo, name), "utf8"));
  } catch {
    return null;
  }
}

export function writeState(state) {
  mkdirSync(join(ENVS_DIR, state.repo), { recursive: true });
  writeFileSync(statePath(state.repo, state.name), `${JSON.stringify(state, null, 2)}\n`);
}

export function removeState(repo, name) {
  rmSync(statePath(repo, name), { force: true });
}

export function allStates() {
  if (!existsSync(ENVS_DIR)) return [];
  const out = [];
  for (const repo of readdirSync(ENVS_DIR)) {
    const dir = join(ENVS_DIR, repo);
    if (!existsSync(dir) || repo.startsWith(".")) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      try {
        out.push(JSON.parse(readFileSync(join(dir, file), "utf8")));
      } catch {}
    }
  }
  return out;
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "0.0.0.0", exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/**
 * Allocates `count` consecutive-free ports in [4100, 4400) not claimed by any
 * other env and not listening. HTTPS tailnet port = app port + 1000.
 */
export async function allocatePorts(count, taken = new Set()) {
  const claimed = new Set(taken);
  for (const s of allStates()) {
    Object.values(s.ports ?? {}).forEach((p) => claimed.add(p));
    if (s.httpsPort) claimed.add(s.httpsPort);
  }
  const served = servedPorts();
  const ports = [];
  for (let p = 4100; p < 4400 && ports.length < count; p += 1) {
    if (claimed.has(p) || served.has(p + 1000)) continue;
    if (await portFree(p)) ports.push(p);
  }
  if (ports.length < count) throw new Error("no free ports in 4100-4399");
  return ports;
}

// ---------------------------------------------------------------- tailscale serve
export function tailnetHost() {
  if (!commandExists("tailscale")) return null;
  const json = trySh("tailscale", ["status", "--json"], { timeout: 10_000 });
  if (!json) return null;
  try {
    return JSON.parse(json).Self?.DNSName?.replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

function serveStatus() {
  const json = trySh("tailscale", ["serve", "status", "--json"], { timeout: 10_000 });
  try {
    return json ? JSON.parse(json) : {};
  } catch {
    return {};
  }
}

export function servedPorts() {
  if (!commandExists("tailscale")) return new Set();
  return new Set(Object.keys(serveStatus().TCP ?? {}).map(Number));
}

/** What `https://<host>:<httpsPort>/` proxies to today, or null. */
function serveTarget(host, httpsPort) {
  const web = serveStatus().Web ?? {};
  return web[`${host}:${httpsPort}`]?.Handlers?.["/"]?.Proxy ?? null;
}

/**
 * Maps https://<host>:<httpsPort> -> http://127.0.0.1:<port>. Refuses to touch
 * a port that already proxies somewhere else (other envs, :3443 -> :3300, ...).
 */
export function ensureServe(host, httpsPort, port) {
  const target = `http://127.0.0.1:${port}`;
  const current = serveTarget(host, httpsPort);
  if (current === target) return { ok: true, url: `https://${host}:${httpsPort}` };
  if (current || servedPorts().has(httpsPort)) return { ok: false, reason: `:${httpsPort} already serves ${current ?? "something else"}` };
  const out = trySh("tailscale", ["serve", "--bg", `--https=${httpsPort}`, target], { timeout: 20_000 });
  if (out === null) return { ok: false, reason: "tailscale serve failed (is this user a tailscale operator?)" };
  return { ok: true, url: `https://${host}:${httpsPort}` };
}

/** Removes only our own mapping, and only if it still points at our port. */
export function removeServe(host, httpsPort, port) {
  if (!host || !httpsPort) return;
  const current = serveTarget(host, httpsPort);
  if (current !== `http://127.0.0.1:${port}`) return;
  trySh("tailscale", ["serve", `--https=${httpsPort}`, "off"], { timeout: 20_000 });
}
