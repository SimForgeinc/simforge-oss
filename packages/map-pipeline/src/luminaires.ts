/**
 * Street luminaire derivative (`derived/luminaires/manifest.json`, schema
 * `simforge.map-luminaires.v1`).
 *
 * The native renderer lights a night scene with the street luminaires the
 * caller hands it (`lighting.night.fixtures`: a nearest-camera pool of real
 * point lights). Nothing on the platform path listed them, so every night
 * render had dark lamp heads and no light pools. The browser viewer finds the
 * same fixtures at runtime by node name (`packages/viewer` luminaire-lighting:
 * `isLuminaireObjectName`, size gates, lamp-head anchor). That is map-only
 * work, so it happens once here, at ingest, with the same rule.
 *
 * A fixture is a node whose name (camel-case boundaries split) carries a
 * street-light token, with no accepted ancestor, whose subtree's world box is
 * 2..20 m tall and at most 12 m across. The bulb sits at the centre of a
 * named lamp-head descendant (`Luminaire_Head01`), else 0.25 m under the top
 * of the fixture's box. Positions are in the master's glTF frame (metres,
 * y up), which is the render scene frame.
 *
 * It is a pure function of `master.gltf` (node names, transforms and the
 * POSITION accessor bounds), so it is derived at ingest for new maps and
 * backfilled as a derivative set for published versions (no new version).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, sha256 } from './closure.js';
import {
  isLuminaireName, LUMINAIRE_BULB_INSET_M as BULB_INSET_M, LUMINAIRE_HEAD_NAME, LUMINAIRE_MAX_HEIGHT_M as MAX_FIXTURE_HEIGHT_M,
  LUMINAIRE_MAX_SPAN_M as MAX_FIXTURE_SPAN_M, LUMINAIRE_MAX_STANDALONE_HEAD_SPAN_M as MAX_STANDALONE_HEAD_SPAN_M,
  LUMINAIRE_MIN_HEIGHT_M as MIN_FIXTURE_HEIGHT_M, LUMINAIRE_NAME, splitCamelBoundaries as splitCamel,
} from '@simforge-oss/maps/luminaires';

export { isLuminaireName };

export const LUMINAIRES_DIR = 'derived/luminaires';
export const LUMINAIRES_SCHEMA = 'simforge.map-luminaires.v1';
/** Bumped whenever the classification or the placement changes. */
export const LUMINAIRES_REVISION = 1;


export interface LuminaireFixture {
  /** Node index path from the scene root, `n<i>/n<j>/...`: stable for a master. */
  readonly sourceId: string;
  readonly sourceName: string;
  /** Bulb position, glTF frame, metres. */
  readonly position: readonly [number, number, number];
  /** Yaw of the fixture node about +y, radians. */
  readonly headingRad: number;
  /**
   * `head`: the named lamp head of a street-light fixture; `top`: the
   * fixture box's top centre; `lamp-head`: a lamp head exported on its own.
   */
  readonly rule: 'head' | 'top' | 'lamp-head';
}

export interface LuminairesManifest {
  readonly schema: typeof LUMINAIRES_SCHEMA;
  readonly builder: { readonly revision: number; readonly fingerprint: string };
  readonly buildKey: string;
  readonly source: { readonly master: { readonly path: 'master.gltf'; readonly sha256: string } };
  readonly fixtures: readonly LuminaireFixture[];
  /** Named candidates refused by the size gates (not street furniture). */
  readonly rejected: number;
}

type Vec3 = [number, number, number];
type Mat4 = number[];
interface GltfNode {
  readonly name?: string;
  readonly children?: readonly number[];
  readonly mesh?: number;
  readonly matrix?: readonly number[];
  readonly translation?: readonly number[];
  readonly rotation?: readonly number[];
  readonly scale?: readonly number[];
}
interface Gltf {
  readonly scene?: number;
  readonly scenes?: readonly { readonly nodes?: readonly number[] }[];
  readonly nodes?: readonly GltfNode[];
  readonly meshes?: readonly { readonly primitives: readonly { readonly attributes: { readonly POSITION?: number } }[] }[];
  readonly accessors?: readonly { readonly min?: readonly number[]; readonly max?: readonly number[] }[];
}

function compose(node: GltfNode): Mat4 {
  if (node.matrix) return [...node.matrix];
  const [tx, ty, tz] = (node.translation ?? [0, 0, 0]) as number[];
  const [x, y, z, w] = (node.rotation ?? [0, 0, 0, 1]) as number[];
  const [sx, sy, sz] = (node.scale ?? [1, 1, 1]) as number[];
  // Column-major, as glTF stores matrices.
  return [
    (1 - 2 * (y! * y! + z! * z!)) * sx!, 2 * (x! * y! + z! * w!) * sx!, 2 * (x! * z! - y! * w!) * sx!, 0,
    2 * (x! * y! - z! * w!) * sy!, (1 - 2 * (x! * x! + z! * z!)) * sy!, 2 * (y! * z! + x! * w!) * sy!, 0,
    2 * (x! * z! + y! * w!) * sz!, 2 * (y! * z! - x! * w!) * sz!, (1 - 2 * (x! * x! + y! * y!)) * sz!, 0,
    tx!, ty!, tz!, 1,
  ];
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += a[k * 4 + r]! * b[c * 4 + k]!;
    out[c * 4 + r] = sum;
  }
  return out;
}

const apply = (m: Mat4, p: Vec3): Vec3 => [
  m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
  m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
  m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
];

interface Box { min: Vec3; max: Vec3 }
const emptyBox = (): Box => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
const isEmpty = (box: Box): boolean => !(box.max[0] >= box.min[0]);
function grow(box: Box, p: Vec3): void {
  for (let i = 0; i < 3; i++) { box.min[i] = Math.min(box.min[i]!, p[i]!); box.max[i] = Math.max(box.max[i]!, p[i]!); }
}

/** The fixtures of a master (its parsed JSON). */
export function classifyLuminaires(gltf: Gltf): { fixtures: LuminaireFixture[]; rejected: number } {
  const nodes = gltf.nodes ?? [];
  const world = new Map<number, Mat4>();
  const parentOf = new Map<number, number>();
  const pathOf = new Map<number, string>();
  const roots = gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? [];
  const identity: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const stack: [number, Mat4, string][] = roots.map((root) => [root, identity, ''] as [number, Mat4, string]);
  const order: number[] = [];
  while (stack.length > 0) {
    const [index, parent, prefix] = stack.pop()!;
    const node = nodes[index];
    if (!node || world.has(index)) continue;
    const matrix = multiply(parent, compose(node));
    const id = `${prefix}n${index}`;
    world.set(index, matrix);
    pathOf.set(index, id);
    order.push(index);
    for (const child of node.children ?? []) {
      parentOf.set(child, index);
      stack.push([child, matrix, `${id}/`]);
    }
  }
  // Subtree world boxes from the POSITION accessor bounds.
  const meshBox = (node: GltfNode, matrix: Mat4, box: Box): void => {
    if (node.mesh === undefined) return;
    for (const primitive of gltf.meshes?.[node.mesh]?.primitives ?? []) {
      const accessor = primitive.attributes.POSITION === undefined ? undefined : gltf.accessors?.[primitive.attributes.POSITION];
      if (!accessor?.min || !accessor.max) continue;
      const [a, b] = [accessor.min, accessor.max] as [number[], number[]];
      for (const x of [a[0]!, b[0]!]) for (const y of [a[1]!, b[1]!]) for (const z of [a[2]!, b[2]!]) grow(box, apply(matrix, [x, y, z]));
    }
  };
  const subtree = (index: number, visit: (index: number) => void): void => {
    const stackInner = [index];
    while (stackInner.length > 0) {
      const current = stackInner.pop()!;
      visit(current);
      for (const child of nodes[current]?.children ?? []) if (world.has(child)) stackInner.push(child);
    }
  };
  const boxOf = (index: number): Box => {
    const box = emptyBox();
    subtree(index, (current) => meshBox(nodes[current]!, world.get(current)!, box));
    return box;
  };

  const accepted = new Set<number>();
  const fixtures: LuminaireFixture[] = [];
  let rejected = 0;
  for (const index of [...order].sort((a, b) => pathOf.get(a)!.split('/').length - pathOf.get(b)!.split('/').length || a - b)) {
    const name = nodes[index]!.name;
    if (!name || !isLuminaireName(name)) continue;
    // Lamp heads are judged as heads below (they are small by nature).
    if (LUMINAIRE_HEAD_NAME.test(splitCamel(name))) continue;
    let covered = false;
    for (let parent = parentOf.get(index); parent !== undefined; parent = parentOf.get(parent)) {
      if (accepted.has(parent)) { covered = true; break; }
    }
    if (covered) continue;
    const box = boxOf(index);
    if (isEmpty(box)) continue;
    const size = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
    if (size[1]! < MIN_FIXTURE_HEIGHT_M || size[1]! > MAX_FIXTURE_HEIGHT_M || size[0]! > MAX_FIXTURE_SPAN_M || size[2]! > MAX_FIXTURE_SPAN_M) {
      rejected++;
      continue;
    }
    accepted.add(index);
    let head: Box | undefined;
    subtree(index, (current) => {
      if (head || current === index) return;
      const headName = nodes[current]!.name;
      if (!headName || !LUMINAIRE_HEAD_NAME.test(splitCamel(headName))) return;
      const headBox = boxOf(current);
      if (!isEmpty(headBox)) head = headBox;
    });
    const position: Vec3 = head
      ? [(head.min[0] + head.max[0]) / 2, (head.min[1] + head.max[1]) / 2, (head.min[2] + head.max[2]) / 2]
      : [(box.min[0] + box.max[0]) / 2, box.max[1] - BULB_INSET_M, (box.min[2] + box.max[2]) / 2];
    const m = world.get(index)!;
    const round = (value: number) => Math.round(value * 1000) / 1000 + 0;
    fixtures.push({
      sourceId: pathOf.get(index)!,
      sourceName: name,
      position: [round(position[0]), round(position[1]), round(position[2])],
      // Yaw of the node's local +x about +y.
      headingRad: round(Math.atan2(-m[2]!, m[0]!)),
      rule: head ? 'head' : 'top',
    });
  }
  // Lamp heads exported on their own (no street-light fixture around them):
  // the head is the luminaire.
  const inAccepted = (index: number): boolean => {
    for (let current: number | undefined = index; current !== undefined; current = parentOf.get(current)) {
      if (accepted.has(current)) return true;
    }
    return false;
  };
  const heads = new Set<number>();
  for (const index of order) {
    const name = nodes[index]!.name;
    if (!name || !LUMINAIRE_HEAD_NAME.test(splitCamel(name)) || inAccepted(index)) continue;
    let nested = false;
    for (let parent = parentOf.get(index); parent !== undefined; parent = parentOf.get(parent)) {
      if (heads.has(parent)) { nested = true; break; }
    }
    if (nested) continue;
    const box = boxOf(index);
    if (isEmpty(box)) continue;
    if (Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) > MAX_STANDALONE_HEAD_SPAN_M) {
      rejected++;
      continue;
    }
    heads.add(index);
    const m = world.get(index)!;
    const round = (value: number) => Math.round(value * 1000) / 1000 + 0;
    fixtures.push({
      sourceId: pathOf.get(index)!,
      sourceName: name,
      position: [round((box.min[0] + box.max[0]) / 2), round((box.min[1] + box.max[1]) / 2), round((box.min[2] + box.max[2]) / 2)],
      headingRad: round(Math.atan2(-m[2]!, m[0]!)),
      rule: 'lamp-head',
    });
  }
  fixtures.sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
  return { fixtures, rejected };
}

export function luminairesFingerprint(): string {
  return sha256(canonicalJson({
    revision: LUMINAIRES_REVISION,
    name: LUMINAIRE_NAME.source, head: LUMINAIRE_HEAD_NAME.source,
    gates: [MIN_FIXTURE_HEIGHT_M, MAX_FIXTURE_HEIGHT_M, MAX_FIXTURE_SPAN_M, BULB_INSET_M, MAX_STANDALONE_HEAD_SPAN_M],
  }));
}

export function luminairesBuildKey(input: { masterSha256: string; fingerprint: string }): string {
  return sha256(canonicalJson({ schema: LUMINAIRES_SCHEMA, master: input.masterSha256, fingerprint: input.fingerprint }));
}

/** The manifest for a master (its bytes). */
export function luminairesManifest(masterBytes: Uint8Array): LuminairesManifest {
  const masterSha256 = sha256(masterBytes);
  const fingerprint = luminairesFingerprint();
  return {
    schema: LUMINAIRES_SCHEMA,
    builder: { revision: LUMINAIRES_REVISION, fingerprint },
    buildKey: luminairesBuildKey({ masterSha256, fingerprint }),
    source: { master: { path: 'master.gltf', sha256: masterSha256 } },
    ...classifyLuminaires(JSON.parse(Buffer.from(masterBytes).toString('utf8')) as Gltf),
  };
}

/**
 * Write `manifest.json` for `<masterDir>/master.gltf` into `outputDir`. A
 * master without street lights still gets a manifest (no fixtures), so a
 * night render can tell "none on this map" from "never derived".
 */
export async function buildLuminaires(options: { masterDir: string; outputDir: string }): Promise<LuminairesManifest> {
  const manifest = luminairesManifest(await readFile(path.join(options.masterDir, 'master.gltf')));
  await mkdir(options.outputDir, { recursive: true });
  await writeFile(path.join(options.outputDir, 'manifest.json'), `${canonicalJson(manifest)}\n`);
  return manifest;
}

/** Validate a manifest read back (backfill, renderer planning). */
export function parseLuminairesManifest(value: unknown): LuminairesManifest {
  const m = value as Partial<LuminairesManifest> | null;
  if (!m || m.schema !== LUMINAIRES_SCHEMA) throw new Error(`luminaires manifest: schema ${String(m?.schema)} (${LUMINAIRES_SCHEMA})`);
  if (typeof m.buildKey !== 'string' || !/^[0-9a-f]{64}$/.test(m.buildKey)) throw new Error('luminaires manifest: buildKey');
  if (m.source?.master?.path !== 'master.gltf' || typeof m.source.master.sha256 !== 'string') throw new Error('luminaires manifest: source.master');
  if (!Array.isArray(m.fixtures) || !m.fixtures.every((f) => typeof f.sourceId === 'string' && Array.isArray(f.position) && f.position.length === 3 && f.position.every(Number.isFinite))) {
    throw new Error('luminaires manifest: fixtures');
  }
  if (!m.builder || typeof m.builder.revision !== 'number' || typeof m.builder.fingerprint !== 'string') throw new Error('luminaires manifest: builder');
  return m as LuminairesManifest;
}
