#!/usr/bin/env node
// Stages the SimForge Studio desktop artifact for the build host's target.
//
//   node desktop/stage.mjs [--skip-next-build]
//
// Produces, under studio/dist/desktop:
//   app/        the Electron application: a dependency-free package.json, the
//               bundled shell (main.mjs), the cache preload, the static pages
//               and the icon; packed into the asar by electron-builder
//               (see desktop/stage-app.mjs).
//   resources/  the self-contained local host, copied to <resources>/studio
//               by desktop/after-pack.mjs. Its root mirrors the repository
//               layout so the bundled host finds staged assets where the
//               workspace keeps them:
//                 studio/server.js, studio/.next, studio/public   Next standalone output
//                 studio/host/{host,host-main,worker}.mjs         bundled supervisor and worker
//                 studio/migrations                               SQL migrations
//                 studio/tools/{ffmpeg,ffprobe}[.exe]             pinned encoders (desktop/tools.lock.json)
//                 studio/actor-assets                             pinned actor-appearance closure
//                 studio/node_modules, node_modules/.pnpm         traced runtime closure (POSIX: pnpm links;
//                                                                 Windows: plain copies under studio/node_modules)
//                 packages/…                                      assets read by path
//                 packages/native-runtime/native/*.node           N-API addon for this target
//                 runtime/                                        verified native runtime archive
//                                                                 (runner, Bevy render service, FFI library, sky plates)
//                 stage-manifest.json                             desktop/stage-manifest.mjs
//
// Nothing in the stage points outside it: every symlink is verified to
// resolve inside the stage, so an artifact never depends on the checkout or
// on a global pnpm/tsx/Node/Python. The interpreter at runtime is Electron in
// Node mode. Native pieces are staged for the build host's target only (the
// N-API addon, sharp, the keyring binding, the runtime archive are all
// target-specific and are not cross-built here); the manifest records that
// target, `verifyNativeClosure` proves every native binding, executable and
// library in the stage was built for it, and the shell refuses to run
// elsewhere. Windows, macOS and Linux artifacts are therefore staged on their
// own platform (see .github/workflows/desktop.yml).
//
// Prerequisites (checked, never silently skipped):
//   pnpm install                                            workspace with esbuild/electron and this platform's
//                                                           optional native packages (@napi-rs/keyring-*, @img/sharp-*) installed
//   pnpm --filter @simforge-oss/native-runtime build:node   addon for this target
//   pnpm --filter @simforge-oss/render build                browser render harness (dist/harness.html)
//   node scripts/native-runtime/package-runtime.mjs --target <triple>  runtime archive for this target (baseline: no --providers)
//   node desktop/fetch-tools.mjs                            (run here when missing) pinned ffmpeg/ffprobe
//   node packages/render/scripts/fetch-actor-closure.mjs    (run here) pinned actor closure
//   packages/*/dist for packages Next resolves through `exports` (pnpm -r build)

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { extractRuntimeArchive, verifyRuntimeStage } from "../../scripts/native-runtime/runtime-archive.mjs";
import { targetLayout } from "../../scripts/native-runtime/target-layout.mjs";
import { fetchTools, matchesPin } from "./fetch-tools.mjs";
import { bundleNode, stageApp } from "./stage-app.mjs";
import { resolvePackageDir, STAGE_MANIFEST_FILE, STAGE_MANIFEST_SCHEMA, targetFor, verifyNativeClosure } from "./stage-manifest.mjs";

const require = createRequire(import.meta.url);
const desktopDir = dirname(fileURLToPath(import.meta.url));
const studioRoot = resolve(desktopDir, "..");
const repoRoot = resolve(studioRoot, "..");
const distRoot = join(studioRoot, "dist");
const appDir = join(distRoot, "desktop", "app");
const stageRoot = join(distRoot, "desktop", "resources");
const stageStudio = join(stageRoot, "studio");

/**
 * Packages the bundles leave external because they load files or binaries
 * relative to their own package directory. Each must be a direct dependency
 * of `@simforge-oss/studio` so it resolves from `studio/host/` at runtime;
 * the stage copies the package and its pnpm dependency closure.
 */
const RUNTIME_ASSET_PACKAGES = ["@electric-sql/pglite", "@napi-rs/keyring", "@simforge-oss/native-runtime", "@simforge-oss/render", "sharp", "playwright-core"];
/** Externals that are never loaded from the artifact: optional or workspace-plan-only. */
const NEVER_BUNDLED = ["pg-native", "next", "tsx"];

const NATIVE_ADDON_DIR = join(repoRoot, "packages", "native-runtime", "native");
const RENDER_DIST = join(repoRoot, "packages", "render", "dist");

/**
 * pnpm links packages with symlinks on POSIX and with junctions (absolute
 * targets) on Windows. The stage keeps POSIX links verbatim, sealed by
 * `verifySealed`. A Windows install cannot carry links (NSIS extracts plain
 * files, junctions are absolute), so the Windows stage holds plain copies
 * laid out npm-style by `drainPlacements`, where Node resolution needs no
 * link at all.
 */
const PRESERVE_LINKS = process.platform !== "win32";
const marker = `${sep}node_modules${sep}`;
const store = join(repoRoot, "node_modules", ".pnpm") + sep;

const target = targetFor();
const skipNextBuild = process.argv.includes("--skip-next-build");

/** @param {string} message */
function fail(message) {
  process.stderr.write(`desktop stage: ${message}\n`);
  process.exit(1);
}

/** @param {string} path */
async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} path */
async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {Record<string, string>} env
 */
async function run(command, args, env = {}) {
  const child = spawn(command, args, { cwd: studioRoot, stdio: "inherit", env: { ...process.env, ...env } });
  const code = await new Promise((resolveExit) => child.once("exit", (exitCode) => resolveExit(exitCode ?? 1)));
  if (code !== 0) fail(`${[command, ...args].join(" ")} exited with ${code}`);
}

async function nativeAddon() {
  const prefix = `simforge-native-runtime.${process.platform}-${process.arch}`;
  const names = (await readdir(NATIVE_ADDON_DIR).catch(() => [])).filter((name) => name.startsWith(prefix) && name.endsWith(".node"));
  if (names.length === 0) {
    fail(`no ${prefix}*.node in ${NATIVE_ADDON_DIR}; build it with \`pnpm --filter @simforge-oss/native-runtime build:node\``);
  }
  if (names.length > 1) {
    fail(`several addons match ${prefix} in ${NATIVE_ADDON_DIR} (${names.join(", ")}); keep the one for this libc`);
  }
  return names[0];
}

/**
 * The verified native runtime distribution for this target: runner, Bevy
 * render service, FFI library, sky plates. Extracted flat into `runtime/`,
 * every manifest component re-verified by digest. Baseline archives carry no
 * Python providers and none is installed here; the CPU/Bevy path needs none.
 * @returns {Promise<{ root: string; archive: string; sha256: string; manifest: Record<string, any>; runner: string; renderService: string; renderLibrary: string }>}
 */
async function stageNativeRuntime() {
  const layout = targetLayout(target.triple);
  const archiveDir = join(repoRoot, "dist", "native-runtime");
  let archive = process.env.SIMFORGE_NATIVE_RUNTIME_ARCHIVE;
  if (!archive) {
    const names = (await readdir(archiveDir).catch(() => []))
      .filter((name) => name.startsWith("simforge-native-runtime-") && name.endsWith(`-${target.triple}.tar.gz`));
    if (names.length !== 1) {
      fail(`expected one ${archiveDir}/simforge-native-runtime-*-${target.triple}.tar.gz (found ${names.length}); build it with node scripts/native-runtime/package-runtime.mjs --target ${target.triple}, or set SIMFORGE_NATIVE_RUNTIME_ARCHIVE`);
    }
    archive = join(archiveDir, names[0]);
  }
  archive = resolve(archive);
  const expected = (await readFile(`${archive}.sha256`, "utf8").catch(() => "")).trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(expected) || (await sha256(archive)) !== expected) {
    fail(`native runtime archive digest mismatch: ${archive}`);
  }
  const root = join(stageRoot, "runtime");
  await mkdir(root, { recursive: true });
  await extractRuntimeArchive(archive, root);
  await verifyRuntimeStage(root);
  const manifest = JSON.parse(await readFile(join(root, "bin", "runtime-manifest.json"), "utf8"));
  if (manifest.schema !== "simforge.native-runtime/v1" || manifest.target !== target.triple) {
    fail(`native runtime archive is not the ${target.triple} distribution: ${archive} (${manifest.target})`);
  }
  const runner = join("bin", manifest.binary.name);
  if (manifest.binary.name !== layout.runnerName) fail(`runtime manifest names the runner ${manifest.binary.name}, expected ${layout.runnerName}`);
  const renderService = join("bin", layout.renderServiceName);
  const renderLibrary = join("lib", layout.renderLibName);
  if (renderLibrary.replace(/\\/g, "/") !== target.renderLibrary) {
    fail(`renderer library name disagreement: scripts/native-runtime says ${renderLibrary}, desktop/stage-manifest.mjs says ${target.renderLibrary}`);
  }
  /** @type {Array<{ kind: string; install: string; sha256: string; sizeBytes: number }>} */
  const components = Array.isArray(manifest.components) ? manifest.components : [];
  for (const entry of [runner, renderService, renderLibrary, join("share", "sky", "SOURCES.json")]) {
    const listed = entry === runner || components.some((component) => component.install === entry.replace(/\\/g, "/"));
    if (!listed) fail(`runtime manifest lists no component ${entry}; baseline local Bevy needs it`);
    const info = await stat(join(root, entry)).catch(() => null);
    if (!info?.isFile()) fail(`native runtime archive lacks ${entry}`);
  }
  for (const component of components) {
    const path = join(root, component.install);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size !== component.sizeBytes || (await sha256(path)) !== component.sha256) {
      fail(`runtime component ${component.install} does not match its manifest digest`);
    }
  }
  return {
    root: "runtime",
    archive,
    sha256: expected,
    manifest,
    runner: join("runtime", runner),
    renderService: join("runtime", renderService),
    renderLibrary: join("runtime", renderLibrary),
  };
}

/**
 * The pinned encoders, fetched if the digests are not already on disk and
 * re-verified as they are copied into the stage.
 */
async function stageTools() {
  const layout = await fetchTools(distRoot, target);
  const toolsDir = join(stageStudio, "tools");
  await mkdir(toolsDir, { recursive: true });
  const staged = {};
  for (const name of ["ffmpeg", "ffprobe"]) {
    const source = layout[name];
    const file = `${name}${target.exe}`;
    await cp(source, join(toolsDir, file));
    if (!(await matchesPin(join(toolsDir, file), layout.pins[name]))) fail(`staged ${file} does not match desktop/tools.lock.json`);
    staged[name] = join("studio", "tools", file);
  }
  await cp(layout.license, join(toolsDir, "LICENSE"));
  return { ...staged, version: layout.version, license: layout.licenseId };
}

/** The pinned actor-appearance closure native renders resolve offline. */
async function stageActorAssets() {
  const out = join(stageStudio, "actor-assets");
  await run(process.execPath, [join(repoRoot, "packages", "render", "scripts", "fetch-actor-closure.mjs"), "--out", out]);
  const closures = await readdir(join(out, "closures")).catch(() => []);
  if (closures.length === 0) fail(`${out}/closures is empty; the actor closure fetch produced nothing`);
  return join("studio", "actor-assets");
}

/**
 * Copy `source` (a path under the repository) to the same relative path in
 * the stage, preserving symlinks verbatim (POSIX layout only).
 * @param {string} source
 */
async function stageMirror(source) {
  const rel = relative(repoRoot, source);
  if (rel.startsWith("..") || isAbsolute(rel)) fail(`${source} is outside the repository`);
  const target = join(stageRoot, rel);
  await mkdir(dirname(target), { recursive: true });
  if ((await lstat(source)).isSymbolicLink()) {
    const link = await readlink(source);
    const existing = await lstat(target).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing) {
      if (!existing.isSymbolicLink() || resolve(dirname(target), await readlink(target)) !== resolve(dirname(target), link)) {
        fail(`${target} conflicts with the installed dependency link`);
      }
    } else {
      await symlink(link, target);
    }
    return target;
  }
  await cp(source, target, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: false });
  return target;
}

/**
 * Stage a workspace package as `pnpm pack` publishes it, at its repository
 * path: workspace `src/` and development dependencies never become an
 * accidental desktop runtime, and the packed tree carries the same files and
 * export conditions a published consumer receives.
 * @param {string} packageDir real path of the workspace package
 * @returns {Promise<{ metadata: Record<string, any>; target: string }>}
 */
async function packWorkspacePackage(packageDir) {
  const packageRelative = relative(repoRoot, packageDir);
  if (packageRelative.startsWith("..") || isAbsolute(packageRelative)) fail(`${packageDir} is outside the repository`);
  const metadata = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  const packed = await mkdtemp(join(tmpdir(), "simforge-desktop-package-"));
  const target = join(stageRoot, packageRelative);
  try {
    await promisify(execFile)("pnpm", ["pack", "--pack-destination", packed], {
      cwd: packageDir,
      env: { ...process.env, npm_config_ignore_scripts: "true", pnpm_config_ignore_scripts: "true" },
      maxBuffer: 4 * 1024 * 1024,
      shell: process.platform === "win32",
    });
    const tarballs = (await readdir(packed)).filter((file) => file.endsWith(".tgz"));
    if (tarballs.length !== 1) fail(`${metadata.name} did not produce exactly one package archive`);
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await run("tar", ["-xzf", join(packed, tarballs[0]), "--strip-components=1", "-C", target]);
  } finally {
    await rm(packed, { recursive: true, force: true });
  }
  return { metadata, target };
}

/**
 * Runtime dependency links of a workspace package; an uninstalled required
 * dependency is an incomplete workspace, not a runtime surprise.
 * @param {string} packageDir
 * @param {Record<string, any>} metadata
 * @returns {Promise<Array<[name: string, link: string]>>}
 */
async function workspaceDependencyLinks(packageDir, metadata) {
  const names = Object.keys({ ...metadata.dependencies, ...metadata.peerDependencies, ...metadata.optionalDependencies }).sort();
  /** @type {Array<[string, string]>} */
  const links = [];
  for (const name of names) {
    const linkPath = join(packageDir, "node_modules", name);
    if (!(await exists(linkPath))) {
      if (metadata.optionalDependencies?.[name] || metadata.peerDependenciesMeta?.[name]?.optional) continue;
      fail(`${metadata.name} has an uninstalled runtime dependency ${name}`);
    }
    links.push([name, linkPath]);
  }
  return links;
}

/**
 * Dependency links pnpm placed beside a virtual-store package
 * (`.pnpm/<id>/node_modules/<dependency>`).
 * @param {string} packageDir real path under a `.pnpm` store
 * @returns {Promise<Array<[name: string, link: string]>>}
 */
async function storeDependencyLinks(packageDir) {
  const linkRoot = packageDir.slice(0, packageDir.lastIndexOf(marker) + marker.length - 1);
  /** @type {Array<[string, string]>} */
  const links = [];
  for (const entry of await readdir(linkRoot, { withFileTypes: true })) {
    const names = entry.name.startsWith("@")
      ? (await readdir(join(linkRoot, entry.name))).map((name) => join(entry.name, name))
      : [entry.name];
    for (const name of names) {
      const linkPath = join(linkRoot, name);
      if ((await lstat(linkPath)).isSymbolicLink()) links.push([name.split(sep).join("/"), linkPath]);
    }
  }
  return links;
}

/**
 * POSIX: stage published workspace packages and installed virtual-store
 * packages with their runtime dependency links, mirroring the workspace layout.
 * @param {string} packageDir real path of the package
 * @param {Set<string>} seen
 */
async function stagePackageClosure(packageDir, seen) {
  if (seen.has(packageDir)) return;
  seen.add(packageDir);
  /** @type {Array<[string, string]>} */
  let links;
  if (packageDir.startsWith(store)) {
    await stageMirror(packageDir);
    links = await storeDependencyLinks(packageDir);
  } else {
    const { metadata } = await packWorkspacePackage(packageDir);
    links = await workspaceDependencyLinks(packageDir, metadata);
  }
  for (const [, linkPath] of links) {
    await stageMirror(linkPath);
    await stagePackageClosure(await realpath(linkPath), seen);
  }
}

/**
 * Windows: plain copies placed npm-style. A package is hoisted to the
 * outermost `node_modules` its dependent resolves through where its name is
 * free, nested closer when another version already holds the name, and never
 * placed where it would shadow a name a dependent below already resolved
 * through that directory. Placement is breadth-first, so a package's own
 * dependencies take their names before anything nested deeper competes for
 * them. A package is identified by its repository-relative real path, the
 * same whether it comes from the Next standalone trace (traced files only) or
 * from the workspace store (complete), so both merge into one copy.
 */
const placements = {
  /** @type {Array<{ source: string; name: string; scopes: string[] }>} */
  queue: [],
  /** @type {Map<string, { key: string; sources: Set<string> }>} */
  placed: new Map(),
  /** @type {Map<string, Set<string>>} */
  reserved: new Map(),
};

/**
 * @param {string} source real package directory in the workspace or the standalone output
 * @param {string} name package name
 * @param {string[]} scopes `node_modules` directories the dependent resolves through, nearest first
 */
function enqueuePlacement(source, name, scopes) {
  placements.queue.push({ source, name, scopes });
}

/** @param {string} path */
async function notLink(path) {
  return !(await lstat(path)).isSymbolicLink();
}

async function drainPlacements() {
  const { queue, placed, reserved } = placements;
  while (queue.length > 0) {
    const { source, name, scopes } = /** @type {{ source: string; name: string; scopes: string[] }} */ (queue.shift());
    const key = relative(source.startsWith(standalone + sep) ? standalone : repoRoot, source);
    if (key.startsWith("..") || isAbsolute(key)) fail(`${source} is outside the repository`);
    let found = -1;
    let free = -1;
    for (let i = 0; i < scopes.length; i += 1) {
      const existing = placed.get(join(scopes[i], name));
      if (existing?.key === key) {
        found = i;
        break;
      }
      if (existing || reserved.get(scopes[i])?.has(name)) break;
      free = i;
    }
    const index = found >= 0 ? found : free;
    if (index < 0) fail(`${name} (${key}) cannot be placed for ${relative(stageRoot, scopes[0])}: another version holds every resolvable location`);
    const location = join(scopes[index], name);
    for (const scope of scopes.slice(0, index)) {
      const names = reserved.get(scope) ?? new Set();
      names.add(name);
      reserved.set(scope, names);
    }
    const entry = placed.get(location) ?? { key, sources: new Set() };
    placed.set(location, entry);
    if (entry.sources.has(source)) continue;
    entry.sources.add(source);
    let copySource = source;
    /** @type {Array<[string, string]>} */
    let links;
    if (key.startsWith(join("node_modules", ".pnpm") + sep)) {
      links = await storeDependencyLinks(source);
    } else {
      const { metadata, target } = await packWorkspacePackage(source);
      copySource = target;
      links = await workspaceDependencyLinks(source, metadata);
    }
    await mkdir(dirname(location), { recursive: true });
    await cp(copySource, location, { recursive: true, force: false, errorOnExist: false, filter: notLink });
    const inner = [join(location, "node_modules"), ...scopes.slice(index)];
    for (const [dependency, linkPath] of links) enqueuePlacement(await realpath(linkPath), dependency, inner);
  }
}

/**
 * Stage a direct dependency of `@simforge-oss/studio` the bundles load from
 * disk, with its runtime closure, resolvable from `studio/`.
 * @param {string} name
 * @param {Set<string>} seen
 */
async function stageDependency(name, seen) {
  const installed = join(studioRoot, "node_modules", name);
  if (!(await exists(installed))) fail(`${name} is not installed under studio/node_modules; add it to studio/package.json dependencies and run pnpm install`);
  const real = await realpath(installed);
  if (!PRESERVE_LINKS) {
    enqueuePlacement(real, name, [join(stageStudio, "node_modules")]);
    return;
  }
  await stagePackageClosure(real, seen);
  await ensureStudioLink(name);
}

/**
 * Recreate `studio/node_modules/<name>` in the stage: the workspace's own
 * link text on POSIX (relative, so it resolves inside the stage); on Windows
 * a plain copy of what the stage already holds at the link's target.
 * @param {string} name
 */
async function ensureStudioLink(name) {
  const source = join(studioRoot, "node_modules", name);
  const target = join(stageStudio, "node_modules", name);
  if (await exists(target)) return;
  if (PRESERVE_LINKS) {
    await stageMirror(source);
    return;
  }
  const staged = join(stageRoot, relative(repoRoot, await realpath(source)));
  if (!(await exists(staged))) fail(`${name} is not staged at ${relative(stageRoot, staged)}; nothing to place under studio/node_modules`);
  await mkdir(dirname(target), { recursive: true });
  await cp(staged, target, { recursive: true, filter: notLink });
}

/**
 * The per-target binding packages the disk-loaded dependencies resolve in
 * the stage, as the manifest records them. Resolution happens exactly as at
 * runtime, from the standalone server; a binding that does not resolve is a
 * pnpm install that lacked this platform's optional package or a trace that
 * dropped it, never a session-only vault or a sharp that loads nothing.
 * @param {string} server stage-relative server entry
 * @returns {Promise<Record<string, Record<string, string>>>}
 */
async function stagedNativeBindings(server) {
  const root = await realpath(stageRoot);
  /** @type {Record<string, Record<string, string>>} */
  const bindings = {};
  for (const [owner, packages] of Object.entries(target.bindings)) {
    const ownerDir = await resolvePackageDir(join(root, server), owner);
    if (!ownerDir) fail(`${owner} does not resolve from ${server} in the stage`);
    bindings[owner] = {};
    for (const name of packages) {
      const dir = await resolvePackageDir(join(ownerDir, "package.json"), name);
      if (!dir) fail(`${owner} cannot resolve its ${target.key} binding ${name} in the stage; pnpm install on this platform must provide it (optionalDependencies) and the closure must keep it`);
      if (!dir.startsWith(root + sep)) fail(`${name} resolves outside the stage: ${dir}`);
      bindings[owner][name] = relative(root, dir).split(sep).join("/");
    }
  }
  return bindings;
}

/**
 * Every symlink in the stage must point inside it: no checkout, no global
 * store. Link text is checked lexically, so a chain cannot escape through an
 * intermediate link either. A dangling dependency is an incomplete artifact,
 * so it fails the stage instead of being deferred to runtime.
 */
async function verifySealed() {
  /** @type {string[]} */
  const queue = [stageRoot];
  let symlinks = 0;
  /** @type {string[]} */
  const dangling = [];
  while (queue.length > 0) {
    const dir = queue.pop();
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks += 1;
        const link = await readlink(path);
        if (isAbsolute(link) || !resolve(dir, link).startsWith(stageRoot + sep)) {
          fail(`${relative(stageRoot, path)} -> ${link} escapes the stage`);
        }
        if (!(await realpath(path).catch(() => null))) dangling.push(`${relative(stageRoot, path)} -> ${link}`);
      } else if (entry.isDirectory()) {
        queue.push(path);
      }
    }
  }
  if (dangling.length > 0) fail(`unresolved dependency links: ${dangling.join("; ")}`);
  if (!PRESERVE_LINKS && symlinks > 0) fail(`${symlinks} symlinks remain in a link-free (Windows) stage`);
  return symlinks;
}

const studioPackage = JSON.parse(await readFile(join(studioRoot, "package.json"), "utf8"));
const electronVersion = require("electron/package.json").version;
const addonName = await nativeAddon();
for (const [label, path, hint] of [
  ["browser render harness", join(RENDER_DIST, "harness.html"), "pnpm --filter @simforge-oss/render build"],
  ["browser render harness bundle", join(RENDER_DIST, "web", "headless.js"), "pnpm --filter @simforge-oss/render build"],
]) {
  if (!(await exists(path))) fail(`${label} missing at ${path}; run \`${hint}\``);
}

await rm(appDir, { recursive: true, force: true });
await rm(stageRoot, { recursive: true, force: true });

// 1. Next standalone build: the server plus the traced dependency closure.
const nextBin = require.resolve("next/dist/bin/next");
if (!skipNextBuild) {
  await run(process.execPath, [join(studioRoot, "scripts", "sync-studio-assets.mjs")]);
  await run(process.execPath, [nextBin, "build", "--webpack"], { SIMFORGE_DESKTOP_BUILD: "1" });
}
const standalone = join(studioRoot, ".next", "standalone");
if (!(await exists(join(standalone, "studio", "server.js")))) {
  fail(`${standalone}/studio/server.js missing; build with SIMFORGE_DESKTOP_BUILD=1 (drop --skip-next-build)`);
}
await mkdir(stageRoot, { recursive: true });
if (PRESERVE_LINKS) {
  await cp(standalone, stageRoot, { recursive: true, verbatimSymlinks: true });
} else {
  // Files only: the traced virtual store and the links into it become
  // npm-style plain copies placed from the standalone's own top-level links.
  const standaloneStore = join(standalone, "node_modules", ".pnpm");
  await cp(standalone, stageRoot, { recursive: true, filter: async (path) => path !== standaloneStore && (await notLink(path)) });
  const roots = join(standalone, "studio", "node_modules");
  for (const entry of await readdir(roots, { withFileTypes: true })) {
    const names = entry.name.startsWith("@") ? (await readdir(join(roots, entry.name))).map((name) => `${entry.name}/${name}`) : [entry.name];
    for (const name of names) {
      const linkPath = join(roots, name);
      if ((await lstat(linkPath)).isSymbolicLink()) enqueuePlacement(await realpath(linkPath), name, [join(stageStudio, "node_modules")]);
    }
  }
}
await cp(join(studioRoot, ".next", "static"), join(stageStudio, ".next", "static"), { recursive: true });
await cp(join(studioRoot, "public"), join(stageStudio, "public"), {
  recursive: true,
  // Locally installed map bundles are workspace data, not part of the application.
  filter: (source) => relative(join(studioRoot, "public"), source).split(sep)[0] !== "map-bundles",
});
await cp(join(studioRoot, "migrations"), join(stageStudio, "migrations"), { recursive: true });

// 2. The supervisor and the CPU worker as self-contained ESM bundles.
const hostDir = join(stageStudio, "host");
const bundled = await bundleNode(
  { "host-main": join(desktopDir, "host.ts"), worker: join(studioRoot, "worker", "index.ts") },
  hostDir,
  [...RUNTIME_ASSET_PACKAGES, ...NEVER_BUNDLED],
);
// The worker runs as argv[1] itself, so a self-running script bundled into it
// would execute on load; only the supervisor may carry migrate/seed.
for (const [file, inputs] of Object.entries(bundled)) {
  if (!file.endsWith("worker.mjs")) continue;
  const selfRunning = inputs.filter((input) => /(^|\/)scripts\/(migrate|seed)\.ts$/.test(input));
  if (selfRunning.length > 0) fail(`worker bundle would execute ${selfRunning.join(", ")} on load`);
}
// Launcher: keeps argv[1] distinct from every bundled module (see desktop/host.ts).
await writeFile(join(hostDir, "host.mjs"), "import \"./host-main.mjs\";\n");

// 3. Packages the bundles load from disk, with their pnpm closure and studio-level links.
const seen = new Set();
for (const name of RUNTIME_ASSET_PACKAGES) await stageDependency(name, seen);
await drainPlacements();

// 4. Workspace assets the bundles read by path, resolved through the packed
//    packages exactly as at runtime; then the native payload for this target.
await ensureStudioLink("@simforge-oss/openscenario");
const nativeAddonRel = join("packages", "native-runtime", "native", addonName);
for (const [label, rel] of [
  ["native addon", nativeAddonRel],
  ["OpenSCENARIO schema", join("packages", "openscenario", "schema", "OpenSCENARIO.xsd")],
]) {
  if (!(await exists(join(stageRoot, rel)))) fail(`${label} missing from the published package: ${rel}`);
}
const nativeRuntime = await stageNativeRuntime();
const tools = await stageTools();
const actorAssetsRoot = await stageActorAssets();

// 5. Seal and describe: no link leaves the stage, and every native binding,
//    executable and library in it was built for this target.
if (await exists(join(stageStudio, ".next", "cache"))) fail("standalone output carried .next/cache");
const symlinks = await verifySealed();
const nativeBindings = await stagedNativeBindings("studio/server.js");
const gitRevision = await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" })
  .then(({ stdout }) => stdout.trim())
  .catch(() => null);
const posix = (/** @type {string} */ path) => path.split(sep).join("/");
const manifest = {
  schema: STAGE_MANIFEST_SCHEMA,
  platform: process.platform,
  arch: process.arch,
  target: target.triple,
  electron: electronVersion,
  studioVersion: studioPackage.version,
  gitRevision,
  nativeAddon: posix(nativeAddonRel),
  nativeRuntimeRoot: nativeRuntime.root,
  nativeRuntime: {
    version: nativeRuntime.manifest.version,
    revision: nativeRuntime.manifest.revision,
    archiveSha256: nativeRuntime.sha256,
    supportTiers: (nativeRuntime.manifest.supportTiers ?? []).map((tier) => tier.tier),
  },
  nativeRunner: posix(nativeRuntime.runner),
  nativeRenderService: posix(nativeRuntime.renderService),
  nativeRenderLibrary: posix(nativeRuntime.renderLibrary),
  tools: { ffmpeg: posix(tools.ffmpeg), ffprobe: posix(tools.ffprobe), version: tools.version, license: tools.license },
  nativeBindings,
  actorAssetsRoot: posix(actorAssetsRoot),
  browserHarness: "packages/render/dist/harness.html",
  server: "studio/server.js",
  hostEntry: "studio/host/host.mjs",
  workerEntry: "studio/host/worker.mjs",
};
await writeFile(join(stageRoot, STAGE_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
const closure = await verifyNativeClosure(stageRoot, manifest);
if (closure.length > 0) fail(`native closure is not ${target.key}:\n${closure.map((problem) => `- ${problem}`).join("\n")}`);

// 6. The Electron application directory (two-package layout: no runtime dependencies here).
const application = await stageApp({ appDir, version: studioPackage.version, license: studioPackage.license });

process.stdout.write(`${JSON.stringify({
  component: "simforge-desktop-stage",
  event: "stage.complete",
  app: appDir,
  appFiles: application.files,
  resources: stageRoot,
  symlinks,
  nativeRuntimeArchive: nativeRuntime.archive,
  ...manifest,
})}\n`);
