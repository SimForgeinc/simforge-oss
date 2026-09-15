// The Electron application directory desktop/stage.mjs produces: the shell
// bundle (desktop/main.mjs), the verbatim sandboxed preload, the static
// pages, the window icon and a dependency-free package.json. electron-builder
// packs exactly this directory into app.asar, so nothing here may pull in
// workspace node_modules: the shell's runtime dependencies are bundled,
// `electron` is provided by the binary, and the preload is a self-contained
// CommonJS file (sandboxed preloads can only `require("electron")`).

import { build } from "esbuild";
import { access, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT } from "./stage-manifest.mjs";
import { CHANNELS, assertLabel, assertLabelMatchesBuild, releaseTag } from "./release-identity.mjs";

const desktopDir = dirname(fileURLToPath(import.meta.url));
const studioRoot = resolve(desktopDir, "..");

/** The preloads the shell ships; staged verbatim, never bundled. */
export const CACHE_PRELOAD = "cache-preload.cjs";
export const CONNECTIONS_PRELOAD = "connections-preload.cjs";
export const PRELOADS = [CACHE_PRELOAD, CONNECTIONS_PRELOAD];
/**
 * Static pages the shell loads from the asar, with their stylesheets, the
 * script that hydrates them and the face they render in. `shell.css` and the
 * `connections.*` chooser are hand-authored; the rest are generated from
 * `CloudLoadingSurface` by desktop/build-shell-pages.mjs and committed.
 * Staging copies them all, so packaging needs no React or StyleX toolchain.
 *
 * The chooser is loaded before any host page and must therefore be in the
 * asar: a packaged shell that cannot open connections.html has no way to
 * choose a host at all.
 */
export const PAGES = [
  "starting.html",
  "host-exited.html",
  "connections.html",
  "connections.css",
  "connections.js",
  "cloud-loading.css",
  "cloud-loading.js",
  "barlow-400.woff2",
  "barlow-500.woff2",
  "barlow-600.woff2",
  "shell.css",
];
/** Exactly what app.asar holds. */
export const APP_FILES = ["main.mjs", ...PRELOADS, ...PAGES, "icon.png", "package.json"].sort();

/**
 * Bundle Node-side entry points into self-contained ESM.
 * @param {Record<string, string>} entryPoints
 * @param {string} outdir
 * @param {string[]} external
 * @returns {Promise<Record<string, string[]>>} bundled source inputs per output file
 */
export async function bundleNode(entryPoints, outdir, external) {
  const result = await build({
    entryPoints,
    outdir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
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

/**
 * The publication this build is being packaged for, read from the
 * environment the release workflow sets. Omitted when nothing is set: an
 * unlabelled build (a local `desktop:stage`, or a candidate packaged before
 * anyone decided what to call it) must not claim a distribution, and the
 * shell's update check reports it as uncomparable rather than up to date.
 * @param {string} embeddedVersion
 * @returns {{ label: string; tag: string; channel: string; embeddedVersion: string } | undefined}
 */
export function distributionIdentity(embeddedVersion) {
  const label = process.env.SIMFORGE_DESKTOP_DISTRIBUTION_LABEL?.trim();
  if (!label) return undefined;
  assertLabel(label);
  assertLabelMatchesBuild({ label, embeddedVersion });
  const channel = process.env.SIMFORGE_DESKTOP_DISTRIBUTION_CHANNEL?.trim() || "preview";
  if (!CHANNELS.includes(channel)) {
    throw new Error(`SIMFORGE_DESKTOP_DISTRIBUTION_CHANNEL must be one of ${CHANNELS.join(", ")}`);
  }
  return { label, tag: releaseTag(label), channel, embeddedVersion };
}

/**
 * Write the application directory.
 * @param {{ appDir: string; version: string; license?: string }} options
 * @returns {Promise<{ files: string[]; inputs: string[] }>} staged file names and bundled shell inputs
 */
export async function stageApp({ appDir, version, license }) {
  const cloudOrigin = new URL(process.env.SIMFORGE_DESKTOP_CLOUD_ORIGIN?.trim() || "https://simforge.ai");
  if (cloudOrigin.protocol !== "https:" || cloudOrigin.username || cloudOrigin.password
    || cloudOrigin.pathname !== "/" || cloudOrigin.search || cloudOrigin.hash) {
    throw new Error("SIMFORGE_DESKTOP_CLOUD_ORIGIN must be an HTTPS origin");
  }
  for (const preload of PRELOADS) {
    const source = join(desktopDir, preload);
    await access(source).catch(() => {
      throw new Error(`${source} missing: the shell's sandboxed preloads are part of the shell.`);
    });
  }

  await rm(appDir, { recursive: true, force: true });
  await mkdir(appDir, { recursive: true });
  const bundled = await bundleNode({ main: join(desktopDir, "main.mjs") }, appDir, ["electron"]);
  const inputs = Object.values(bundled).flat();
  for (const preload of PRELOADS) await cp(join(desktopDir, preload), join(appDir, preload));
  for (const page of PAGES) await cp(join(desktopDir, page), join(appDir, page));
  await cp(join(desktopDir, "build", "icon.png"), join(appDir, "icon.png"));
  await writeFile(join(appDir, "package.json"), `${JSON.stringify({
    name: PRODUCT.packageName,
    productName: PRODUCT.name,
    version,
    simforgeCloudOrigin: cloudOrigin.origin,
    simforgeDistribution: distributionIdentity(version),
    description: "SimForge Studio desktop: the local Studio host, native rendering and the SimCloud connector.",
    homepage: "https://github.com/SimForgeinc/simforge-oss",
    license: license ?? "Apache-2.0",
    author: { name: "SimForge", email: "oss@simforge.ai" },
    private: true,
    type: "module",
    main: "main.mjs",
  }, null, 2)}\n`);

  // The asar is exactly this directory. Anything else (a stray node_modules
  // above all) is a stage bug.
  const files = (await readdir(appDir)).sort();
  const extra = files.filter((file) => !APP_FILES.includes(file));
  if (extra.length > 0) throw new Error(`unexpected files in the application directory: ${extra.join(", ")}`);
  return { files, inputs };
}
