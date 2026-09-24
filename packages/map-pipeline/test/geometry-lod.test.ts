import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { NodeIO } from '@gltf-transform/core';
import type { Document as GltfDocument } from '@gltf-transform/core';
import { Document } from '@gltf-transform/core';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sha256 } from '../src/closure.js';
import { encodeKtx2 } from '../src/ktx2.js';
import { buildGeometryLod, geometryLodBuildKey, parseGeometryLodManifest } from '../src/geometry-lod/index.js';
import type { GeometryLodManifest } from '../src/geometry-lod/index.js';
import { analyzeCards, connectedComponents, thinCards } from '../src/geometry-lod/mesh-ops.js';
import type { PrimitiveData } from '../src/geometry-lod/mesh-ops.js';
import { aggregateCards } from '../src/geometry-lod/sensor.js';
import { preparePrimitive } from '../src/geometry-lod/levels.js';
import { substituteLods } from '../src/geometry-lod/substitute.js';

/** Deterministic LCG: the fixture never changes between runs. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

interface Geometry { positions: number[]; normals: number[]; tangents: number[]; uvs: number[]; indices: number[] }

function trunk(): Geometry {
  const g: Geometry = { positions: [], normals: [], tangents: [], uvs: [], indices: [] };
  const segments = 16, rings = 10;
  for (let r = 0; r <= rings; r++) {
    for (let s = 0; s <= segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      g.positions.push(Math.cos(a) * 0.25, (r / rings) * 5, Math.sin(a) * 0.25);
      g.normals.push(Math.cos(a), 0, Math.sin(a));
      g.tangents.push(-Math.sin(a), 0, Math.cos(a), 1);
      g.uvs.push(s / segments, r / rings);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s, b = a + segments + 1;
      g.indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return g;
}

function leaves(count: number): Geometry {
  const random = rng(7);
  const g: Geometry = { positions: [], normals: [], tangents: [], uvs: [], indices: [] };
  for (let i = 0; i < count; i++) {
    // Uniform in a canopy sphere of radius 3 centred 6 m up.
    let x = 0, y = 0, z = 0;
    do { x = random() * 2 - 1; y = random() * 2 - 1; z = random() * 2 - 1; } while (x * x + y * y + z * z > 1);
    const cx = x * 3, cy = 6 + y * 3, cz = z * 3;
    const yaw = random() * Math.PI * 2, pitch = (random() - 0.5) * Math.PI;
    const ux = Math.cos(yaw), uz = Math.sin(yaw);
    const vx = -Math.sin(pitch) * uz, vy = Math.cos(pitch), vz = Math.sin(pitch) * ux;
    const nx = uz * vy, ny = ux * vz - uz * vx, nz = -ux * vy;
    const base = g.positions.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      g.positions.push(cx + (ux * su + vx * sv) * 0.2, cy + vy * sv * 0.2, cz + (uz * su + vz * sv) * 0.2);
      g.normals.push(nx, ny, nz);
      g.tangents.push(ux, 0, uz, 1);
      g.uvs.push((su + 1) / 2, (1 - sv) / 2);
    }
    g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return g;
}

function ground(): Geometry {
  const g: Geometry = { positions: [], normals: [], tangents: [], uvs: [], indices: [] };
  const n = 20;
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
    g.positions.push(i * 10 - 100, 0, j * 10 - 100);
    g.normals.push(0, 1, 0);
    g.tangents.push(1, 0, 0, 1);
    g.uvs.push(i / n, j / n);
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const a = i * (n + 1) + j, b = a + n + 1;
    g.indices.push(a, a + 1, b, a + 1, b + 1, b);
  }
  return g;
}

function primitive(document: GltfDocument, buffer: ReturnType<GltfDocument['createBuffer']>, geometry: Geometry, extras: { colors?: boolean } = {}) {
  const accessor = (array: Float32Array | Uint32Array | Uint16Array | Uint8Array, type: 'VEC2' | 'VEC3' | 'VEC4' | 'SCALAR') =>
    document.createAccessor().setArray(array).setType(type).setBuffer(buffer);
  const prim = document.createPrimitive()
    .setAttribute('POSITION', accessor(new Float32Array(geometry.positions), 'VEC3'))
    .setAttribute('NORMAL', accessor(new Float32Array(geometry.normals), 'VEC3'))
    .setAttribute('TANGENT', accessor(new Float32Array(geometry.tangents), 'VEC4'))
    .setAttribute('TEXCOORD_0', accessor(new Float32Array(geometry.uvs), 'VEC2'))
    // A second UV set stored as normalized uint16: its encoding must survive.
    .setAttribute('TEXCOORD_1', accessor(new Uint16Array(geometry.uvs.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 65535))), 'VEC2').setNormalized(true))
    .setIndices(accessor(new Uint32Array(geometry.indices), 'SCALAR'));
  if (extras.colors) prim.setAttribute('COLOR_0', accessor(new Uint8Array((geometry.positions.length / 3) * 4).fill(200), 'VEC4').setNormalized(true));
  return prim;
}

let root = '';
let masterDir = '';
let leafPng: Buffer;

async function writeMaster(directory: string): Promise<void> {
  const document = new Document();
  const buffer = document.createBuffer().setURI('geometry.bin');
  // A leaf texture: an opaque disc on a transparent card.
  const size = 32;
  const raw = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o = (y * size + x) * 4;
    const inside = (x - 15.5) ** 2 + (y - 15.5) ** 2 < 14 ** 2;
    raw[o] = 40; raw[o + 1] = 120; raw[o + 2] = 30; raw[o + 3] = inside ? 255 : 0;
  }
  leafPng = await sharp(raw, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
  const leafTexture = document.createTexture('leaf').setImage(leafPng).setMimeType('image/png').setURI(`images/${sha256(leafPng)}.png`);
  const leaf = document.createMaterial('Leaf').setAlphaMode('MASK').setAlphaCutoff(0.5).setDoubleSided(true).setBaseColorTexture(leafTexture).setRoughnessFactor(0.9);
  const bark = document.createMaterial('Bark').setAlphaMode('MASK').setAlphaCutoff(0.33).setBaseColorFactor([0.4, 0.3, 0.2, 1]);
  const soil = document.createMaterial('Soil').setBaseColorFactor([0.3, 0.3, 0.3, 1]);
  const tree = document.createMesh('SM_TestTree')
    .addPrimitive(primitive(document, buffer, trunk(), { colors: true }).setMaterial(bark))
    .addPrimitive(primitive(document, buffer, leaves(1200)).setMaterial(leaf));
  const plane = document.createMesh('Terrain').addPrimitive(primitive(document, buffer, ground()).setMaterial(soil));
  // Not a plant: an alpha-masked car interior has the same many-small-pieces shape.
  const interior = document.createMaterial('MI_Interior_Charger').setAlphaMode('MASK').setAlphaCutoff(0.5).setBaseColorTexture(leafTexture);
  const car = document.createMesh('SM_ChargerParked').addPrimitive(primitive(document, buffer, leaves(700)).setMaterial(interior));
  const scene = document.createScene('Scene');
  document.getRoot().setDefaultScene(scene);
  scene.addChild(document.createNode('Ground').setMesh(plane));
  for (let i = 0; i < 30; i++) scene.addChild(document.createNode(`Car_${i}`).setMesh(car).setTranslation([i * 6 - 90, 0, 60]));
  const random = rng(11);
  for (let i = 0; i < 40; i++) {
    const s = 1 + random() * 0.5;
    scene.addChild(document.createNode(`Tree_${i}`).setMesh(tree).setTranslation([(i % 8) * 20 - 70, 0, Math.floor(i / 8) * 20 - 40]).setScale([s, s, s]));
  }
  const io = new NodeIO();
  await mkdir(directory, { recursive: true });
  await io.write(path.join(directory, 'master.gltf'), document);
}

const selection = { minInstancedTriangles: 10_000 };

beforeAll(async () => {
  await MeshoptSimplifier.ready;
  root = await mkdtemp(path.join(os.tmpdir(), 'simforge-geometry-lod-test-'));
  masterDir = path.join(root, 'master');
  await writeMaster(masterDir);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function decodedLeaves(): PrimitiveData {
  const g = leaves(400);
  const f32 = (values: number[]) => Float32Array.from(values);
  return {
    attributes: new Map([
      ['POSITION', { data: f32(g.positions), components: 3, componentType: 5126, normalized: false, type: 'VEC3' as const }],
      ['NORMAL', { data: f32(g.normals), components: 3, componentType: 5126, normalized: false, type: 'VEC3' as const }],
    ]),
    indices: Uint32Array.from(g.indices),
  };
}

describe('geometry-lod mesh operations', () => {
  it('finds leaf cards and keeps a structural piece out of thinning', () => {
    const data = decodedLeaves();
    const components = connectedComponents(data);
    expect(components.count).toBe(400);
    const cards = analyzeCards(data, components, true);
    expect(cards.cardLike).toBe(true);
    expect(analyzeCards(data, components, false).cardLike).toBe(false);
  });

  it('thins cards uniformly and preserves total leaf area', () => {
    const data = decodedLeaves();
    const components = connectedComponents(data);
    const cards = analyzeCards(data, components, true);
    const total = components.area.reduce((sum, area) => sum + area, 0);
    for (const fraction of [0.5, 0.3]) {
      const thin = thinCards(components, cards.thinnable, fraction, 4);
      expect(thin.kept.size).toBeGreaterThanOrEqual(Math.floor(400 * fraction) - 1);
      expect(thin.kept.size).toBeLessThanOrEqual(Math.ceil(400 * fraction) + 1);
      // Scaled area of the kept cards equals the source area.
      expect(thin.keptArea * thin.scale ** 2).toBeCloseTo(total, 6);
    }
    // Capped scale: area preservation gives way to the cap.
    const capped = thinCards(components, cards.thinnable, 0.1, 2);
    expect(capped.scale).toBe(2);
  });

  it('aggregates cards per voxel with their exact total area', () => {
    const prepared = preparePrimitive({ data: decodedLeaves(), material: 0, alphaMasked: true, vegetation: true });
    const { positions, indices } = aggregateCards(prepared, 1.0);
    let area = 0;
    for (let t = 0; t < indices.length; t += 3) {
      const p = (i: number) => [positions[indices[i]! * 3]!, positions[indices[i]! * 3 + 1]!, positions[indices[i]! * 3 + 2]!];
      const [a, b, c] = [p(t), p(t + 1), p(t + 2)];
      const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      area += Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2;
    }
    const source = prepared.components.area.reduce((sum, value) => sum + value, 0);
    expect(area).toBeCloseTo(source, 4);
    expect(indices.length / 3).toBeLessThan(800);
  });
});

// Each build of the fixture takes a few seconds, and CI runs every package's
// suite at once; the default 5 s test timeout is a load test, not a check.
describe('buildGeometryLod', { timeout: 60_000 }, () => {
  let manifest: GeometryLodManifest;
  let files: Record<string, { sha256: string; bytes: number }>;
  const out = () => path.join(root, 'out-a');

  beforeAll(async () => {
    const result = await buildGeometryLod({ masterDir, outputDir: out(), skipKtx2: true, selection });
    manifest = result.manifest;
    files = result.files;
  }, 60_000);

  it('writes a manifest that satisfies the declared schema and names every file by digest', async () => {
    const parsed = parseGeometryLodManifest(JSON.parse(await readFile(path.join(out(), 'manifest.json'), 'utf8')));
    expect(parsed.buildKey).toBe(manifest.buildKey);
    expect(parsed.source.master.sha256).toBe(sha256(await readFile(path.join(masterDir, 'master.gltf'))));
    expect(parsed.buildKey).toBe(geometryLodBuildKey({ masterSha256: parsed.source.master.sha256, bufferSha256s: parsed.source.buffers.map((b) => b.sha256), fingerprint: parsed.builder.fingerprint }));
    for (const member of [parsed.files.lod, parsed.files.lodBuffer, parsed.files.sensor, parsed.files.sensorBuffer, ...parsed.files.images]) {
      expect(sha256(await readFile(path.join(out(), member.path)))).toBe(member.sha256);
      expect(files[member.path]!.sha256).toBe(member.sha256);
    }
  });

  it('rebuilds byte-identically', async () => {
    const again = await buildGeometryLod({ masterDir, outputDir: path.join(root, 'out-b'), skipKtx2: true, selection });
    expect(again.files).toEqual(files);
  });

  it('gives the tree a LOD chain, an impostor and a shadow level; leaves the single terrain alone', () => {
    expect(manifest.meshes.map((mesh) => mesh.name).sort()).toEqual(['SM_ChargerParked', 'SM_TestTree']);
    const tree = manifest.meshes.find((mesh) => mesh.name === 'SM_TestTree')!;
    // The car is simplified, never card-thinned or impostored.
    const car = manifest.meshes.find((mesh) => mesh.name === 'SM_ChargerParked')!;
    expect(car.class).toBe('opaque');
    expect(car.primitives[0]!.cardLike).toBe(false);
    expect(car.impostor).toBeNull();
    expect(car.levels.every((level) => level.method === 'simplify')).toBe(true);
    expect(tree.instances).toBe(40);
    expect(tree.class).toBe('foliage');
    expect(tree.primitives.map((p) => p.cardLike)).toEqual([false, true]);
    expect(tree.levels.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < tree.levels.length; i++) {
      expect(tree.levels[i]!.triangles).toBeLessThan(tree.levels[i - 1]!.triangles);
      expect(tree.levels[i]!.geometricErrorM).toBeGreaterThanOrEqual(tree.levels[i - 1]!.geometricErrorM);
      expect(tree.levels[i]!.switchDistanceM).toBeGreaterThanOrEqual(tree.levels[i - 1]!.switchDistanceM);
    }
    expect(tree.levels[0]!.method).toBe('card-thin');
    expect(tree.impostor?.kind).toBe('cross-cards');
    expect(tree.impostor!.triangles).toBe(8);
    for (const coverage of tree.impostor!.coverage) expect(coverage).toBeGreaterThan(0.02);
    expect(tree.impostor!.switchDistanceM).toBeGreaterThanOrEqual(tree.levels.at(-1)!.switchDistanceM);
    expect(tree.shadow.minLevel).toBe(1);
  });

  it('keeps every LOD primitive layout identical to its master primitive', async () => {
    const master = JSON.parse(await readFile(path.join(masterDir, 'master.gltf'), 'utf8'));
    const lod = JSON.parse(await readFile(path.join(out(), 'lod.gltf'), 'utf8'));
    const tree = manifest.meshes.find((mesh) => mesh.name === 'SM_TestTree')!;
    const source = master.meshes[tree.mesh];
    const layout = (json: typeof master, primitive: { attributes: Record<string, number> }) =>
      Object.fromEntries(Object.entries(primitive.attributes).map(([semantic, index]) => {
        const accessor = json.accessors[index];
        return [semantic, `${accessor.type}:${accessor.componentType}:${accessor.normalized === true}`];
      }));
    for (const level of tree.levels) {
      const mesh = lod.meshes[level.lodMesh];
      expect(mesh.primitives.length).toBe(source.primitives.length);
      mesh.primitives.forEach((primitive: { attributes: Record<string, number>; material?: number }, index: number) => {
        expect(layout(lod, primitive)).toEqual(layout(master, source.primitives[index]));
        expect(primitive.material).toBeUndefined();
      });
    }
    const impostor = lod.meshes[tree.impostor!.lodMesh];
    expect(impostor.primitives[0].material).toBe(tree.impostor!.material);
    expect(lod.materials[tree.impostor!.material].alphaMode).toBe('MASK');
  });

  it('builds a sensor proxy for every master primitive, smaller than the source', () => {
    const entries = manifest.sensor.primitives;
    const master = JSON.parse(readFileSync(path.join(masterDir, 'master.gltf'), 'utf8')) as { meshes: Array<{ name: string }> };
    const index = (name: string) => master.meshes.findIndex((mesh) => mesh.name === name);
    const tree = index('SM_TestTree'), terrain = index('Terrain'), car = index('SM_ChargerParked');
    expect(entries.map((entry) => `${entry.mesh}/${entry.primitive}`).sort()).toEqual([`${tree}/0`, `${tree}/1`, `${terrain}/0`, `${car}/0`].sort());
    expect(entries.find((entry) => entry.mesh === car)!.method).not.toBe('card-aggregate');
    const leavesEntry = entries.find((entry) => entry.mesh === tree && entry.primitive === 1)!;
    expect(leavesEntry.method).toBe('card-aggregate');
    expect(leavesEntry.triangles).toBeLessThan(leavesEntry.sourceTriangles);
    expect(manifest.sensor.triangles.instanced).toBeLessThan(manifest.sensor.triangles.sourceInstanced);
    // The flat terrain collapses under the 2 cm bound.
    const ground = entries.find((entry) => entry.mesh === terrain)!;
    expect(ground.method).toBe('simplify');
    expect(ground.triangles).toBeLessThan(ground.sourceTriangles / 10);
    expect(ground.surfaceErrorM).toBeLessThanOrEqual(0.02);
  });

  it('changes the build key when the builder options change', async () => {
    const other = await buildGeometryLod({ masterDir, outputDir: path.join(root, 'out-c'), skipKtx2: true, selection, sensor: { voxelM: 1 } });
    expect(other.manifest.buildKey).not.toBe(manifest.buildKey);
  });
});

describe('substituteLods', () => {
  it('points each instance at the level its distance allows, and the impostor far away', async () => {
    const master = JSON.parse(await readFile(path.join(masterDir, 'master.gltf'), 'utf8'));
    const lod = JSON.parse(await readFile(path.join(root, 'out-a', 'lod.gltf'), 'utf8'));
    const manifest = parseGeometryLodManifest(JSON.parse(await readFile(path.join(root, 'out-a', 'manifest.json'), 'utf8')));
    const near = substituteLods(master, lod, manifest, { cameras: [[-70, 2, -40]], marginM: 0, fPx: 900, pixelErrorPx: 1, lodPrefix: 'derived/geometry-lod/' });
    expect(near.report.instances).toBe(70);
    expect(near.report.byLevel['L0']).toBeGreaterThan(0);
    expect(near.report.trianglesAfter).toBeLessThanOrEqual(near.report.trianglesBefore);
    const far = substituteLods(master, lod, manifest, { cameras: [[1e6, 0, 0]], marginM: 0, fPx: 900, pixelErrorPx: 1, lodPrefix: 'derived/geometry-lod/' });
    expect(far.report.byLevel['impostor']).toBe(40);
    // The cars (no impostor) take their coarsest level, whatever it is.
    expect(Object.values(far.report.byLevel).reduce((sum, count) => sum + count, 0)).toBe(70);
    // Every retargeted node points at a mesh whose primitives resolve.
    for (const node of far.json.nodes!) {
      if (node.mesh === undefined) continue;
      for (const primitive of far.json.meshes![node.mesh]!.primitives) {
        for (const index of Object.values(primitive.attributes)) expect(far.json.accessors![index]).toBeDefined();
      }
    }
    expect(far.json.buffers!.at(-1)!.uri).toBe('derived/geometry-lod/lod.bin');
    await writeFile(path.join(root, 'far.gltf'), JSON.stringify(far.json));
  });
});

describe('impostor textures from KTX2', { timeout: 60_000 }, () => {
  // Published closures carry only the KTX2 (KHR_texture_basisu) encodings; the
  // bake must decode them. Needs the pinned KTX-Software.
  const ktx = process.env['SIMFORGE_KTX_BIN_DIR'];
  it.skipIf(!ktx)('bakes the impostor from the KTX2 source when the PNG is not in the closure', async () => {
    const dir = path.join(root, 'master-ktx2');
    await cp(masterDir, dir, { recursive: true });
    const json = JSON.parse(await readFile(path.join(dir, 'master.gltf'), 'utf8'));
    const encoded = await encodeKtx2(leafPng, 'color', { ktxBinDir: ktx! });
    const ktxUri = `images/${sha256(encoded.bytes)}.ktx2`;
    await writeFile(path.join(dir, ktxUri), encoded.bytes);
    json.images.push({ uri: ktxUri, mimeType: 'image/ktx2' });
    for (const texture of json.textures) texture.extensions = { KHR_texture_basisu: { source: json.images.length - 1 } };
    await writeFile(path.join(dir, 'master.gltf'), JSON.stringify(json));
    await rm(path.join(dir, 'images', `${sha256(leafPng)}.png`));
    const result = await buildGeometryLod({ masterDir: dir, outputDir: path.join(root, 'out-ktx2'), skipKtx2: true, selection, ktx2: { ktxBinDir: ktx! } });
    const tree = result.manifest.meshes.find((mesh) => mesh.name === 'SM_TestTree')!;
    expect(tree.impostor).not.toBeNull();
    for (const coverage of tree.impostor!.coverage) expect(coverage).toBeGreaterThan(0.02);
  });
});
