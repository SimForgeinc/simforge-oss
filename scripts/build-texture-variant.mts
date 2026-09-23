#!/usr/bin/env -S node --conditions=development --import tsx
/**
 * The full-resolution GPU-block texture tier of installed maps
 * (docs/engineering/map-texture-variants.md).
 *
 *   pnpm maps:textures-full-bc7 -- --map-dir DIR [--out DIR] [--tool BIN]    build one map
 *   pnpm maps:textures-full-bc7 -- --map-dir DIR --check                      current / stale / missing
 *
 * DIR holds a native closure (`master.gltf`, `3d/manifest.json`,
 * `images/*.ktx2`); the output goes to `DIR/derived/textures-full-bc7/` (or
 * --out). The generator is the pinned `ktx2-gpu-variant` (--tool, else
 * SIMFORGE_KTX2_GPU_VARIANT_BIN). stdout is one JSON document.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  buildTexturesFullBc7, masterKtx2Images, resolveGpuVariantTool, sha256, TEXTURES_FULL_BC7_DIR, textureVariantBuildKey,
  textureVariantFingerprint, textureVariantManifestSchema,
} from '../packages/map-pipeline/src/index.ts';

const argv = process.argv.slice(2).filter((argument, index) => !(index === 0 && argument === '--'));
const option = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? undefined : argv[index + 1];
};
const mapDir = option('map-dir');
if (!mapDir) {
  process.stderr.write(`${JSON.stringify({ code: 'usage', reason: 'pass --map-dir DIR' })}\n`);
  process.exit(1);
}
try {
  const tool = await resolveGpuVariantTool(option('tool'));
  const outputDir = path.resolve(option('out') ?? path.join(mapDir, ...TEXTURES_FULL_BC7_DIR.split('/')));
  const master = await readFile(path.join(mapDir, 'master.gltf'));
  const sourceManifestSha256 = sha256(await readFile(path.join(mapDir, '3d', 'manifest.json')));
  const images: Record<string, string> = {};
  for (const uri of masterKtx2Images(JSON.parse(master.toString('utf8')))) images[uri] = sha256(await readFile(path.join(mapDir, uri)));
  const expectedKey = textureVariantBuildKey({ masterSha256: sha256(master), sourceManifestSha256, images, fingerprint: textureVariantFingerprint(tool) });
  if (argv.includes('--check')) {
    let buildKey: string | null = null;
    try {
      buildKey = textureVariantManifestSchema.parse(JSON.parse(await readFile(path.join(outputDir, 'manifest.json'), 'utf8'))).buildKey;
    } catch {
      buildKey = null;
    }
    process.stdout.write(`${JSON.stringify({ mapDir, status: buildKey === null ? 'missing' : buildKey === expectedKey ? 'current' : 'stale', buildKey, expectedKey }, null, 2)}\n`);
  } else {
    const started = Date.now();
    const result = await buildTexturesFullBc7({
      master, sourceManifestSha256, outputDir, tool,
      readImage: async (uri) => new Uint8Array(await readFile(path.join(mapDir, uri))),
      log: (line) => process.stderr.write(`${line}\n`),
    });
    process.stdout.write(`${JSON.stringify({ mapDir, outputDir, buildKey: result.manifest.buildKey, seconds: (Date.now() - started) / 1000, totals: result.manifest.totals, files: Object.keys(result.files).length }, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ code: 'texture_variant_failed', reason: error instanceof Error ? error.message : String(error) })}\n`);
  process.exit(1);
}
