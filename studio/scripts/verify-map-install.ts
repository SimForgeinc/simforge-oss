/**
 * End-to-end verification that the maps installed on THIS machine can be
 * installed into a fresh data root through the endpoints the application uses.
 *
 * It runs the real daemon (`simforge daemon --no-worker`, i.e. the built
 * Studio server) against its own throwaway data root and a free port, seeds it
 * the way boot does, and then drives
 * `POST /api/simforge/maps/<id>/install` + `GET .../install?profile=` to a
 * terminal state for both profiles of every selected map — no private function
 * is called, and nothing upstream is contacted.
 *
 * Checked for every map and profile:
 *   - the install reaches `ready`, never `error` (the regression this guards is
 *     `map_profile_not_installed` for a map that IS installed locally),
 *   - the map cache gained verified members and bytes, so a no-op cannot pass,
 *   - the materialized profile directory holds the profile's entry point,
 *   - `GET /api/simforge/maps` reports `ready` for exactly the profiles the
 *     installer accepted: the catalog and the installer disagreeing about what
 *     "installed" means is what broke local installs in the first place.
 * Then two honest-failure paths, in the throwaway root only: a member moved
 * out of the local object store must fail `map_profile_not_installed`, and a
 * member whose bytes no longer match its registered digest must fail
 * `map_member_integrity` instead of being ingested.
 *
 * The default set is `richmond-field-station` (small), `belmont-research-center`
 * (the second map the parent bug report named) and `garching-phase-1-2` (the
 * reported failure, and the largest installed closure at ~9.3 GB) — enough to
 * exercise the real path end to end, including a large map, in a few minutes.
 * `--all` (or `VERIFY_MAP_INSTALL_ALL=1`) runs every installed map instead.
 * `--root=<dir>` reuses (and keeps) a populated root, which is how the
 * idempotence of a second run is verified.
 *
 * Usage: pnpm --filter @simforge-oss/studio verify:map-install [--all] [--root=<dir>] [--port=<n>]
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "..");
const liveDaemonRoot = resolve(homedir(), ".local/share/simforge/daemon-data");
const liveMapsRoot = process.env.SIMFORGE_MAPS_CACHE_ROOT?.trim()
  || resolve(process.env.XDG_DATA_HOME?.trim() || resolve(homedir(), ".local/share"), "simforge/maps");
const DEFAULT_MAPS = ["richmond-field-station", "belmont-research-center", "garching-phase-1-2"];
/** Ports the live installation owns; a harness must never bind them. */
const RESERVED_PORTS = [5199, 5421, 5455];
const PORT_RANGE = { from: 5470, to: 5490 };
const PROFILES = ["browser", "semantic"] as const;
const ENTRY_POINT: Record<(typeof PROFILES)[number], string> = {
  browser: "3d/manifest.json",
  semantic: "master.gltf",
};
const BOOT_TIMEOUT_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 30 * 60_000;

type Profile = (typeof PROFILES)[number];

type InstallState = {
  mapVersionId: string;
  profile: Profile;
  /** `installed` is a complete closure with no job in the daemon's process. */
  state: "idle" | "installed" | "materializing" | "ready" | "error";
  progress: { members: number; completedMembers: number; bytes: number; completedBytes: number } | null;
  directory: string | null;
  message: string | null;
};

type CatalogMap = {
  mapVersionId: string;
  sourceMapId: string;
  label: string;
  ready: { browser: boolean; semantic: boolean };
  closureBytes: { browser: number; semantic: number } | null;
};

type CacheStatus = { directory: string; usedBytes: number; assetCount: number };

const failures: string[] = [];
const notes: string[] = [];

function pass(line: string) {
  console.log(`PASS ${line}`);
}

function fail(line: string) {
  failures.push(line);
  console.log(`FAIL ${line}`);
}

function check(condition: boolean, line: string) {
  if (condition) pass(line);
  else fail(line);
}

function formatBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let root: string | null = process.env.VERIFY_MAP_INSTALL_ROOT?.trim() || null;
  let port = Number(process.env.VERIFY_MAP_INSTALL_PORT ?? "") || null;
  let all = process.env.VERIFY_MAP_INSTALL_ALL === "1";
  for (const arg of args) {
    if (arg === "--all") all = true;
    else if (arg.startsWith("--root=")) root = resolve(arg.slice("--root=".length));
    else if (arg.startsWith("--port=")) port = Number(arg.slice("--port=".length));
    else throw new Error(`unknown argument ${arg}`);
  }
  return { root, port, all };
}

function delay(ms: number): Promise<void> {
  const { promise, resolve: done } = Promise.withResolvers<void>();
  setTimeout(done, ms);
  return promise;
}

async function freePort(preferred: number | null): Promise<number> {
  const candidates = preferred ? [preferred] : [];
  for (let port = PORT_RANGE.from; port <= PORT_RANGE.to; port++) {
    if (!preferred) candidates.push(port);
  }
  for (const port of candidates) {
    if (RESERVED_PORTS.includes(port)) continue;
    const { promise, resolve: settle } = Promise.withResolvers<boolean>();
    const probe = createServer();
    probe.once("error", () => settle(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => settle(true)));
    if (await promise) return port;
  }
  throw new Error(`no free port in ${PORT_RANGE.from}-${PORT_RANGE.to}`);
}

async function installedMapNames(): Promise<string[]> {
  return (await readdir(join(liveMapsRoot, "map-bundles"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Stage the selected maps into the throwaway root as a hardlink farm. The
 * installed store is read-only and ~32 GB; `cp -al` gives the seed real files
 * to publish at the cost of directory entries, and nothing is ever written
 * through a link (the tamper checks below unlink first).
 */
async function stageMaps(mapsRoot: string, names: string[]) {
  for (const profileDir of ["dev-assets", "map-bundles", ".corpus"]) {
    await mkdir(join(mapsRoot, profileDir), { recursive: true });
    for (const name of names) {
      const source = join(liveMapsRoot, profileDir, name);
      const target = join(mapsRoot, profileDir, name);
      if (!existsSync(source) || existsSync(target)) continue;
      await run("cp", ["-al", source, target]);
    }
  }
  const sumo = join(liveMapsRoot, "dev-assets", "sumo-runtime");
  const sumoTarget = join(mapsRoot, "dev-assets", "sumo-runtime");
  if (existsSync(sumo) && !existsSync(sumoTarget)) await run("cp", ["-al", sumo, sumoTarget]);
}

function run(command: string, args: string[]): Promise<void> {
  const { promise, resolve: done, reject } = Promise.withResolvers<void>();
  const child = spawn(command, args, { stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code === 0) done();
    else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
  });
  return promise;
}

/**
 * Every request carries the supervisor's control token: the local host gate
 * (`studio/proxy.ts`) stays armed, exactly as it is for the desktop shell, so
 * the harness exercises the same authorized path the app uses rather than an
 * open-access daemon.
 */
let controlToken = "";

async function get<T>(base: string, path: string): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    cache: "no-store",
    headers: { authorization: `Bearer ${controlToken}` },
  });
  if (!response.ok) throw new Error(`GET ${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

async function startDaemon(dataRoot: string, mapsRoot: string, port: number) {
  const cli = resolve(repoRoot, "packages/cli/bin/simforge.js");
  if (!existsSync(cli)) throw new Error(`no CLI at ${cli}; run \`pnpm -r build\` first`);
  if (!existsSync(resolve(appRoot, ".next"))) {
    throw new Error(`no Studio build at ${resolve(appRoot, ".next")}; run \`pnpm --filter @simforge-oss/studio build\` first`);
  }
  const child = spawn(process.execPath, [cli, "daemon", "--port", String(port), "--data-root", dataRoot, "--no-worker"], {
    cwd: appRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SIMFORGE_CLOUD_ROOT: dataRoot,
      SIMFORGE_MAPS_CACHE_ROOT: mapsRoot,
      PORT: String(port),
    },
  });
  // Forwarded, not inherited: an inherited stdout would keep this script's own
  // pipe open for as long as the daemon lives.
  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`daemon| ${chunk.toString()}`));
  child.stderr?.on("data", (chunk: Buffer) => process.stdout.write(`daemon! ${chunk.toString()}`));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let exited: number | null = null;
  child.once("exit", (code) => {
    exited = code ?? -1;
  });
  for (;;) {
    if (exited !== null) throw new Error(`daemon exited with ${exited} before it served ${base}`);
    if (Date.now() > deadline) {
      await stopDaemon(child);
      throw new Error(`daemon did not answer on ${base} within ${BOOT_TIMEOUT_MS} ms`);
    }
    const host = await readFile(join(dataRoot, "host.json"), "utf8").catch(() => null);
    if (host !== null) {
      const record: unknown = JSON.parse(host);
      if (record && typeof record === "object" && "controlToken" in record && typeof record.controlToken === "string") {
        controlToken = record.controlToken;
      }
    }
    try {
      if (controlToken === "") throw new Error("no control token yet");
      await get<{ maps: unknown }>(base, "/api/simforge/maps");
      return { child, base };
    } catch {
      await delay(1_000);
    }
  }
}

async function stopDaemon(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const { promise: stopped, resolve: seenExit } = Promise.withResolvers<void>();
  child.once("exit", () => seenExit());
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  await stopped;
  clearTimeout(timer);
}

/** Drive one install exactly as the onboarding client does, to a terminal state. */
async function install(base: string, mapVersionId: string, profile: Profile): Promise<InstallState> {
  const response = await fetch(`${base}/api/simforge/maps/${mapVersionId}/install`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${controlToken}` },
    body: JSON.stringify({ profile }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`POST install ${mapVersionId} ${profile} answered ${response.status}: ${body}`);
  }
  const deadline = Date.now() + INSTALL_TIMEOUT_MS;
  for (;;) {
    const state = await get<InstallState>(base, `/api/simforge/maps/${mapVersionId}/install?profile=${profile}`);
    if (state.state === "ready" || state.state === "error") return state;
    if (Date.now() > deadline) throw new Error(`install of ${mapVersionId} ${profile} did not settle`);
    await delay(500);
  }
}

async function cacheStatus(base: string): Promise<CacheStatus> {
  return get<CacheStatus>(base, "/api/simforge/map-cache/status");
}

async function forgetCachedObject(cacheRoot: string, sha256: string) {
  await rm(join(cacheRoot, "objects", sha256.slice(0, 2), sha256), { force: true });
}

/**
 * The staged file behind one closure member, plus the content-addressed
 * artifact key the publication stored it under. Hashing the staged file is
 * how the harness learns the digest without opening the database the daemon
 * holds.
 */
async function stagedMember(mapsRoot: string, name: string, relativePath: string) {
  const sourcePath = join(mapsRoot, "map-bundles", name, relativePath);
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(sourcePath)) {
    byteLength += (chunk as Buffer).byteLength;
    hash.update(chunk as Buffer);
  }
  const sha256 = hash.digest("hex");
  return { sha256, byteLength, sourcePath, key: join("maps", name, "objects", sha256) };
}

async function main() {
  const { root, port: requestedPort, all } = parseArgs();
  if (process.env.DATABASE_URL?.trim()) {
    throw new Error("Refusing map install verification while DATABASE_URL is set; this harness uses only a throwaway PGlite root.");
  }
  const reusing = root !== null;
  const dataRoot = root ?? await mkdtemp(join(tmpdir(), "simforge-map-install-"));
  assert.notEqual(resolve(dataRoot), liveDaemonRoot, "the harness must never use the live daemon data root");
  const port = await freePort(requestedPort);
  assert.equal(RESERVED_PORTS.includes(port), false);
  const mapsRoot = join(dataRoot, "installed-maps");
  const cacheRoot = join(dataRoot, "map-cache");

  const names = all ? await installedMapNames() : DEFAULT_MAPS.filter((name) => existsSync(join(liveMapsRoot, "map-bundles", name)));
  if (names.length === 0) throw new Error(`no installed maps found under ${liveMapsRoot}`);
  console.log(`root      ${dataRoot}${reusing ? " (reused)" : ""}`);
  console.log(`port      ${port}`);
  console.log(`maps      ${names.join(", ")}`);
  await mkdir(mapsRoot, { recursive: true });
  await stageMaps(mapsRoot, names);

  const daemon = await startDaemon(dataRoot, mapsRoot, port);
  try {
    const before = await cacheStatus(daemon.base);
    console.log(`cache     before: ${before.assetCount} members, ${formatBytes(before.usedBytes)} (${before.directory})`);

    const catalog = await get<{ maps: CatalogMap[] }>(daemon.base, "/api/simforge/maps");
    const selected = names.map((name) => {
      const map = catalog.maps.find((candidate) => candidate.sourceMapId === name);
      if (!map) throw new Error(`${name} is not in the catalog after seeding`);
      return { name, map };
    });

    const verdict = new Map<string, boolean>();
    for (const { name, map } of selected) {
      for (const profile of PROFILES) {
        const state = await install(daemon.base, map.mapVersionId, profile);
        verdict.set(`${map.mapVersionId}\0${profile}`, state.state === "ready");
        check(
          state.state === "ready" && state.message === null,
          `${name} ${profile}: install reached ${state.state}${state.message ? ` (${state.message})` : ""}`,
        );
        if (state.state !== "ready") continue;
        check(
          state.progress !== null && state.progress.completedMembers === state.progress.members
            && state.progress.completedBytes === state.progress.bytes,
          `${name} ${profile}: progress completed ${state.progress?.completedMembers}/${state.progress?.members} members,`
          + ` ${formatBytes(state.progress?.completedBytes ?? 0)}/${formatBytes(state.progress?.bytes ?? 0)}`,
        );
        const entryPoint = join(state.directory ?? "", ENTRY_POINT[profile]);
        const placed = await stat(entryPoint).catch(() => null);
        check(placed?.isFile() === true, `${name} ${profile}: materialized ${ENTRY_POINT[profile]} (${formatBytes(placed?.size ?? 0)})`);
      }
    }

    const after = await cacheStatus(daemon.base);
    console.log(`cache     after:  ${after.assetCount} members, ${formatBytes(after.usedBytes)}`);
    check(after.assetCount > 0 && after.usedBytes > 0, `map cache holds ${after.assetCount} verified members, ${formatBytes(after.usedBytes)}`);
    if (before.assetCount === 0) {
      check(after.assetCount > before.assetCount, `map cache grew from ${before.assetCount} to ${after.assetCount} members (no-op would fail here)`);
    } else {
      check(after.assetCount >= before.assetCount, `map cache kept its ${before.assetCount} members on a repeat run (now ${after.assetCount})`);
      notes.push("repeat run: the cache was already populated, so growth is not required");
    }

    // The bug: the catalog reported both profiles ready while the installer
    // refused the same profiles. Pin the agreement, not either side alone.
    const recatalog = await get<{ maps: CatalogMap[] }>(daemon.base, "/api/simforge/maps");
    for (const { name, map } of selected) {
      const fresh = recatalog.maps.find((candidate) => candidate.mapVersionId === map.mapVersionId);
      for (const profile of PROFILES) {
        const installed = verdict.get(`${map.mapVersionId}\0${profile}`) === true;
        check(
          fresh?.ready[profile] === installed,
          `${name} ${profile}: catalog ready=${String(fresh?.ready[profile])} agrees with the installer (${installed ? "ready" : "failed"})`,
        );
      }
      check(
        fresh?.closureBytes !== null && fresh?.closureBytes !== undefined && fresh.closureBytes.browser > 0,
        `${name}: catalog reports a local closure size (${formatBytes(fresh?.closureBytes?.browser ?? 0)} browser,`
        + ` ${formatBytes(fresh?.closureBytes?.semantic ?? 0)} semantic)`,
      );
    }

    // ── honest failures, in this throwaway root only ──────────────────────
    // `topology-index.json.gz` is a required browser member but not the
    // profile's entry point, so the catalog still calls the profile installed
    // while the bytes are gone: exactly the case the installer must refuse.
    const guard = selected[0]!;
    const guardId = guard.map.mapVersionId;
    const member = await stagedMember(mapsRoot, guard.name, "topology-index.json.gz");
    const memberPath = join(dataRoot, "artifacts", "local-artifacts", member.key);
    const parked = `${memberPath}.parked`;

    await forgetCachedObject(cacheRoot, member.sha256);
    await rename(memberPath, parked);
    const missing = await install(daemon.base, guardId, "browser");
    check(
      missing.state === "error" && missing.message === "map_profile_not_installed",
      `${guard.name}: a member missing from the local object store fails as`
      + ` ${missing.message ?? missing.state} (${formatBytes(member.byteLength)} member ${member.sha256.slice(0, 12)})`,
    );
    await rename(parked, memberPath);

    await forgetCachedObject(cacheRoot, member.sha256);
    // Unlink first: this file is a hardlink into the read-only installed store,
    // and writing in place would corrupt the real installation.
    await unlink(memberPath);
    await writeFile(memberPath, Buffer.alloc(member.byteLength, 0x5a));
    const corrupt = await install(daemon.base, guardId, "browser");
    check(
      corrupt.state === "error" && corrupt.message === "map_member_integrity",
      `${guard.name}: a member of the right size whose digest does not match fails as ${corrupt.message ?? corrupt.state}`,
    );
    await unlink(memberPath);
    await run("cp", ["-al", member.sourcePath, memberPath]);
    await forgetCachedObject(cacheRoot, member.sha256);
    const repaired = await install(daemon.base, guardId, "browser");
    check(repaired.state === "ready", `${guard.name}: reinstalls to ${repaired.state} once the member is back`);

    console.log("");
    for (const note of notes) console.log(`note ${note}`);
    if (failures.length > 0) {
      console.log(`\n${failures.length} check(s) failed:`);
      for (const line of failures) console.log(`  - ${line}`);
      process.exitCode = 1;
    } else {
      console.log(`\nverify-map-install: ${names.length} map(s) x ${PROFILES.length} profile(s) installed from the local store, all checks passed`);
    }
  } finally {
    await stopDaemon(daemon.child);
    if (!reusing) console.log(`root kept at ${dataRoot} (pass --root=${dataRoot} to re-run against it)`);
  }
}

void main().catch((error: unknown) => {
  console.error(`verify-map-install: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
