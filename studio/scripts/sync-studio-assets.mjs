import { cp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Static URLs the product serves come from installed packages, never from a
// source checkout: Next only serves `public/`, so the synced paths are build
// outputs (see .gitignore) and the desktop stage copies them with the rest of
// `public/`.
const require = createRequire(import.meta.url);
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));

// Runtime code belongs to the application, not every immutable map closure.
// Copy the JS/WASM pair from the same installed Three release as the loader.
const basisSource = join(dirname(require.resolve("three")), "../examples/jsm/libs/basis");
const basisDestination = join(publicDir, "basis");
await mkdir(basisDestination, { recursive: true });
await Promise.all(["basis_transcoder.js", "basis_transcoder.wasm"].map((file) =>
  cp(join(basisSource, file), join(basisDestination, file)),
));

// MapLibre's module worker and its sibling import must remain together. Its
// import.meta.url fallback is a build-time file URL under Next's bundler.
const maplibreSource = join(dirname(require.resolve("maplibre-gl/package.json")), "dist");
const maplibreDestination = join(publicDir, "maplibre");
await mkdir(maplibreDestination, { recursive: true });
await Promise.all(["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"].map((file) =>
  cp(join(maplibreSource, file), join(maplibreDestination, file)),
));
await cp(join(maplibreSource, "../LICENSE.txt"), join(maplibreDestination, "LICENSE.txt"));

// Product-owned UI art the shared Studio surface references by absolute URL
// (driver-behavior icons, the CARLA mark, render-quality previews) ships in
// @simforge-oss/studio-ui/public with the same layout it needs under `/`.
const studioUiPublic = join(dirname(require.resolve("@simforge-oss/studio-ui/package.json")), "public");
await cp(studioUiPublic, publicDir, { recursive: true });
