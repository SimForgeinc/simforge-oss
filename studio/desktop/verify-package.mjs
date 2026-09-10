#!/usr/bin/env node
// Checks every packaged SimForge Studio application under dist/desktop/out:
//
//   node desktop/verify-package.mjs [output-directory] [--target=<platform>-<arch>]
//
// Every package and installer in the directory must be for one target, the
// build host's unless --target names another: a matrix leg packages its own
// architecture and nothing else. For each app.asar electron-builder produced
// (linux-unpacked, win-unpacked, mac*/SimForge Studio.app), the archive must
// hold exactly the staged shell files (no collected workspace node_modules),
// and the resources beside it must be a complete stage for that target: a
// readable stage-manifest.json naming it, the native runner and Bevy render
// service, the FFI library, the pinned encoders, the actor closure, the
// standalone server, and the per-target native bindings (@napi-rs/keyring,
// sharp) resolving inside the package with every native binding, executable
// and library built for this target. This is what an installer ships; nothing
// is inferred from a build succeeding.
//
// Encoder integrity chain. desktop/encoders.lock.json is the root: it pins
// the ffmpeg and libx264 sources by Git commit and the configure lines that
// turn them into the two executables. desktop/build-encoders.mjs builds them
// and records their digests, their source commits and their
// corresponding-source archive in dist/desktop-tools/<target>/
// tools-manifest.json; readToolPins refuses a manifest whose source commits
// are not the ones the lock pins, so a build from other sources cannot be
// inherited. stage.mjs re-checks the digests when it copies them into the
// stage, and after-pack.mjs re-checks them in the package right before
// electron-builder signs. Signing then legitimately rewrites macOS
// executables in place (@electron/osx-sign signs every Mach-O in the bundle,
// ad-hoc or with a Developer ID, hardened runtime and entitlements), so the
// packaged bytes can no longer equal the built ones. Here the packaged tool
// must either still be those bytes, or be a Mach-O whose image with the code
// signature removed (stage-manifest.mjs unsignedMachO) equals the built
// one's. Nothing recorded in the stage or the package is trusted for this:
// rewriting a manifest cannot make other code pass, and a signed tool passes
// only if all it differs in is its signature. On macOS this verifier also
// invokes codesign on the manifest-resolved encoder paths.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readToolPins, toolsLayout } from "./build-encoders.mjs";
import { APP_FILES } from "./stage-app.mjs";
import { readStageManifest, targetFor, unsignedMachO, verifyNativeClosure } from "./stage-manifest.mjs";

const require = createRequire(import.meta.url);
// @electron/asar is a dependency of electron-builder's app-builder-lib, not of studio.
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const asar = createRequire(builderRequire.resolve("app-builder-lib/package.json"))("@electron/asar");

const desktopDir = dirname(fileURLToPath(import.meta.url));
const distRoot = resolve(desktopDir, "..", "dist");
const args = process.argv.slice(2);
const requested = args.find((arg) => arg.startsWith("--target="))?.slice("--target=".length);
const [positional] = args.filter((arg) => !arg.startsWith("--"));
const outDir = positional ? resolve(positional) : join(distRoot, "desktop", "out");
const expected = requested
  ? targetFor(/** @type {NodeJS.Platform} */ (requested.split("-")[0]), requested.split("-")[1])
  : targetFor();
const expectedPlatform = /** @type {NodeJS.Platform} */ (expected.key.split("-")[0]);
const expectedArch = expected.key.split("-")[1];

/** Platform and architecture a packaged directory name stands for. */
const TARGET_BY_DIR = {
  "linux-unpacked": ["linux", "x64"], "linux-arm64-unpacked": ["linux", "arm64"],
  "win-unpacked": ["win32", "x64"], "win-arm64-unpacked": ["win32", "arm64"],
  mac: ["darwin", "x64"], "mac-x64": ["darwin", "x64"], "mac-arm64": ["darwin", "arm64"], "mac-universal": ["darwin", "universal"],
};
/** Architecture tokens electron-builder puts in installer names (${arch}: x64, x86_64 for AppImage, amd64 for deb). */
const ARCH_TOKENS = { x64: ["x64", "x86_64", "amd64"], arm64: ["arm64"] };
const INSTALLER = /\.(dmg|zip|exe|AppImage|deb)$/;
const installerArch = new RegExp(`[-_](${ARCH_TOKENS[expectedArch].join("|")})[-_.]`);

const problems = [];
const entries = await readdir(outDir, { recursive: true }).catch(() => {
  problems.push(`${outDir} does not exist; run electron-builder with desktop/electron-builder.yml first`);
  return [];
});
const archives = entries.filter((entry) => entry.endsWith("app.asar") && !entry.includes(".asar.unpacked"));
if (archives.length === 0 && problems.length === 0) problems.push(`no app.asar under ${outDir}`);
for (const entry of entries) {
  if (entry.includes(sep) || !INSTALLER.test(entry)) continue;
  if (!installerArch.test(entry)) problems.push(`${entry}: installer is not for ${expected.key}; this leg must package --${expectedArch} only`);
}

/** @param {Buffer} bytes */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The encoders built for `expected` from the pinned sources, re-proven
 * against the digests their build recorded, plus their unsigned Mach-O
 * digests when the target is macOS (null otherwise). Read once; the
 * package's tools are compared against these, never against anything the
 * package carries.
 * @returns {Promise<Record<"ffmpeg" | "ffprobe", { sha256: string; sizeBytes: number; unsigned: string | null }>>}
 */
async function builtReference() {
  const pins = await readToolPins(distRoot, expected);
  const layout = toolsLayout(distRoot, expected);
  const reference = {};
  for (const name of /** @type {const} */ (["ffmpeg", "ffprobe"])) {
    const bytes = await readFile(layout[name]).catch(() => {
      throw new Error(`${layout[name]} is missing; run "node desktop/build-encoders.mjs --target ${expected.key}" before verifying`);
    });
    if (bytes.length !== pins[name].sizeBytes || sha256(bytes) !== pins[name].sha256) {
      throw new Error(`${layout[name]} does not match ${layout.manifest}; the reference for ${expected.key} is not the encoder that build produced`);
    }
    reference[name] = { ...pins[name], unsigned: expectedPlatform === "darwin" ? unsignedMachO(bytes).sha256 : null };
  }
  return reference;
}
const reference = archives.length > 0 ? await builtReference() : null;

/**
 * Why the packaged tool is not the built one, or null when it is: those
 * bytes themselves, or (macOS) a Mach-O differing from them only in its code
 * signature.
 * @param {string} path
 * @param {{ sha256: string; sizeBytes: number; unsigned: string | null }} pin
 */
async function toolMismatch(path, pin) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return "is missing";
  const bytes = await readFile(path);
  if (bytes.length === pin.sizeBytes && sha256(bytes) === pin.sha256) return null;
  if (pin.unsigned === null) return "is not the encoder built from the pinned sources";
  let image;
  try {
    image = unsignedMachO(bytes);
  } catch (error) {
    return `is not the encoder built from the pinned sources and ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!image.signed) return "differs from the built encoder without a code signature";
  if (image.sha256 !== pin.unsigned) return "is not the built encoder: its image differs beyond the code signature";
  return null;
}

for (const rel of archives) {
  const archive = join(outDir, rel);
  const packageRoot = rel.split(sep)[0];
  const packaged = TARGET_BY_DIR[packageRoot];
  if (!packaged) {
    problems.push(`${rel}: unrecognised package directory ${packageRoot}`);
    continue;
  }
  if (packaged[0] !== expectedPlatform || packaged[1] !== expectedArch) {
    problems.push(`${rel}: package is ${packaged.join("-")}, this leg must package ${expected.key} only`);
    continue;
  }
  const platform = packaged[0];
  const listed = asar.listPackage(archive, { isPack: false })
    .map((entry) => entry.replace(/^[\\/]/, ""))
    .filter((entry) => entry.length > 0)
    .sort();
  if (listed.join("\n") !== APP_FILES.join("\n")) {
    problems.push(`${rel}: app.asar holds [${listed.join(", ")}], expected [${APP_FILES.join(", ")}]`);
  }
  const metadata = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
  try {
    const origin = new URL(metadata.simforgeCloudOrigin);
    if (typeof metadata.simforgeCloudOrigin !== "string" || origin.protocol !== "https:" || origin.origin !== metadata.simforgeCloudOrigin) {
      throw new Error("invalid origin");
    }
  } catch {
    problems.push(`${rel}: package.json has no normalized HTTPS Cloud service origin`);
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
  if (manifest.platform !== platform || manifest.arch !== expectedArch) problems.push(`${rel}: stage targets ${manifest.platform}-${manifest.arch}, package is ${expected.key}`);
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
    else if (platform !== "win32" && (file === manifest.nativeRunner || file === manifest.nativeRenderService) && (info.mode & 0o111) === 0) problems.push(`${rel}: ${file} is not executable`);
  }
  const closures = await readdir(join(stage, manifest.actorAssetsRoot, "closures")).catch(() => []);
  if (closures.length === 0) problems.push(`${rel}: ${manifest.actorAssetsRoot} carries no actor closure`);
  // The model store installs this directory into each family's venv, so an
  // installer that ships the manifest entry without the project file would
  // fail only when a user first prepared a runtime.
  for (const required of ["pyproject.toml", join("src", "simforge_alpamayo", "__init__.py")]) {
    const file = join(manifest.modelAdapterRoot, required);
    if (!(await stat(join(stage, file)).then((info) => info.isFile(), () => false))) {
      problems.push(`${rel}: ${file} is missing from the package`);
    }
  }
  for (const name of /** @type {const} */ (["ffmpeg", "ffprobe"])) {
    const toolPath = join(stage, manifest.tools[name]);
    const mismatch = await toolMismatch(toolPath, reference[name]);
    if (mismatch) {
      problems.push(`${rel}: ${manifest.tools[name]} ${mismatch}`);
      continue;
    }
    if (platform === "darwin" && process.platform === "darwin") {
      try {
        execFileSync("codesign", ["--verify", "--strict", "--verbose=2", toolPath], { stdio: ["ignore", "ignore", "pipe"] });
      } catch (error) {
        problems.push(`${rel}: ${manifest.tools[name]} has an invalid code signature: ${String(error.stderr ?? error.message).trim()}`);
      }
    }
  }
  const runtimeManifest = JSON.parse(await readFile(join(stage, manifest.nativeRuntimeRoot, "bin", "runtime-manifest.json"), "utf8").catch(() => "null"));
  if (!runtimeManifest || runtimeManifest.target !== target.triple) problems.push(`${rel}: runtime manifest is missing or targets ${runtimeManifest?.target}`);
  if (runtimeManifest && !(runtimeManifest.supportTiers ?? []).some((tier) => tier.tier === "bevy-sensor-render")) {
    problems.push(`${rel}: native runtime carries no bevy-sensor-render tier; local Bevy rendering would be unavailable`);
  }
  if (platform === process.platform && expectedArch === process.arch) {
    try {
      const runtime = JSON.parse(execFileSync(join(stage, manifest.nativeRunner), ["runtime", "show"], {
        encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, SIMFORGE_RUNTIME_MANIFEST: join(stage, manifest.nativeRuntimeRoot, "bin", "runtime-manifest.json") },
      }));
      if (runtime.schema !== "simforge.native-runtime/v1" || runtime.target !== target.triple) throw new Error("Unexpected native runtime identity");
    } catch (error) {
      problems.push(`${rel}: packaged native runner failed runtime show: ${String(error.stderr ?? error.message).trim()}`);
    }
  }
  for (const problem of await verifyNativeClosure(stage, manifest)) problems.push(`${rel}: ${problem}`);
}

if (problems.length > 0) {
  process.stderr.write(`${problems.map((problem) => `- ${problem}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ component: "simforge-desktop-stage", event: "verify-package.ok", target: expected.key, archives })}\n`);
