import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelFamilyId, ModelQuant } from "./catalog";

/**
 * Install layout for downloaded models — user data, never inside the app
 * bundle and never a release asset.
 *
 *   ${SIMFORGE_ASSETS_ROOT:-~/simforge-assets}/
 *     hf-cache/                         shared HF blob cache (HF_HOME)
 *     tools/uv/                         digest-pinned uv, for family venvs
 *     models/<family>/<revision>/
 *       weights/                        the checkpoint
 *       sidecars/<org--repo>/           config/tokenizer text only
 *       code/                           upstream checkout at the pinned commit
 *       .venv/                          isolated per-family Python runtime
 *       licenses/                       LICENSE + NOTICE provenance copies
 *       install.json                    simforge.model-install/v1 step ledger
 *
 * This root sits outside the desktop app's `resolveDataRoot()`, so an
 * uninstall of the application does not delete tens of gigabytes of weights
 * the user may still want, and equally does not silently retain them: the
 * store's own uninstall command is the one thing that removes them.
 */
export const ASSETS_ROOT_ENV = "SIMFORGE_ASSETS_ROOT";
export const INSTALL_SCHEMA = "simforge.model-install/v1";

export function assetsRoot(): string {
  const explicit = process.env[ASSETS_ROOT_ENV]?.trim();
  if (explicit) return resolve(explicit.startsWith("~") ? join(homedir(), explicit.slice(1)) : explicit);
  return join(homedir(), "simforge-assets");
}

export function hfCacheRoot(): string {
  const explicit = process.env.SIMFORGE_HF_HOME?.trim();
  return explicit ? resolve(explicit) : join(assetsRoot(), "hf-cache");
}

export function modelsRoot(): string {
  return join(assetsRoot(), "models");
}

export type InstallLayout = {
  readonly family: ModelFamilyId;
  readonly revision: string;
  readonly root: string;
  readonly weights: string;
  readonly sidecars: string;
  readonly code: string;
  readonly venv: string;
  readonly licenses: string;
  readonly installJson: string;
};

export function installLayout(family: ModelFamilyId, revision: string): InstallLayout {
  const root = join(modelsRoot(), family, revision);
  return {
    family,
    revision,
    root,
    weights: join(root, "weights"),
    sidecars: join(root, "sidecars"),
    code: join(root, "code"),
    venv: join(root, ".venv"),
    licenses: join(root, "licenses"),
    installJson: join(root, "install.json"),
  };
}

/** The python interpreter inside a family's isolated runtime. */
export function venvPython(layout: InstallLayout): string {
  return join(layout.venv, process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
}

/**
 * The endpoint command the model registry stores for one install.
 *
 * Both transports come from one process: the unix socket carries closed-loop
 * frames, and the HTTP facade exists so the existing `http-json` open-loop
 * executor works without learning MessagePack or loading a second copy of
 * the weights.
 */
export function endpointCommand(
  layout: InstallLayout,
  quant: ModelQuant,
  options: { socketPath: string; httpBind?: string; checkpointDigest?: string },
): string[] {
  const argv = [
    venvPython(layout),
    "-m",
    "simforge_alpamayo.server",
    "--family",
    layout.family,
    "--quant",
    quant,
    "--socket",
    options.socketPath,
    "--weights-dir",
    layout.weights,
    "--sidecar-dir",
    layout.sidecars,
  ];
  if (options.httpBind) argv.push("--http", options.httpBind);
  // Passing the expected digest makes the process refuse to serve a
  // checkpoint that is not the one the registry row names.
  if (options.checkpointDigest) argv.push("--checkpoint-digest", options.checkpointDigest);
  return argv;
}
