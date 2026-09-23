import { maxScale, meshInstances, transformPoint } from './gltf-read.js';
import type { GltfDocument } from './gltf-read.js';
import type { GeometryLodManifest } from './schema.js';

/**
 * A static LOD selection baked into a copy of `master.gltf`: every instance
 * of a LOD'd mesh is pointed at the level the selection rule picks for the
 * closest of a set of camera positions. Used by the image gate and
 * render-bench to measure LODs through the unmodified renderer (the runtime
 * selects per view and per frame; this is the conservative static bound of
 * that selection over a clip). The output references the master's buffers
 * and images unchanged plus the derivative's `lod.bin` and impostor images.
 */

export interface SubstituteOptions {
  /** World-space camera positions the selection must be valid for. */
  cameras: ReadonlyArray<readonly [number, number, number]>;
  /** Distance slack subtracted from every camera distance (rig offsets from the positions given). */
  marginM: number;
  /** Largest focal length of the rig, pixels. */
  fPx: number;
  pixelErrorPx: number;
  /** URI prefix from the master's directory to the derivative's (e.g. `derived/geometry-lod/`). */
  lodPrefix: string;
  /** Force every LOD'd instance to one level (0 = master, n = impostor when past the last level); for inspection. */
  forceLevel?: number;
  /** Never select the impostor. */
  noImpostor?: boolean;
}

export interface SubstituteReport {
  instances: number;
  byLevel: Record<string, number>;
  trianglesBefore: number;
  trianglesAfter: number;
}

type Json = Record<string, unknown>;

export function substituteLods(master: GltfDocument, lod: GltfDocument, manifest: GeometryLodManifest, options: SubstituteOptions): { json: GltfDocument; report: SubstituteReport } {
  const out = JSON.parse(JSON.stringify(master)) as GltfDocument & Json;
  const bufferOffset = out.buffers!.length;
  out.buffers!.push(...(lod.buffers ?? []).map((buffer) => ({ ...buffer, uri: `${options.lodPrefix}${buffer.uri}` })));
  const viewOffset = out.bufferViews!.length;
  out.bufferViews!.push(...(lod.bufferViews ?? []).map((view) => ({ ...view, buffer: view.buffer + bufferOffset })));
  const accessorOffset = out.accessors!.length;
  out.accessors!.push(...(lod.accessors ?? []).map((accessor) => ({ ...accessor, ...(accessor.bufferView !== undefined ? { bufferView: accessor.bufferView + viewOffset } : {}) })));
  const imageOffset = (out.images ??= []).length;
  out.images.push(...(lod.images ?? []).map((image) => ({ ...image, uri: `${options.lodPrefix}${image.uri}` })));
  const samplers = ((out as Json)['samplers'] ??= []) as unknown[];
  const samplerOffset = samplers.length;
  samplers.push(...(((lod as Json)['samplers'] as unknown[] | undefined) ?? []));
  const textureOffset = (out.textures ??= []).length;
  out.textures.push(...(lod.textures ?? []).map((texture) => {
    const copy = JSON.parse(JSON.stringify(texture)) as Json;
    if (typeof copy['source'] === 'number') copy['source'] = (copy['source'] as number) + imageOffset;
    if (typeof copy['sampler'] === 'number') copy['sampler'] = (copy['sampler'] as number) + samplerOffset;
    const basisu = (copy['extensions'] as Json | undefined)?.['KHR_texture_basisu'] as Json | undefined;
    if (basisu && typeof basisu['source'] === 'number') basisu['source'] = (basisu['source'] as number) + imageOffset;
    return copy as never;
  }));
  const materialOffset = (out.materials ??= []).length;
  out.materials.push(...(lod.materials ?? []).map((material) => {
    const copy = JSON.parse(JSON.stringify(material)) as Json;
    const shift = (slot: Json | undefined) => { if (slot && typeof slot['index'] === 'number') slot['index'] = (slot['index'] as number) + textureOffset; };
    shift((copy['pbrMetallicRoughness'] as Json | undefined)?.['baseColorTexture'] as Json | undefined);
    shift(copy['normalTexture'] as Json | undefined);
    return copy as never;
  }));
  out.extensionsUsed = [...new Set([...(out.extensionsUsed ?? []), ...(lod.extensionsUsed ?? [])])];

  // Materialize each LOD mesh once, with the master primitive's material (levels) or its own (impostor).
  const added = new Map<number, number>();
  const materialize = (lodMesh: number, masterMesh: number | null): number => {
    const existing = added.get(lodMesh);
    if (existing !== undefined) return existing;
    const source = lod.meshes![lodMesh]!;
    const masterPrimitives = masterMesh === null ? null : master.meshes![masterMesh]!.primitives;
    const primitives = source.primitives.map((primitive, index) => {
      const attributes = Object.fromEntries(Object.entries(primitive.attributes).map(([semantic, accessor]) => [semantic, accessor + accessorOffset]));
      const material = masterPrimitives ? masterPrimitives[index]!.material : primitive.material !== undefined ? primitive.material + materialOffset : undefined;
      return { attributes, indices: primitive.indices! + accessorOffset, mode: 4, ...(material !== undefined ? { material } : {}) };
    });
    out.meshes!.push({ name: source.name, primitives } as never);
    const index = out.meshes!.length - 1;
    added.set(lodMesh, index);
    return index;
  };

  const entries = new Map(manifest.meshes.map((entry) => [entry.mesh, entry]));
  const report: SubstituteReport = { instances: 0, byLevel: {}, trianglesBefore: 0, trianglesAfter: 0 };
  for (const instance of meshInstances(master)) {
    const entry = entries.get(instance.mesh);
    if (!entry) continue;
    const scale = maxScale(instance.world);
    const center = transformPoint(instance.world, ...entry.bounds.center);
    let distance = Infinity;
    for (const camera of options.cameras) distance = Math.min(distance, Math.hypot(center[0] - camera[0], center[1] - camera[1], center[2] - camera[2]));
    distance = Math.max(1e-3, distance - options.marginM);
    const allowed = (errorM: number) => (errorM * scale * options.fPx) / distance <= options.pixelErrorPx;
    let level = 0;
    if (options.forceLevel !== undefined) {
      level = Math.min(options.forceLevel, entry.levels.length + (entry.impostor && !options.noImpostor ? 1 : 0));
    } else {
      entry.levels.forEach((candidate) => { if (allowed(candidate.geometricErrorM)) level = candidate.level; });
      if (entry.impostor && !options.noImpostor && level === entry.levels.length && allowed(entry.impostor.geometricErrorM)) level = entry.levels.length + 1;
    }
    report.instances += 1;
    const name = level === 0 ? 'L0' : level > entry.levels.length ? 'impostor' : `L${level}`;
    report.byLevel[name] = (report.byLevel[name] ?? 0) + 1;
    report.trianglesBefore += entry.triangles;
    if (level === 0) {
      report.trianglesAfter += entry.triangles;
      continue;
    }
    const node = out.nodes![instance.node]!;
    if (level > entry.levels.length) {
      node.mesh = materialize(entry.impostor!.lodMesh, null);
      report.trianglesAfter += entry.impostor!.triangles;
    } else {
      const chosen = entry.levels[level - 1]!;
      node.mesh = materialize(chosen.lodMesh, entry.mesh);
      report.trianglesAfter += chosen.triangles;
    }
  }
  return { json: out, report };
}
