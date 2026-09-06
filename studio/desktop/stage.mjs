#!/usr/bin/env node
// Stages the SimForge Studio desktop artifact.
//
//   node desktop/stage.mjs [--skip-next-build]
//
// Produces, under studio/dist/desktop:
//   app/        the Electron application: a dependency-free package.json, the
//               bundled shell (main.mjs) and its static pages; packed into the
//               asar by electron-builder.
//   resources/  the self-contained local host, shipped as extraResources
//               `studio/`. Its root mirrors the repository layout so the
//               bundled host finds staged assets where the workspace keeps
//               them:
//                 studio/server.js, studio/.next, studio/public   Next standalone output
//                 studio/host/{host,host-main,worker}.mjs         bundled supervisor and worker
//                 studio/migrations                               SQL migrations
//                 studio/node_modules, node_modules/.pnpm         traced runtime closure
//                 packages/…                                      assets read by path
//                 native/simforge-native-runtime.<platform>.node  N-API addon
//                 runtime/                                        verified native runtime archive
//                 stage-manifest.json                             desktop/stage-manifest.mjs
//
// Nothing in the stage points outside it: every symlink is verified to
// resolve inside the stage, so an artifact never depends on the checkout or
// on a global pnpm/tsx/Node. The interpreter at runtime is Electron in Node
// mode. Native pieces are staged for the build host only; the manifest
// records that platform and the shell refuses to run elsewhere.
//
// Prerequisites (checked, never silently skipped):
//   pnpm install                                   workspace with esbuild/electron installed
//   pnpm --filter @simforge-oss/native-runtime build:node   addon for this platform
//   pnpm --filter @simforge-oss/render build       browser render harness (dist/harness.html)
//   scripts/native-runtime/package-runtime.sh     runner, renderer, Python wheels and sky assets
//   packages/*/dist for packages Next resolves through `exports` (pnpm -r build)

import { build } from "esbuild";
import { execFile, spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { STAGE_MANIFEST_FILE, STAGE_MANIFEST_SCHEMA } from "./stage-manifest.mjs";

const require = createRequire(import.meta.url);
const desktopDir = dirname(fileURLToPath(import.meta.url));
const studioRoot = resolve(desktopDir, "..");
const repoRoot = resolve(studioRoot, "..");
const distRoot = join(studioRoot, "dist", "desktop");
const appDir = join(distRoot, "app");
const stageRoot = join(distRoot, "resources");
const stageStudio = join(stageRoot, "studio");

/**
 * Packages the bundles leave external because they load files or binaries
 * relative to their own package directory. Each must be a direct dependency
 * of `@simforge-oss/studio` so it resolves from `studio/host/` at runtime;
 * the stage copies the package and its pnpm dependency closure.
 */
const RUNTIME_ASSET_PACKAGES = ["@electric-sql/pglite", "@simforge-oss/native-runtime", "@simforge-oss/render", "sharp", "playwright-core"];
/** Externals that are never loaded from the artifact: optional or workspace-plan-only. */
const NEVER_BUNDLED = ["pg-native", "next", "tsx"];

const NATIVE_ADDON_DIR = join(repoRoot, "packages", "native-runtime", "native");
const RENDER_DIST = join(repoRoot, "packages", "render", "dist");

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
 * Reuse the verified headless distribution, not paths into Cargo build trees.
 * @returns {Promise<{ root: string; archive: string; sha256: string }>}
 */
async function stageNativeRuntime() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    fail("the native runtime distribution currently supports Linux x86_64 only");
  }
  const archiveDir = join(repoRoot, "dist", "native-runtime");
  let archive = process.env.SIMFORGE_NATIVE_RUNTIME_ARCHIVE;
  if (!archive) {
    const names = (await readdir(archiveDir).catch(() => []))
      .filter((name) => name.startsWith("simforge-native-runtime-") && name.endsWith(".tar.gz"));
    if (names.length !== 1) {
      fail("build one native runtime archive with scripts/native-runtime/package-runtime.sh, or set SIMFORGE_NATIVE_RUNTIME_ARCHIVE");
    }
    archive = join(archiveDir, names[0]);
  }
  archive = resolve(archive);
  const expected = (await readFile(`${archive}.sha256`, "utf8")).trim().split(/\s+/)[0];
  const { stdout } = await promisify(execFile)("sha256sum", [archive], { encoding: "utf8" });
  if (!/^[a-f0-9]{64}$/.test(expected) || stdout.split(/\s+/)[0] !== expected) {
    fail(`native runtime archive digest mismatch: ${archive}`);
  }
  const root = join(stageRoot, "runtime");
  await mkdir(root, { recursive: true });
  await run("tar", ["-xzf", archive, "-C", root]);
  await promisify(execFile)("sha256sum", ["--check", "--status", "SHA256SUMS"], { cwd: root });
  const manifest = JSON.parse(await readFile(join(root, "bin", "runtime-manifest.json"), "utf8"));
  if (manifest.schema !== "simforge.native-runtime/v1" || manifest.target !== "x86_64-unknown-linux-gnu") {
    fail(`native runtime archive is not the supported Linux x86_64 GNU distribution: ${archive}`);
  }
  for (const entry of ["bin/simforge-runner", "bin/native-render-service", "lib/libsimforge_render.so", "share/sky/SOURCES.json"]) {
    if (!(await exists(join(root, entry)))) fail(`native runtime archive lacks ${entry}`);
  }
  return { root: "runtime", archive, sha256: expected };
}

/**
 * Copy `source` (a path under the repository) to the same relative path in
 * the stage, preserving symlinks verbatim.
 * @param {string} source
 * @param {(source: string) => boolean} [filter]
 */
async function stageMirror(source, filter) {
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
  await cp(source, target, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: false, filter });
  return target;
}

/**
 * Stage published workspace packages and installed virtual-store packages with
 * their runtime dependency links. Workspace `src/` and development dependencies
 * never become an accidental desktop runtime: `pnpm pack` supplies the same
 * files and export conditions as a published consumer receives.
 * @param {string} packageDir real path of the package
 * @param {Set<string>} seen
 */
async function stagePackageClosure(packageDir, seen) {
  const packageRelative = relative(repoRoot, packageDir);
  if (packageRelative.startsWith("..") || isAbsolute(packageRelative)) fail(`${packageDir} is outside the repository`);
  if (seen.has(packageDir)) return;
  seen.add(packageDir);
  const marker = `${sep}node_modules${sep}`;
  const store = join(repoRoot, "node_modules", ".pnpm") + sep;
  if (!packageDir.startsWith(store)) {
    const metadata = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    const packed = await mkdtemp(join(tmpdir(), "simforge-desktop-package-"));
    const target = join(stageRoot, packageRelative);
    try {
      await promisify(execFile)("pnpm", ["pack", "--pack-destination", packed], {
        cwd: packageDir,
        env: { ...process.env, npm_config_ignore_scripts: "true", pnpm_config_ignore_scripts: "true" },
        maxBuffer: 4 * 1024 * 1024,
      });
      const tarballs = (await readdir(packed)).filter((file) => file.endsWith(".tgz"));
      if (tarballs.length !== 1) fail(`${metadata.name} did not produce exactly one package archive`);
      await rm(target, { recursive: true, force: true });
      await mkdir(target, { recursive: true });
      await run("tar", ["-xzf", join(packed, tarballs[0]), "--strip-components=1", "-C", target]);
    } finally {
      await rm(packed, { recursive: true, force: true });
    }
    const dependencies = Object.keys({
      ...metadata.dependencies,
      ...metadata.peerDependencies,
      ...metadata.optionalDependencies,
    }).sort();
    for (const name of dependencies) {
      const linkPath = join(packageDir, "node_modules", name);
      if (!(await exists(linkPath))) {
        if (metadata.optionalDependencies?.[name] || metadata.peerDependenciesMeta?.[name]?.optional) continue;
        fail(`${metadata.name} has an uninstalled runtime dependency ${name}`);
      }
      await stageMirror(linkPath);
      await stagePackageClosure(await realpath(linkPath), seen);
    }
    return;
  }
  await stageMirror(packageDir);
  const linkRoot = packageDir.slice(0, packageDir.lastIndexOf(marker) + marker.length - 1);
  for (const entry of await readdir(linkRoot, { withFileTypes: true })) {
    const names = entry.name.startsWith("@")
      ? (await readdir(join(linkRoot, entry.name))).map((name) => join(entry.name, name))
      : [entry.name];
    for (const name of names) {
      const linkPath = join(linkRoot, name);
      if (!(await lstat(linkPath)).isSymbolicLink()) continue;
      await stageMirror(linkPath);
      await stagePackageClosure(await realpath(linkPath), seen);
    }
  }
}

/**
 * Recreate `studio/node_modules/<name>` in the stage with the workspace's own
 * link text (relative, so it resolves inside the stage).
 * @param {string} name
 */
async function ensureStudioLink(name) {
  const source = join(studioRoot, "node_modules", name);
  const target = join(stageStudio, "node_modules", name);
  if (await exists(target)) return;
  await stageMirror(source);
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
  return symlinks;
}

/**
 * @param {Record<string, string>} entryPoints
 * @param {string} outdir
 * @param {string[]} external
 * @returns {Promise<Record<string, string[]>>} bundled source inputs per entry name
 */
async function bundle(entryPoints, outdir, external) {
  const result = await build({
    entryPoints,
    outdir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    tsconfig: join(studioRoot, "tsconfig.json"),
    external,
    sourcemap: false,
    metafile: true,
    assetNames: "assets/[name]-[hash]",
    loader: { ".wasm": "file", ".glb": "file", ".svg": "file", ".png": "file" },
    // Bundled CommonJS dependencies call `require`; ESM output has none by default.
    banner: { js: "import { createRequire as __stageCreateRequire } from 'node:module';\nconst require = __stageCreateRequire(import.meta.url);" },
    logLevel: "warning",
  });
  return Object.fromEntries(Object.entries(result.metafile.outputs)
    .filter(([, output]) => output.entryPoint)
    .map(([file, output]) => [file, Object.keys(output.inputs)]));
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
await cp(standalone, stageRoot, { recursive: true, verbatimSymlinks: true });
await cp(join(studioRoot, ".next", "static"), join(stageStudio, ".next", "static"), { recursive: true });
await cp(join(studioRoot, "public"), join(stageStudio, "public"), {
  recursive: true,
  // Locally installed map bundles are workspace data, not part of the application.
  filter: (source) => relative(join(studioRoot, "public"), source).split(sep)[0] !== "map-bundles",
});
await cp(join(studioRoot, "migrations"), join(stageStudio, "migrations"), { recursive: true });

// 2. The supervisor and the CPU worker as self-contained ESM bundles.
const hostDir = join(stageStudio, "host");
const bundled = await bundle(
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
for (const name of RUNTIME_ASSET_PACKAGES) {
  const installed = join(studioRoot, "node_modules", name);
  if (!(await exists(installed))) fail(`${name} is not installed under studio/node_modules; add it to studio/package.json dependencies and run pnpm install`);
  await stagePackageClosure(await realpath(installed), seen);
  await ensureStudioLink(name);
}

// 4. Workspace assets the bundles read by path, resolved through the packed
//    packages exactly as at runtime.
await ensureStudioLink("@simforge-oss/openscenario");
const nativeAddonRel = join("packages", "native-runtime", "native", addonName);
for (const [label, rel] of [
  ["native addon", nativeAddonRel],
  ["OpenSCENARIO schema", join("packages", "openscenario", "schema", "OpenSCENARIO.xsd")],
]) {
  if (!(await exists(join(stageRoot, rel)))) fail(`${label} missing from the published package: ${rel}`);
}
const nativeRuntime = await stageNativeRuntime();

// 5. Seal and describe.
if (await exists(join(stageStudio, ".next", "cache"))) fail("standalone output carried .next/cache");
const symlinks = await verifySealed();
const gitRevision = await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" })
  .then(({ stdout }) => stdout.trim())
  .catch(() => null);
const manifest = {
  schema: STAGE_MANIFEST_SCHEMA,
  platform: process.platform,
  arch: process.arch,
  electron: electronVersion,
  studioVersion: studioPackage.version,
  gitRevision,
  nativeAddon: nativeAddonRel,
  nativeRuntimeRoot: nativeRuntime.root,
  browserHarness: "packages/render/dist/harness.html",
  server: "studio/server.js",
  hostEntry: "studio/host/host.mjs",
  workerEntry: "studio/host/worker.mjs",
};
await writeFile(join(stageRoot, STAGE_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);

// 6. The Electron application directory (two-package layout: no runtime dependencies here).
await mkdir(appDir, { recursive: true });
await bundle({ main: join(desktopDir, "main.mjs") }, appDir, ["electron"]);
for (const page of ["starting.html", "host-exited.html"]) await cp(join(desktopDir, page), join(appDir, page));
await writeFile(join(appDir, "package.json"), `${JSON.stringify({
  name: "simforge-studio",
  productName: "SimForge Studio",
  version: studioPackage.version,
  description: "SimForge Studio desktop: the local Studio host and its shell.",
  license: studioPackage.license ?? "Apache-2.0",
  author: { name: "SimForge", email: "oss@simforge.ai" },
  private: true,
  type: "module",
  main: "main.mjs",
}, null, 2)}\n`);

process.stdout.write(`${JSON.stringify({
  component: "simforge-desktop-stage",
  event: "stage.complete",
  app: appDir,
  resources: stageRoot,
  symlinks,
  nativeRuntimeArchive: nativeRuntime.archive,
  nativeRuntimeSha256: nativeRuntime.sha256,
  ...manifest,
})}\n`);
