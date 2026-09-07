#!/usr/bin/env node
// Checks every packaged SimForge Studio application under dist/desktop/out:
//
//   node desktop/verify-package.mjs
//
// For each app.asar electron-builder produced (linux-unpacked, win-unpacked,
// mac*/SimForge Studio.app), the archive must hold exactly the staged shell
// files (no collected workspace node_modules), and the resources beside it
// must be a complete stage for the package's own platform: a readable
// stage-manifest.json naming this platform, the native runner and Bevy render
// service, the FFI library, the pinned encoders with their locked digests, the
// actor closure and the standalone server. This is what an installer ships;
// nothing is inferred from a build succeeding.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_FILES } from "./stage-app.mjs";
import { readStageManifest, targetFor } from "./stage-manifest.mjs";

const require = createRequire(import.meta.url);
// @electron/asar is a dependency of electron-builder's app-builder-lib, not of studio.
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const asar = createRequire(builderRequire.resolve("app-builder-lib/package.json"))("@electron/asar");

const desktopDir = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(desktopDir, "..", "dist", "desktop", "out");
const lock = JSON.parse(await readFile(join(desktopDir, "tools.lock.json"), "utf8"));

/** Platform a packaged directory name stands for. */
const PLATFORM_BY_DIR = { "linux-unpacked": "linux", "win-unpacked": "win32", mac: "darwin", "mac-arm64": "darwin", "mac-x64": "darwin" };

const problems = [];
const entries = await readdir(outDir, { recursive: true }).catch(() => {
  problems.push(`${outDir} does not exist; run electron-builder with desktop/electron-builder.yml first`);
  return [];
});
const archives = entries.filter((entry) => entry.endsWith("app.asar") && !entry.includes(".asar.unpacked"));
if (archives.length === 0 && problems.length === 0) problems.push(`no app.asar under ${outDir}`);

/** @param {string} path */
async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

for (const rel of archives) {
  const archive = join(outDir, rel);
  const packageRoot = rel.split(sep)[0];
  const platform = PLATFORM_BY_DIR[packageRoot];
  if (!platform) {
    problems.push(`${rel}: unrecognised package directory ${packageRoot}`);
    continue;
  }
  const listed = asar.listPackage(archive, { isPack: false })
    .map((entry) => entry.replace(/^[\\/]/, ""))
    .filter((entry) => entry.length > 0)
    .sort();
  if (listed.join("\n") !== APP_FILES.join("\n")) {
    problems.push(`${rel}: app.asar holds [${listed.join(", ")}], expected [${APP_FILES.join(", ")}]`);
  }
  const main = asar.extractFile(archive, "main.mjs").toString("utf8");
  if (/SIMFORGE_DESKTOP_MODE|persist:simcloud/.test(main)) problems.push(`${rel}: main.mjs still carries a cloud mode`);

  const stage = join(dirname(archive), "studio");
  let manifest;
  try {
    manifest = await readStageManifest(stage);
  } catch (error) {
    problems.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  if (manifest.platform !== platform) problems.push(`${rel}: stage targets ${manifest.platform}-${manifest.arch}, package is ${platform}`);
  let target;
  try {
    target = targetFor(manifest.platform, manifest.arch);
  } catch (error) {
    problems.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  if (manifest.target !== target.triple) problems.push(`${rel}: stage triple ${manifest.target} is not ${target.triple}`);
  for (const file of [
    manifest.server, manifest.hostEntry, manifest.workerEntry, manifest.nativeAddon, manifest.nativeRuntimeRoot + "/bin/runtime-manifest.json",
    manifest.nativeRunner, manifest.nativeRenderService, manifest.nativeRenderLibrary, manifest.browserHarness,
  ]) {
    const info = await stat(join(stage, file)).catch(() => null);
    if (!info?.isFile()) problems.push(`${rel}: ${file} is missing from the package`);
    else if (platform !== "win32" && /\/bin\/[^/]+$/.test(file) && (info.mode & 0o111) === 0) problems.push(`${rel}: ${file} is not executable`);
  }
  const closures = await readdir(join(stage, manifest.actorAssetsRoot, "closures")).catch(() => []);
  if (closures.length === 0) problems.push(`${rel}: ${manifest.actorAssetsRoot} carries no actor closure`);
  const pins = lock.ffmpeg.targets[target.key];
  for (const name of ["ffmpeg", "ffprobe"]) {
    const path = join(stage, manifest.tools[name]);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) problems.push(`${rel}: ${manifest.tools[name]} is missing`);
    else if (info.size !== pins[name].sizeBytes || (await digest(path)) !== pins[name].sha256) problems.push(`${rel}: ${manifest.tools[name]} does not match desktop/tools.lock.json`);
  }
  const runtimeManifest = JSON.parse(await readFile(join(stage, manifest.nativeRuntimeRoot, "bin", "runtime-manifest.json"), "utf8").catch(() => "null"));
  if (!runtimeManifest || runtimeManifest.target !== target.triple) problems.push(`${rel}: runtime manifest is missing or targets ${runtimeManifest?.target}`);
  if (runtimeManifest && !(runtimeManifest.supportTiers ?? []).some((tier) => tier.tier === "bevy-sensor-render")) {
    problems.push(`${rel}: native runtime carries no bevy-sensor-render tier; local Bevy rendering would be unavailable`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`${problems.map((problem) => `- ${problem}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ component: "simforge-desktop-stage", event: "verify-package.ok", archives })}\n`);
