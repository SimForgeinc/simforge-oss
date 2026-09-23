import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

import { canonicalJson, sha256 } from '../closure.js';
import { encodeKtx2, ktx2ToolFingerprint } from '../ktx2.js';
import type { Ktx2Options } from '../ktx2.js';
import { componentCount, maxScale, meshInstances, readAccessorFloat, readIndices, readMasterGeometry } from './gltf-read.js';
import type { GltfDocument, GltfMaterial, MasterGeometry } from './gltf-read.js';
import { GltfWriter } from './gltf-write.js';
import { bakeImpostor, DEFAULT_IMPOSTOR_OPTIONS, textureFromRgba } from './impostor.js';
import type { BakeMaterial, BakeTexture, ImpostorOptions } from './impostor.js';
import { buildLevel, DEFAULT_LEVEL_OPTIONS, LEVEL_ERROR_FRACTIONS, levelRatios, preparePrimitive } from './levels.js';
import type { BuiltLevel, LevelOptions, PreparedPrimitive } from './levels.js';
import { boundingSphere, triangleCount } from './mesh-ops.js';
import type { AttributeData, PrimitiveData } from './mesh-ops.js';
import { buildSensorPrimitive, DEFAULT_SENSOR_OPTIONS } from './sensor.js';
import type { SensorMethod, SensorOptions } from './sensor.js';
import { GEOMETRY_LOD_SCHEMA } from './schema.js';
import type { GeometryLodManifest, LodLevelEntry, LodMeshEntry, SensorPrimitiveEntry } from './schema.js';

/**
 * Bump when the output for identical input changes (algorithm, defaults,
 * file layout). Part of every build key, so a bump rebuilds every map.
 */
export const GEOMETRY_LOD_REVISION = 1;
export const MESHOPTIMIZER_VERSION = '1.2.0';
/** Closure directory of the derivative (next to `derived/sumo`). */
export const GEOMETRY_LOD_DIR = 'derived/geometry-lod';

export interface SelectionOptions {
  /** A mesh gets render LODs when it has at least this many triangles... */
  minTriangles: number;
  /** ...and either this many instanced triangles in the map, or `minHeavyTriangles` on its own. */
  minInstancedTriangles: number;
  minHeavyTriangles: number;
  /** Impostors only for card-like meshes at least this large (bounding radius, world metres at scale 1). */
  minImpostorRadiusM: number;
  /**
   * A single-instance opaque mesh (terrain, road layers, a building) is not
   * LODed: one distance to its bounds centre says nothing about the part of
   * it next to the camera. Neither is any mesh whose world bounding radius
   * exceeds this.
   */
  maxLodRadiusM: number;
}

export const DEFAULT_SELECTION: SelectionOptions = { minTriangles: 1000, minInstancedTriangles: 250_000, minHeavyTriangles: 50_000, minImpostorRadiusM: 0.75, maxLodRadiusM: 60 };

export interface ThresholdOptions {
  /** Runtime default: largest projected geometric error, pixels. */
  pixelErrorPx: number;
  /** Shadow passes tolerate a coarser error. */
  shadowPixelErrorPx: number;
  /** Reference camera for the precomputed switch distances. */
  referenceVerticalPx: number;
  referenceVfovDeg: number;
  /** Perceptual error of an impostor per metre of flattened depth (calibrated by the image gate). */
  impostorErrorGain: number;
}

export const DEFAULT_THRESHOLDS: ThresholdOptions = { pixelErrorPx: 1, shadowPixelErrorPx: 4, referenceVerticalPx: 1080, referenceVfovDeg: 60, impostorErrorGain: 0.25 };

export interface GeometryLodOptions {
  selection?: Partial<SelectionOptions>;
  levels?: Partial<LevelOptions>;
  sensor?: Partial<SensorOptions>;
  impostor?: Partial<ImpostorOptions>;
  thresholds?: Partial<ThresholdOptions>;
}

export interface ResolvedGeometryLodOptions {
  selection: SelectionOptions;
  levels: LevelOptions;
  sensor: SensorOptions;
  impostor: ImpostorOptions;
  thresholds: ThresholdOptions;
}

export function resolveGeometryLodOptions(options: GeometryLodOptions = {}): ResolvedGeometryLodOptions {
  return {
    selection: { ...DEFAULT_SELECTION, ...options.selection },
    levels: { ...DEFAULT_LEVEL_OPTIONS, ...options.levels },
    sensor: { ...DEFAULT_SENSOR_OPTIONS, ...options.sensor },
    impostor: { ...DEFAULT_IMPOSTOR_OPTIONS, ...options.impostor },
    thresholds: { ...DEFAULT_THRESHOLDS, ...options.thresholds },
  };
}

/** Identity of the builder: revision, simplifier, KTX2 encoder (or its absence), resolved options. */
export function geometryLodFingerprint(options: GeometryLodOptions = {}, ktx2: Ktx2Options = {}, skipKtx2 = false): string {
  return sha256(canonicalJson({
    builder: 'simforge-map-geometry-lod',
    revision: GEOMETRY_LOD_REVISION,
    meshoptimizer: MESHOPTIMIZER_VERSION,
    ktx2: skipKtx2 ? 'none' : ktx2ToolFingerprint(ktx2),
    options: resolveGeometryLodOptions(options),
  }));
}

/**
 * Content address of a derivative: the master's JSON and buffer digests plus
 * the builder fingerprint. Images the impostors bake from are named by their
 * digest inside `master.gltf`, so the master digest covers them.
 */
export function geometryLodBuildKey(input: { masterSha256: string; bufferSha256s: readonly string[]; fingerprint: string }): string {
  return sha256(canonicalJson({ schema: GEOMETRY_LOD_SCHEMA, master: input.masterSha256, buffers: input.bufferSha256s, fingerprint: input.fingerprint }));
}

export interface BuildGeometryLodOptions extends GeometryLodOptions {
  /** Directory holding `master.gltf` and its buffer. */
  masterDir: string;
  /** Output directory; receives the `derived/geometry-lod` member files at its root. */
  outputDir: string;
  /** Master image bytes by URI (`images/<sha>.png`); defaults to reading `masterDir`. */
  readImage?: (uri: string) => Promise<Uint8Array | undefined>;
  ktx2?: Ktx2Options;
  /** Skip KTX2 encoding of impostor atlases (tests; the renderer then samples the PNG). */
  skipKtx2?: boolean;
  log?: (line: string) => void;
}

export interface GeometryLodResult {
  manifest: GeometryLodManifest;
  /** Member path (relative to the derivative directory) -> sha256. */
  files: Record<string, { sha256: string; bytes: number }>;
}

/** Mesh names of vegetation (the master's own vegetation rule, plus common species). */
const VEGETATION_NAME = /veg|tree|bush|grass|foliage|plant|leaf|leaves|shrub|hedge|ivy|maple|oak|pine|palm|cypress|eucalyptus|alnus|aporosa|birch|willow|fern|conifer/i;

/** Longest edge the impostor baker samples source textures at. */
const BAKE_TEXTURE_MAX = 1024;

const fPx = (verticalPx: number, vfovDeg: number): number => verticalPx / (2 * Math.tan((vfovDeg * Math.PI) / 360));

function decodePrimitive(geometry: MasterGeometry, meshIndex: number, primitiveIndex: number): PrimitiveData {
  const primitive = geometry.json.meshes![meshIndex]!.primitives[primitiveIndex]!;
  const attributes = new Map<string, AttributeData>();
  for (const semantic of Object.keys(primitive.attributes).sort(attributeOrder)) {
    const accessorIndex = primitive.attributes[semantic]!;
    const accessor = geometry.json.accessors![accessorIndex]!;
    attributes.set(semantic, {
      data: readAccessorFloat(geometry, accessorIndex),
      components: componentCount(accessor.type),
      componentType: accessor.componentType,
      normalized: accessor.normalized === true,
      type: accessor.type,
    });
  }
  return { attributes, indices: readIndices(geometry, primitive) };
}

/** POSITION first, then glTF's usual order; stable for determinism. */
function attributeOrder(a: string, b: string): number {
  const rank = (s: string) => ['POSITION', 'NORMAL', 'TANGENT'].indexOf(s);
  const ra = rank(a), rb = rank(b);
  if (ra >= 0 || rb >= 0) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
  return a < b ? -1 : a > b ? 1 : 0;
}

function isTriangles(geometry: MasterGeometry, meshIndex: number): boolean {
  return geometry.json.meshes![meshIndex]!.primitives.every((primitive) => (primitive.mode ?? 4) === 4 && !primitive.targets?.length && primitive.attributes['POSITION'] !== undefined);
}

function meshTriangles(geometry: MasterGeometry, meshIndex: number): number {
  let total = 0;
  for (const primitive of geometry.json.meshes![meshIndex]!.primitives) {
    const count = primitive.indices !== undefined ? geometry.json.accessors![primitive.indices]!.count : geometry.json.accessors![primitive.attributes['POSITION']!]!.count;
    total += Math.floor(count / 3);
  }
  return total;
}

async function writeAtomic(file: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, file);
}

export async function buildGeometryLod(options: BuildGeometryLodOptions): Promise<GeometryLodResult> {
  await MeshoptSimplifier.ready;
  const log = options.log ?? (() => {});
  const resolved = resolveGeometryLodOptions(options);
  const fingerprint = geometryLodFingerprint(options, options.ktx2, options.skipKtx2 === true);
  const geometry = await readMasterGeometry(options.masterDir);
  const masterBytes = await readFile(path.join(options.masterDir, 'master.gltf'));
  const masterSha256 = sha256(masterBytes);
  const bufferSha256s = geometry.buffers.map((buffer, index) => sha256(buffer.subarray(0, geometry.json.buffers![index]!.byteLength)));
  const buildKey = geometryLodBuildKey({ masterSha256, bufferSha256s, fingerprint });
  const readImage = options.readImage ?? (async (uri: string) => {
    try {
      return new Uint8Array(await readFile(path.join(options.masterDir, uri)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  });

  const json = geometry.json;
  const materials = json.materials ?? [];
  const instances = meshInstances(json);
  const byMesh = new Map<number, { count: number; maxScale: number; scales: number[]; medianScale: number }>();
  for (const instance of instances) {
    const entry = byMesh.get(instance.mesh) ?? { count: 0, maxScale: 0, scales: [], medianScale: 0 };
    const scale = maxScale(instance.world);
    entry.count += 1;
    entry.maxScale = Math.max(entry.maxScale, scale);
    entry.scales.push(scale);
    byMesh.set(instance.mesh, entry);
  }
  for (const entry of byMesh.values()) entry.medianScale = entry.scales.sort((a, b) => a - b)[Math.floor((entry.scales.length - 1) / 2)]!;
  const reference = fPx(resolved.thresholds.referenceVerticalPx, resolved.thresholds.referenceVfovDeg);
  const switchDistance = (errorM: number, pixels: number) => (errorM * reference) / pixels;

  const lod = new GltfWriter(`simforge-map-geometry-lod ${GEOMETRY_LOD_REVISION} (meshoptimizer ${MESHOPTIMIZER_VERSION})`, 'lod.bin');
  const sensorWriter = new GltfWriter(`simforge-map-geometry-lod ${GEOMETRY_LOD_REVISION} sensor`, 'sensor.bin');
  const images = new Map<string, { bytes: Uint8Array; sha256: string }>();
  const textureCache = new Map<number, BakeTexture | null>();
  const meshes: LodMeshEntry[] = [];
  const sensorPrimitives: SensorPrimitiveEntry[] = [];
  const totals = { sourceInstanced: 0, sourceUnique: 0, sensorInstanced: 0, sensorUnique: 0 };

  const loadTexture = async (textureIndex: number | undefined): Promise<BakeTexture | undefined> => {
    if (textureIndex === undefined) return undefined;
    const texture = json.textures?.[textureIndex];
    const imageIndex = texture?.source;
    if (imageIndex === undefined) return undefined;
    if (!textureCache.has(imageIndex)) {
      const uri = json.images?.[imageIndex]?.uri;
      const bytes = uri ? await readImage(uri) : undefined;
      if (!bytes) {
        textureCache.set(imageIndex, null);
      } else {
        // The bake never needs more than ~1k texels per edge (a leaf card is a
        // few dozen bake pixels); decoding and dilating 4k sources in JS is the
        // slowest thing the builder could do.
        const decoded = await sharp(Buffer.from(bytes)).resize(BAKE_TEXTURE_MAX, BAKE_TEXTURE_MAX, { fit: 'inside', withoutEnlargement: true, kernel: sharp.kernel.cubic }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        textureCache.set(imageIndex, textureFromRgba(decoded.info.width, decoded.info.height, new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength)));
      }
    }
    return textureCache.get(imageIndex) ?? undefined;
  };

  const addImage = async (rgba: { width: number; height: number; rgba: Uint8Array }, cls: 'color' | 'normal'): Promise<number> => {
    const png = await sharp(Buffer.from(rgba.rgba), { raw: { width: rgba.width, height: rgba.height, channels: 4 } })
      .png({ compressionLevel: 9, adaptiveFiltering: false })
      .toBuffer();
    const digest = sha256(png);
    const pngUri = `images/${digest}.png`;
    images.set(pngUri, { bytes: png, sha256: digest });
    let ktx2Uri: string | undefined;
    if (!options.skipKtx2) {
      const encoded = await encodeKtx2(png, cls, options.ktx2);
      ktx2Uri = `images/${digest}.ktx2`;
      images.set(ktx2Uri, { bytes: encoded.bytes, sha256: sha256(encoded.bytes) });
    }
    return lod.addTexture(pngUri, ktx2Uri);
  };

  const meshCount = json.meshes?.length ?? 0;
  for (let meshIndex = 0; meshIndex < meshCount; meshIndex++) {
    const use = byMesh.get(meshIndex);
    if (!use || !isTriangles(geometry, meshIndex)) continue;
    const mesh = json.meshes![meshIndex]!;
    const triangles = meshTriangles(geometry, meshIndex);
    totals.sourceUnique += triangles;
    totals.sourceInstanced += triangles * use.count;
    const started = Date.now();
    const prepared: PreparedPrimitive[] = mesh.primitives.map((primitive, primitiveIndex) => {
      const material = primitive.material !== undefined ? materials[primitive.material] : undefined;
      return preparePrimitive({
        data: decodePrimitive(geometry, meshIndex, primitiveIndex),
        material: primitive.material,
        alphaMasked: material?.alphaMode === 'MASK' || material?.alphaMode === 'BLEND',
      });
    });

    const sphere = boundingSphere(prepared.map((primitive) => primitive.data));
    const cardLike = prepared.filter((primitive) => primitive.cards.cardLike);
    const cardTriangles = cardLike.reduce((sum, primitive) => sum + triangleCount(primitive.data), 0);
    const foliage = cardTriangles >= triangles * 0.3;
    const vegetation = cardLike.length > 0 || VEGETATION_NAME.test(mesh.name ?? '');

    // Sensor geometry for every mesh.
    prepared.forEach((primitive, primitiveIndex) => {
      const built = buildSensorPrimitive(primitive, { max: use.maxScale, median: use.medianScale }, resolved.sensor, vegetation);
      const sensorMesh = sensorWriter.addMesh({ name: `${mesh.name ?? `mesh${meshIndex}`}#${primitiveIndex}`, primitives: [{ data: built.data }] });
      const sensorTriangles = triangleCount(built.data);
      totals.sensorUnique += sensorTriangles;
      totals.sensorInstanced += sensorTriangles * use.count;
      sensorPrimitives.push({
        mesh: meshIndex, primitive: primitiveIndex, sensorMesh, method: built.method as SensorMethod,
        triangles: sensorTriangles, sourceTriangles: built.sourceTriangles, instances: use.count,
        surfaceErrorM: round(built.surfaceErrorM),
      });
    });

    const heavy = triangles >= resolved.selection.minTriangles
      && (triangles * use.count >= resolved.selection.minInstancedTriangles || triangles >= resolved.selection.minHeavyTriangles)
      && (foliage || use.count >= 2)
      && sphere.radius * use.maxScale <= resolved.selection.maxLodRadiusM;
    if (!heavy) continue;

    const levels: LodLevelEntry[] = [];
    let previous = triangles;
    let previousError = 0;
    for (const [index, ratio] of levelRatios(triangles).entries()) {
      const level: BuiltLevel = buildLevel(prepared, ratio, sphere.radius, resolved.levels, LEVEL_ERROR_FRACTIONS[Math.min(index, LEVEL_ERROR_FRACTIONS.length - 1)]);
      if (level.triangles > previous * 0.75) continue;
      const error = Math.max(level.geometricErrorM, previousError);
      const lodMesh = lod.addMesh({
        name: `${mesh.name ?? `mesh${meshIndex}`}_LOD${levels.length + 1}`,
        primitives: level.primitives.map((primitive) => ({ data: primitive.data })),
      });
      levels.push({
        level: levels.length + 1,
        lodMesh,
        triangles: level.triangles,
        method: level.method,
        geometricErrorM: round(error),
        switchDistanceM: round(switchDistance(error, resolved.thresholds.pixelErrorPx)),
        shadowSwitchDistanceM: round(switchDistance(error, resolved.thresholds.shadowPixelErrorPx)),
        ...(level.method === 'card-thin' ? {
          keptFraction: round(Math.min(...level.primitives.filter((p) => p.keptFraction !== undefined).map((p) => p.keptFraction!))),
          cardScale: round(Math.max(...level.primitives.filter((p) => p.cardScale !== undefined).map((p) => p.cardScale!))),
        } : {}),
      });
      previous = level.triangles;
      previousError = error;
    }

    let impostor: LodMeshEntry['impostor'] = null;
    if (foliage && sphere.radius * use.maxScale >= resolved.selection.minImpostorRadiusM) {
      const bakeMaterials: BakeMaterial[] = [];
      let texturesMissing = 0;
      for (const primitive of prepared) {
        const material: GltfMaterial = primitive.material !== undefined ? materials[primitive.material] ?? {} : {};
        const slot = material.pbrMetallicRoughness?.baseColorTexture;
        const texture = await loadTexture(slot?.index);
        if (slot && !texture) texturesMissing += 1;
        const factor = material.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
        bakeMaterials.push({
          baseColorFactor: [factor[0]!, factor[1]!, factor[2]!, factor[3]!],
          ...(texture ? { baseColor: texture } : {}),
          texCoord: slot?.texCoord ?? 0,
          alphaMasked: material.alphaMode === 'MASK',
          alphaCutoff: material.alphaCutoff ?? 0.5,
          doubleSided: material.doubleSided === true,
        });
      }
      if (texturesMissing > 0) {
        log(`geometry-lod: ${mesh.name}: ${texturesMissing} base colour texture(s) unavailable; no impostor`);
      } else {
        const bake = bakeImpostor(prepared.map((primitive, index) => ({ data: primitive.data, material: bakeMaterials[index]! })), resolved.impostor);
        const albedo = await addImage(bake.albedo, 'color');
        const normal = await addImage(bake.normal, 'normal');
        const roughness = mean(prepared.map((primitive) => materials[primitive.material ?? -1]?.pbrMetallicRoughness?.roughnessFactor ?? 1));
        const material = lod.addMaterial({
          name: `${mesh.name ?? `mesh${meshIndex}`}_Impostor`,
          alphaMode: 'MASK',
          alphaCutoff: 0.5,
          doubleSided: true,
          pbrMetallicRoughness: { baseColorTexture: { index: albedo }, metallicFactor: 0, roughnessFactor: round(roughness) },
          normalTexture: { index: normal },
        });
        const lodMesh = lod.addMesh({ name: `${mesh.name ?? `mesh${meshIndex}`}_Impostor`, primitives: [{ data: bake.mesh, material }] });
        const error = Math.max(previousError, resolved.thresholds.impostorErrorGain * bake.depthExtentM);
        impostor = {
          kind: 'cross-cards',
          lodMesh,
          material,
          triangles: triangleCount(bake.mesh),
          geometricErrorM: round(error),
          switchDistanceM: round(switchDistance(error, resolved.thresholds.pixelErrorPx)),
          shadowSwitchDistanceM: round(switchDistance(error, resolved.thresholds.shadowPixelErrorPx)),
          coverage: bake.coverage.map(round),
          castsShadow: true,
        };
      }
    }
    meshes.push({
      mesh: meshIndex,
      name: mesh.name ?? '',
      instances: use.count,
      maxInstanceScale: round(use.maxScale),
      triangles,
      bounds: { center: sphere.center.map(round) as [number, number, number], radius: round(sphere.radius) },
      class: foliage ? 'foliage' : 'opaque',
      primitives: prepared.map((primitive, index) => ({
        primitive: index,
        ...(primitive.material !== undefined ? { material: primitive.material } : {}),
        alphaMode: materials[primitive.material ?? -1]?.alphaMode ?? 'OPAQUE',
        cardLike: primitive.cards.cardLike,
        triangles: triangleCount(primitive.data),
      })),
      levels,
      impostor,
      shadow: { minLevel: levels.length > 0 ? 1 : 0 },
    });
    log(`geometry-lod: ${mesh.name} ${triangles} tris x${use.count}: levels ${levels.map((l) => `${l.triangles}@${l.switchDistanceM}m`).join(' ')}${impostor ? ` impostor@${impostor.switchDistanceM}m` : ''} (${Date.now() - started} ms)`);
  }

  // Write members.
  const lodOut = lod.finish();
  const sensorOut = sensorWriter.finish();
  const files: GeometryLodResult['files'] = {};
  const put = async (relative: string, bytes: Uint8Array | string): Promise<string> => {
    const buffer = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes);
    await writeAtomic(path.join(options.outputDir, relative), buffer);
    const digest = sha256(buffer);
    files[relative] = { sha256: digest, bytes: buffer.byteLength };
    return digest;
  };
  await rm(path.join(options.outputDir, 'images'), { recursive: true, force: true });
  for (const [uri, image] of [...images.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) await put(uri, image.bytes);
  const lodBin = await put('lod.bin', lodOut.bin);
  const lodJson = await put('lod.gltf', JSON.stringify(lodOut.json));
  const sensorBin = await put('sensor.bin', sensorOut.bin);
  const sensorJson = await put('sensor.gltf', JSON.stringify(sensorOut.json));

  const lodInstanced = (select: (entry: LodMeshEntry) => number) => meshes.reduce((sum, entry) => sum + select(entry) * entry.instances, 0);
  const heavyInstanced = lodInstanced((entry) => entry.triangles);
  const manifest: GeometryLodManifest = {
    schema: GEOMETRY_LOD_SCHEMA,
    buildKey,
    builder: { name: 'simforge-map-geometry-lod', revision: GEOMETRY_LOD_REVISION, meshoptimizer: MESHOPTIMIZER_VERSION, fingerprint },
    source: { master: { path: 'master.gltf', sha256: masterSha256 }, buffers: (json.buffers ?? []).map((buffer, index) => ({ path: buffer.uri!, sha256: bufferSha256s[index]! })) },
    options: { ...resolved },
    conventions: {
      keying: 'master.gltf mesh index and primitive index; Bevy sub-asset label master.gltf#Mesh{mesh}/Primitive{primitive}',
      units: 'geometricErrorM, bounds and switch distances are mesh-local; multiply by the instance world transform\'s largest axis scale',
      selection: 'per view and instance: the coarsest level (impostor last) with geometricErrorM * instanceScale * fPx / d <= pixelErrorPx, d = distance from the camera to the instance\'s world-space bounds centre, fPx = viewportHeightPx / (2 tan(vfov / 2)); level 0 is the master mesh',
      shadow: 'shadow passes: the same rule with shadowPixelErrorPx, never finer than shadow.minLevel',
      lodMeshes: 'lod.gltf mesh K replaces the whole master mesh: primitive j of K replaces master primitive j (same count, order and vertex layout) and has no material; keep the master primitive\'s material. Impostor meshes carry their own material.',
    },
    thresholds: { pixelErrorPx: resolved.thresholds.pixelErrorPx, shadowPixelErrorPx: resolved.thresholds.shadowPixelErrorPx, reference: { verticalPx: resolved.thresholds.referenceVerticalPx, vfovDeg: resolved.thresholds.referenceVfovDeg, fPx: round(reference) } },
    files: {
      lod: { path: 'lod.gltf', sha256: lodJson },
      lodBuffer: { path: 'lod.bin', sha256: lodBin },
      sensor: { path: 'sensor.gltf', sha256: sensorJson },
      sensorBuffer: { path: 'sensor.bin', sha256: sensorBin },
      images: Object.entries(files).filter(([file]) => file.startsWith('images/')).map(([file, member]) => ({ path: file, sha256: member.sha256 })),
    },
    meshes,
    sensor: {
      options: resolved.sensor,
      primitives: sensorPrimitives,
      triangles: { sourceInstanced: totals.sourceInstanced, sourceUnique: totals.sourceUnique, instanced: totals.sensorInstanced, unique: totals.sensorUnique },
      errorBound: {
        surfaceM: resolved.sensor.surfaceErrorM,
        vegetationSurfaceM: resolved.sensor.vegetationSurfaceErrorM,
        surfaceMaxEstimateM: round(Math.max(0, ...sensorPrimitives.map((entry) => entry.surfaceErrorM))),
        foliage: `area-preserving card aggregation into ${resolved.sensor.voxelM} m cells: leaf area per cell is exact; individual returns move by up to one cell diagonal (${round(resolved.sensor.voxelM * Math.sqrt(3))} m)`,
      },
    },
    totals: {
      instancedTriangles: totals.sourceInstanced,
      uniqueTriangles: totals.sourceUnique,
      lodMeshes: meshes.length,
      lodMeshInstancedTriangles: heavyInstanced,
      coarsestLevelInstancedTriangles: lodInstanced((entry) => entry.levels.at(-1)?.triangles ?? entry.triangles),
      impostorInstancedTriangles: lodInstanced((entry) => entry.impostor?.triangles ?? entry.levels.at(-1)?.triangles ?? entry.triangles),
    },
  };
  await put('manifest.json', `${canonicalJson(manifest)}\n`);
  return { manifest, files };
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1e5) / 1e5 : 0;
}

export type { GltfDocument };
