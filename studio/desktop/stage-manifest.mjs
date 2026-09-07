// The record `desktop/stage.mjs` writes at the root of the staged resources
// and the only description of the artifact the desktop shell and the packaged
// host trust: which target the native payload was staged for and where every
// entry point and bundled dependency lives relative to the stage root. Plain
// JS so the unbundled shell (`electron desktop/main.mjs`), the bundled host
// and the package verifier share it.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const STAGE_MANIFEST_SCHEMA = "simforge.desktop-stage/v2";
export const STAGE_MANIFEST_FILE = "stage-manifest.json";

/** One application identity across every platform, profile and cache. */
export const PRODUCT = Object.freeze({
  name: "SimForge Studio",
  appId: "ai.simforge.studio",
  packageName: "simforge-studio",
  executableName: "simforge-studio",
  /** Per-user data directory name (OS conventions decide the parent). */
  dataDir: "SimForge Studio",
  landing: "/dashboard/scenario",
});

/**
 * Electron platform/arch to the Rust target triple the native runtime archive
 * and renderer are built for. Only these targets can be staged; there is no
 * qualification by inference.
 */
export const TARGETS = Object.freeze({
  "linux-x64": Object.freeze({ triple: "x86_64-unknown-linux-gnu", exe: "", renderLibrary: "lib/libsimforge_render.so" }),
  "win32-x64": Object.freeze({ triple: "x86_64-pc-windows-msvc", exe: ".exe", renderLibrary: "lib/simforge_render.dll" }),
  "darwin-arm64": Object.freeze({ triple: "aarch64-apple-darwin", exe: "", renderLibrary: "lib/libsimforge_render.dylib" }),
  "darwin-x64": Object.freeze({ triple: "x86_64-apple-darwin", exe: "", renderLibrary: "lib/libsimforge_render.dylib" }),
});

/**
 * @param {NodeJS.Platform} platform
 * @param {string} arch
 * @returns {{ key: keyof typeof TARGETS; triple: string; exe: string; renderLibrary: string }}
 */
export function targetFor(platform = process.platform, arch = process.arch) {
  const key = /** @type {keyof typeof TARGETS} */ (`${platform}-${arch}`);
  const target = TARGETS[key];
  if (!target) {
    throw new Error(`${key} is not a SimForge Studio desktop target (supported: ${Object.keys(TARGETS).join(", ")})`);
  }
  return { key, ...target };
}

/**
 * @typedef {object} StageManifest
 * @property {typeof STAGE_MANIFEST_SCHEMA} schema
 * @property {NodeJS.Platform} platform Platform the native payload targets.
 * @property {string} arch Architecture the native payload targets.
 * @property {string} target Rust target triple of the native payload.
 * @property {string} electron Electron release the stage was produced against.
 * @property {string} studioVersion `@simforge-oss/studio` version (also the app version).
 * @property {string | null} gitRevision Source revision, when staged from a checkout.
 * @property {string} nativeAddon Stage-relative path of the N-API runtime addon.
 * @property {string} nativeRuntimeRoot Stage-relative root of the verified native runtime distribution.
 * @property {{ version: string; revision: string; archiveSha256: string; supportTiers: string[] }} nativeRuntime
 * @property {string} nativeRunner Stage-relative path of `simforge-runner[.exe]`.
 * @property {string} nativeRenderService Stage-relative path of `native-render-service[.exe]`.
 * @property {string} nativeRenderLibrary Stage-relative path of the renderer FFI library.
 * @property {{ ffmpeg: string; ffprobe: string; version: string; license: string }} tools Bundled encoder binaries.
 * @property {string} actorAssetsRoot Stage-relative root of the pinned actor-appearance closure.
 * @property {string} browserHarness Stage-relative path of the browser render harness.
 * @property {string} server Stage-relative path of the standalone Next server.
 * @property {string} hostEntry Stage-relative path of the local host launcher.
 * @property {string} workerEntry Stage-relative path of the bundled CPU worker.
 */

const STRING_FIELDS = /** @type {const} */ ([
  "platform", "arch", "target", "electron", "studioVersion", "nativeAddon", "nativeRuntimeRoot", "nativeRunner",
  "nativeRenderService", "nativeRenderLibrary", "actorAssetsRoot", "browserHarness", "server", "hostEntry", "workerEntry",
]);

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/**
 * Read and validate the manifest under `stageRoot`; a missing or foreign file
 * is an installation error, never a fall-through to workspace paths.
 * @param {string} stageRoot
 * @returns {Promise<StageManifest>}
 */
export async function readStageManifest(stageRoot) {
  const path = join(stageRoot, STAGE_MANIFEST_FILE);
  const incomplete = (/** @type {string} */ reason) => new Error(`${PRODUCT.name} resources are incomplete: ${path} ${reason}.`);
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw incomplete(`is unreadable (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!isRecord(parsed) || parsed.schema !== STAGE_MANIFEST_SCHEMA) throw incomplete(`is not a ${STAGE_MANIFEST_SCHEMA} document`);
  for (const field of STRING_FIELDS) {
    if (typeof parsed[field] !== "string") throw incomplete(`lacks "${field}"`);
  }
  if (parsed.gitRevision !== null && typeof parsed.gitRevision !== "string") throw incomplete('has a malformed "gitRevision"');
  const runtime = parsed.nativeRuntime;
  if (
    !isRecord(runtime) || typeof runtime.version !== "string" || typeof runtime.revision !== "string"
    || typeof runtime.archiveSha256 !== "string" || !Array.isArray(runtime.supportTiers)
  ) {
    throw incomplete('has a malformed "nativeRuntime"');
  }
  const tools = parsed.tools;
  if (!isRecord(tools) || typeof tools.ffmpeg !== "string" || typeof tools.ffprobe !== "string" || typeof tools.version !== "string" || typeof tools.license !== "string") {
    throw incomplete('has a malformed "tools"');
  }
  // Every field was checked above.
  return /** @type {StageManifest} */ (parsed);
}

/**
 * The staged native pieces only run where they were built for.
 * @param {StageManifest} manifest
 */
export function assertStagePlatform(manifest) {
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new Error(
      `This ${PRODUCT.name} build was staged for ${manifest.platform}-${manifest.arch} (${manifest.target}) and cannot run on ${process.platform}-${process.arch}; ` +
        "install the build for this platform.",
    );
  }
}
