import { cp, link, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { NodeIO } from '@gltf-transform/core';

import { GEOMETRY_LOD_DIR } from './geometry-lod/build.js';
import type { GltfDocument } from './geometry-lod/gltf-read.js';
import { parseGeometryLodManifest } from './geometry-lod/schema.js';
import { substituteLods } from './geometry-lod/substitute.js';
import type { VegetationLodLevel } from './web-tier.js';

async function linkOrCopy(source: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await link(source, destination);
  } catch {
    await cp(source, destination);
  }
}

/**
 * The geometry derivative's levels as substituted masters, one at a time
 * (level k: every LOD'd mesh at k, clamped per mesh, past its last level the
 * cross-card impostor). Impostor atlases join the web closure's `images/`
 * under their own content names, so the cells reference them like any
 * master image and the texture tiers cook them for every GPU. Null when the
 * master carries no derivative.
 */
export async function vegetationLodLevels(io: NodeIO, masterDir: string, contentDir: string): Promise<(() => AsyncIterable<VegetationLodLevel>) | null> {
  const lodDir = path.join(masterDir, ...GEOMETRY_LOD_DIR.split('/'));
  let manifestBytes: Buffer;
  try { manifestBytes = await readFile(path.join(lodDir, 'manifest.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const manifest = parseGeometryLodManifest(JSON.parse(manifestBytes.toString('utf8')));
  const masterJson = JSON.parse(await readFile(path.join(masterDir, 'master.gltf'), 'utf8')) as GltfDocument;
  const lodJson = JSON.parse(await readFile(path.join(lodDir, 'lod.gltf'), 'utf8')) as GltfDocument;
  const maxLevel = Math.max(0, ...manifest.meshes.map((mesh) => mesh.levels.length + (mesh.impostor ? 1 : 0)));
  if (maxLevel === 0) return null;
  const prefix = `${GEOMETRY_LOD_DIR}/`;
  for (const image of lodJson.images ?? []) {
    if (typeof image.uri !== 'string' || !image.uri.endsWith('.ktx2')) continue;
    await linkOrCopy(path.join(lodDir, image.uri), path.join(contentDir, 'images', path.basename(image.uri)));
  }
  const errorAt = (level: number) => {
    const byMesh = new Map(manifest.meshes.map((mesh) => {
      const clamped = Math.min(level, mesh.levels.length + (mesh.impostor ? 1 : 0));
      const error = clamped === 0 ? 0 : clamped > mesh.levels.length ? mesh.impostor!.geometricErrorM : mesh.levels[clamped - 1]!.geometricErrorM;
      return [mesh.mesh, error] as const;
    }));
    return (index: number) => byMesh.get(index) ?? 0;
  };
  return async function* levels() {
    for (let level = 1; level <= maxLevel; level++) {
      const { json } = substituteLods(masterJson, lodJson, manifest, { cameras: [], marginM: 0, fPx: 1, pixelErrorPx: 1, lodPrefix: prefix, forceLevel: level });
      const resources: Record<string, Uint8Array<ArrayBuffer>> = {};
      for (const buffer of json.buffers ?? []) {
        if (typeof buffer.uri === 'string') resources[buffer.uri] = new Uint8Array(await readFile(path.join(masterDir, buffer.uri)));
      }
      // Cells reference images by URI only; the bytes are never read.
      for (const image of json.images ?? []) {
        if (typeof image.uri !== 'string') continue;
        if (image.uri.startsWith(`${prefix}images/`)) image.uri = `images/${path.basename(image.uri)}`;
        resources[image.uri] = new Uint8Array(0);
      }
      const document = await io.readJSON({ json: json as never, resources });
      yield { level, document, errorM: errorAt(level) };
    }
  };
}

