// The record `desktop/stage.mjs` writes at the root of the staged resources
// and the only description of the artifact the desktop shell and the packaged
// host trust: which platform the native pieces were staged for and where the
// entry points live relative to the stage root. Plain JS so the unbundled
// shell (`electron desktop/main.mjs`) and the bundled host share it.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const STAGE_MANIFEST_SCHEMA = "simforge.desktop-stage/v1";
export const STAGE_MANIFEST_FILE = "stage-manifest.json";

/**
 * @typedef {object} StageManifest
 * @property {typeof STAGE_MANIFEST_SCHEMA} schema
 * @property {NodeJS.Platform} platform Build host platform the native addon and prebuilt binaries target.
 * @property {string} arch Build host architecture.
 * @property {string} electron Electron release the stage was produced against.
 * @property {string} studioVersion `@simforge-oss/studio` version.
 * @property {string | null} gitRevision Source revision, when staged from a checkout.
 * @property {string} nativeAddon Stage-relative path of the N-API runtime addon.
 * @property {string} nativeRuntimeRoot Stage-relative root of the verified headless runtime distribution.
 * @property {string} browserHarness Stage-relative path of the browser render harness.
 * @property {string} server Stage-relative path of the standalone Next server.
 * @property {string} hostEntry Stage-relative path of the local host launcher.
 * @property {string} workerEntry Stage-relative path of the bundled CPU worker.
 */

const STRING_FIELDS = /** @type {const} */ ([
  "platform", "arch", "electron", "studioVersion", "nativeAddon", "nativeRuntimeRoot", "browserHarness", "server", "hostEntry", "workerEntry",
]);

/**
 * Read and validate the manifest under `stageRoot`; a missing or foreign file
 * is an installation error, never a fall-through to workspace paths.
 * @param {string} stageRoot
 * @returns {Promise<StageManifest>}
 */
export async function readStageManifest(stageRoot) {
  const path = join(stageRoot, STAGE_MANIFEST_FILE);
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`SimForge Studio resources are incomplete: ${path} is unreadable (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (typeof parsed !== "object" || parsed === null || !("schema" in parsed) || parsed.schema !== STAGE_MANIFEST_SCHEMA) {
    throw new Error(`SimForge Studio resources are incomplete: ${path} is not a ${STAGE_MANIFEST_SCHEMA} document.`);
  }
  for (const field of STRING_FIELDS) {
    if (!(field in parsed) || typeof (/** @type {Record<string, unknown>} */ (parsed))[field] !== "string") {
      throw new Error(`SimForge Studio resources are incomplete: ${path} lacks "${field}".`);
    }
  }
  const revision = /** @type {Record<string, unknown>} */ (parsed).gitRevision;
  if (revision !== null && typeof revision !== "string") {
    throw new Error(`SimForge Studio resources are incomplete: ${path} has a malformed "gitRevision".`);
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
      `This SimForge Studio build was staged for ${manifest.platform}-${manifest.arch} and cannot run on ${process.platform}-${process.arch}; ` +
        "build the desktop artifact on the target platform (see desktop/stage.mjs).",
    );
  }
}
