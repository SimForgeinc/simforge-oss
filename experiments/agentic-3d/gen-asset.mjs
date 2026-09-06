#!/usr/bin/env node
// Operator CLI: generate a Meshy asset into the shared growing library, and
// optionally register it as a render-side model OVERRIDE for an engine id
// (model-overrides.json) — e.g. replacing the riderless CARLA bicycle mesh
// with a cyclist-with-rider model. Uses the shared asset generation path.
// Usage:
//   node gen-asset.mjs --id custom.cyclist-with-rider --class vehicle \
//     --dims 1.8,0.6,1.75 --label "Cyclist with rider" \
//     --prompt "..." [--override vehicle.bicycle]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLibrary, rebuildModelsDir, meshyGenerate } from './asset-library.mjs';

const A3D = path.dirname(fileURLToPath(import.meta.url));
const argOf = (f, d) => { const i = process.argv.indexOf(`--${f}`); return i >= 0 ? process.argv[i + 1] : d; };

const [l, w, h] = String(argOf('dims', '')).split(',').map(Number);
const req = {
  assetId: argOf('id'), prompt: argOf('prompt'), label: argOf('label'),
  class: argOf('class', 'prop'), dims: { l, w, h },
};
if (!req.assetId || !req.prompt) { console.error('need --id and --prompt'); process.exit(1); }

const lib = loadLibrary();
const entry = await meshyGenerate(lib, req);
console.log(`[gen-asset] generated ${entry.id} -> ${entry.glbPath} (thumb: ${entry.thumbnail ?? 'none'})`);

const override = argOf('override');
if (override) {
  const p = path.join(A3D, 'model-overrides.json');
  let overrides = {};
  try { overrides = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* fresh */ }
  overrides[override] = { glbPath: entry.glbPath, attribution: `meshy:${entry.id}`, scaleToDims: true };
  fs.writeFileSync(p, JSON.stringify(overrides, null, 2));
  rebuildModelsDir(lib);
  console.log(`[gen-asset] override registered: ${override} -> ${entry.glbPath}`);
}
