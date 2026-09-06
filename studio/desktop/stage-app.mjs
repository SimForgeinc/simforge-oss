// The Electron application directory both desktop stages produce: the shell
// bundle (desktop/main.mjs with its mode baked in), the verbatim sandboxed
// preload, the static pages the mode needs and a dependency-free
// package.json. electron-builder packs exactly this directory into app.asar,
// so nothing here may pull in workspace node_modules: the shell's runtime
// dependencies are bundled, `electron` is provided by the binary, and the
// preload is a self-contained CommonJS file (sandboxed preloads can only
// `require("electron")`).
//
//   local  desktop/stage.mjs      shell + local host resources (Linux-qualified runtime)
//   cloud  desktop/stage-cloud.mjs shell only, connects to a SimCloud origin

import { build } from "esbuild";
import { access, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = dirname(fileURLToPath(import.meta.url));
const studioRoot = resolve(desktopDir, "..");

/** The preload the cache owner ships; staged verbatim, never bundled. */
export const CACHE_PRELOAD = "cache-preload.cjs";

/** The production SimCloud origin a cloud build connects to unless told otherwise. */
export const DEFAULT_CLOUD_ORIGIN = "https://simforge.ai";

const MODES = {
  local: {
    name: "simforge-studio",
    productName: "SimForge Studio",
    description: "SimForge Studio desktop: the local Studio host and its shell.",
    pages: ["starting.html", "host-exited.html"],
  },
  cloud: {
    name: "simcloud",
    productName: "SimCloud",
    description: "SimCloud desktop: the hosted SimForge product with an on-disk map cache.",
    pages: ["starting.html", "unreachable.html"],
  },
};

/**
 * Bundle Node-side entry points into self-contained ESM.
 * @param {Record<string, string>} entryPoints
 * @param {string} outdir
 * @param {string[]} external
 * @param {Record<string, string>} define compile-time constants (`process.env.X` → literal)
 * @returns {Promise<Record<string, string[]>>} bundled source inputs per output file
 */
export async function bundleNode(entryPoints, outdir, external, define = {}) {
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
    define,
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
 * Write the application directory for one mode.
 * @param {{ appDir: string; mode: "local" | "cloud"; origin?: string; version: string; license?: string }} options
 *   `origin` is the SimCloud origin baked into a cloud build (runtime
 *   SIMCLOUD_ORIGIN still overrides it); ignored for local builds.
 * @returns {Promise<{ files: string[]; inputs: string[] }>} staged file names and bundled shell inputs
 */
export async function stageApp({ appDir, mode, origin, version, license }) {
  const spec = MODES[mode];
  if (!spec) throw new Error(`unknown desktop mode ${mode}`);
  const preloadSource = join(desktopDir, CACHE_PRELOAD);
  await access(preloadSource).catch(() => {
    throw new Error(`${preloadSource} missing: the desktop map cache preload is part of the shell.`);
  });

  await rm(appDir, { recursive: true, force: true });
  await mkdir(appDir, { recursive: true });
  const bundled = await bundleNode({ main: join(desktopDir, "main.mjs") }, appDir, ["electron"], {
    "process.env.SIMFORGE_DESKTOP_MODE": JSON.stringify(mode),
    "process.env.SIMFORGE_DESKTOP_BUILT_ORIGIN": mode === "cloud" ? JSON.stringify(origin ?? "") : "undefined",
  });
  const inputs = Object.values(bundled).flat();
  if (mode === "cloud" && inputs.some((input) => input.includes("desktop/local-host.mjs") || input.includes("studio-host"))) {
    throw new Error("cloud shell bundle pulled in the local host; SIMFORGE_DESKTOP_MODE dead-code elimination failed");
  }
  await cp(preloadSource, join(appDir, CACHE_PRELOAD));
  for (const page of spec.pages) await cp(join(desktopDir, page), join(appDir, page));
  await writeFile(join(appDir, "package.json"), `${JSON.stringify({
    name: spec.name,
    productName: spec.productName,
    version,
    description: spec.description,
    homepage: "https://github.com/SimForgeinc/simforge-oss",
    license: license ?? "Apache-2.0",
    author: { name: "SimForge", email: "oss@simforge.ai" },
    private: true,
    type: "module",
    main: "main.mjs",
  }, null, 2)}\n`);

  // The asar is exactly this directory: the bundle, the preload, the pages and
  // the manifest. Anything else (a stray node_modules above all) is a stage bug.
  const files = (await readdir(appDir)).sort();
  const expected = ["main.mjs", CACHE_PRELOAD, ...spec.pages, "package.json"].sort();
  const extra = files.filter((file) => !expected.includes(file));
  if (extra.length > 0) throw new Error(`unexpected files in the application directory: ${extra.join(", ")}`);
  return { files, inputs };
}
