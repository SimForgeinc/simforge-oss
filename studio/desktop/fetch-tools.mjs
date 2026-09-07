#!/usr/bin/env node
// Fetches the encoder binaries the desktop stage bundles, pinned by digest.
//
//   node desktop/fetch-tools.mjs [--target <platform-arch>]
//
// Writes dist/desktop-tools/<platform>-<arch>/{ffmpeg,ffprobe}[.exe], LICENSE
// and tools-manifest.json. Every download is verified against
// desktop/tools.lock.json before it is kept; a file already present with the
// pinned digest is not downloaded again, so a warm dist/ works offline.
// desktop/stage.mjs re-verifies the digests when it copies the tools.

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { targetFor } from "./stage-manifest.mjs";

const desktopDir = dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(await readFile(join(desktopDir, "tools.lock.json"), "utf8"));
if (lock.schema !== "simforge.desktop-tools-lock/v1") throw new Error("desktop/tools.lock.json: unsupported schema");

export const TOOLS_MANIFEST_SCHEMA = "simforge.desktop-tools/v1";
export const TOOLS_MANIFEST_FILE = "tools-manifest.json";

/** @param {string} path */
export async function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

/**
 * @param {string} path
 * @param {{ sha256: string; sizeBytes: number }} pin
 */
export async function matchesPin(path, pin) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size !== pin.sizeBytes) return false;
  return (await sha256File(path)) === pin.sha256;
}

/**
 * The lock's pins for one target: the only statement of what the bundled
 * encoders are, read from the repository, never from a stage or package.
 * @param {ReturnType<typeof targetFor>["key"]} targetKey
 * @returns {Record<"ffmpeg" | "ffprobe" | "license", { url: string; sha256: string; sizeBytes: number }>}
 */
export function toolPins(targetKey) {
  const pins = lock.ffmpeg.targets[targetKey];
  if (!pins) throw new Error(`desktop/tools.lock.json has no encoder pins for ${targetKey}`);
  return pins;
}

/**
 * The tools directory for one target and what the stage expects in it.
 * @param {string} distRoot studio/dist
 * @param {ReturnType<typeof targetFor>} target
 */
export function toolsLayout(distRoot, target) {
  const dir = join(distRoot, "desktop-tools", target.key);
  return {
    dir,
    ffmpeg: join(dir, `ffmpeg${target.exe}`),
    ffprobe: join(dir, `ffprobe${target.exe}`),
    license: join(dir, "LICENSE"),
    manifest: join(dir, TOOLS_MANIFEST_FILE),
    pins: toolPins(target.key),
    version: lock.ffmpeg.version,
    licenseId: lock.ffmpeg.license,
  };
}

/**
 * @param {string} url
 * @param {string} destination
 * @param {{ sha256: string; sizeBytes: number }} pin
 */
async function download(url, destination, pin) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  const partial = `${destination}.partial`;
  await writeFile(partial, response.body);
  if (!(await matchesPin(partial, pin))) {
    await rm(partial, { force: true });
    throw new Error(`${url}: downloaded bytes do not match the pinned digest ${pin.sha256} (${pin.sizeBytes} bytes)`);
  }
  await rename(partial, destination);
}

/**
 * @param {string} distRoot
 * @param {ReturnType<typeof targetFor>} target
 */
export async function fetchTools(distRoot, target) {
  const layout = toolsLayout(distRoot, target);
  await mkdir(layout.dir, { recursive: true });
  for (const [name, path] of [["ffmpeg", layout.ffmpeg], ["ffprobe", layout.ffprobe], ["license", layout.license]]) {
    const pin = layout.pins[name];
    if (!(await matchesPin(path, pin))) {
      process.stderr.write(`desktop tools: fetching ${name} for ${target.key}\n`);
      await download(pin.url, path, pin);
    }
    if (name !== "license" && target.exe === "") await chmod(path, 0o755);
  }
  const manifest = {
    schema: TOOLS_MANIFEST_SCHEMA,
    target: target.key,
    version: layout.version,
    license: layout.licenseId,
    source: lock.ffmpeg.source,
    tools: {
      ffmpeg: { file: `ffmpeg${target.exe}`, ...layout.pins.ffmpeg },
      ffprobe: { file: `ffprobe${target.exe}`, ...layout.pins.ffprobe },
    },
  };
  await writeFile(layout.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  return layout;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requested = process.argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length);
  const [platform, arch] = requested ? requested.split("-") : [process.platform, process.arch];
  const target = targetFor(/** @type {NodeJS.Platform} */ (platform), arch);
  const layout = await fetchTools(resolve(desktopDir, "..", "dist"), target);
  process.stdout.write(`${JSON.stringify({ component: "simforge-desktop-stage", event: "tools.ready", target: target.key, dir: layout.dir, version: layout.version })}\n`);
}
