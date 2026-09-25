import type { ExternalModelBinding } from '@simforge-oss/asset-catalog';
import {
  AnimationClip,
  Box3,
  Group,
  Material,
  Mesh,
  Texture,
  Vector3,
  type BufferGeometry,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export type ExternalModelState = 'idle' | 'loading' | 'ready' | 'failed';

interface ExternalModelAsset {
  readonly scene: Group;
  readonly animations: readonly AnimationClip[];
}

type ExternalModelLoader = (url: string) => Promise<ExternalModelAsset>;

interface LoadedExternalModel {
  state: 'ready';
  scene: Group;
  clips: readonly AnimationClip[];
  extents: Readonly<{ l: number; w: number; h: number }>;
}

interface PendingExternalModel {
  readonly url: string;
  readonly downgradeReason: string;
  state: 'loading' | 'failed';
}

type ExternalModelRecord = LoadedExternalModel | PendingExternalModel;

type ExternalGlbModelBinding = Extract<ExternalModelBinding, { readonly kind: 'glb' }>;

interface QueuedLoad {
  binding: ExternalGlbModelBinding;
  generation: number;
}

const MAX_CONCURRENT_LOADS = 4;
const records = new Map<string, ExternalModelRecord>();
const listeners = new Set<(contentHash: string) => void>();
const queue: QueuedLoad[] = [];
let activeLoads = 0;
let generation = 0;

const defaultLoader: ExternalModelLoader = async (url) => new GLTFLoader().loadAsync(url);
let loadExternalModel: ExternalModelLoader = defaultLoader;

/**
 * The repository's model packs (`/catalog/<pack>/models/*.glb`, the CARLA
 * vehicles and pedestrians) are not served by path: their bytes live in the
 * content-addressed actor store, so a pack binding is fetched by its
 * `contentHash` from `<origin>/actor-assets/blobs/sha256/<aa>/<hash>`. The URL
 * names the exact bytes the binding declares, so a cached copy can never be a
 * different model. The default origin is this page's own: hosts rewrite
 * `/actor-assets/*` to the public asset CDN (oss/studio/next.config.ts).
 * Other bindings (the asset gallery's resolved downloads) keep their URL.
 */
const PACK_MODEL_URL = /^\/catalog\/[^/]+\/models\//u;
let actorAssetsOrigin = '';

export function setExternalModelAssetOrigin(origin: string): void {
  actorAssetsOrigin = origin.replace(/\/+$/u, '').replace(/\/actor-assets$/u, '');
}

export function externalModelUrl(binding: Pick<ExternalGlbModelBinding, 'url' | 'contentHash'>): string {
  if (!PACK_MODEL_URL.test(binding.url)) return binding.url;
  const hash = binding.contentHash;
  if (!/^[0-9a-f]{64}$/u.test(hash)) throw new Error(`pack model ${binding.url} has no sha256 contentHash`);
  return `${actorAssetsOrigin}/actor-assets/blobs/sha256/${hash.slice(0, 2)}/${hash}`;
}

export function externalModelState(contentHash: string): ExternalModelState {
  return records.get(contentHash)?.state ?? 'idle';
}

export function requestExternalModel(binding: ExternalModelBinding): void {
  if (binding.kind === 'proxy') return;
  if (records.has(binding.contentHash)) return;
  records.set(binding.contentHash, {
    state: 'loading',
    url: externalModelUrl(binding),
    downgradeReason: `actor-model-loading: ${binding.url}; displaying a procedural placeholder until the GLB is ready`,
  });
  queue.push({ binding, generation });
  pumpQueue();
}

export function externalModelScene(contentHash: string): Group | null {
  const record = records.get(contentHash);
  return record?.state === 'ready' ? record.scene : null;
}

/** Asset-load degradation is visible to the same diagnostics surface as map downgrades. */
export function externalModelDiagnostics(): Readonly<Record<string, { state: ExternalModelState; url: string; downgradeReason: string }>> {
  return Object.fromEntries([...records].flatMap(([hash, record]) =>
    record.state === 'ready' ? [] : [[hash, {
      state: record.state, url: record.url, downgradeReason: record.downgradeReason,
    }]],
  ));
}

export function externalModelClips(contentHash: string): readonly AnimationClip[] {
  const record = records.get(contentHash);
  return record?.state === 'ready' ? record.clips : [];
}

export function onExternalModelChange(listener: (contentHash: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function disposeExternalModels(): void {
  generation++;
  queue.length = 0;
  for (const record of records.values()) {
    if (record.state === 'ready') disposeScene(record.scene);
  }
  records.clear();
}

export function setExternalModelLoader(load: ExternalModelLoader): void {
  loadExternalModel = load;
}

function pumpQueue(): void {
  while (activeLoads < MAX_CONCURRENT_LOADS) {
    const queued = queue.shift();
    if (!queued) return;
    activeLoads++;
    void performLoad(queued).finally(() => {
      activeLoads--;
      pumpQueue();
    });
  }
}

async function performLoad({ binding, generation: loadGeneration }: QueuedLoad): Promise<void> {
  let gltf: ExternalModelAsset;
  try {
    gltf = await Promise.resolve().then(() => loadExternalModel(externalModelUrl(binding)));
  } catch (error) {
    if (loadGeneration !== generation) return;
    reportModelFailure(binding, error);
    emitChange(binding.contentHash);
    return;
  }

  if (loadGeneration !== generation) {
    disposeScene(gltf.scene);
    return;
  }

  try {
    assertRider(binding, gltf.scene, gltf.animations);
    const extents = normaliseScene(gltf.scene, binding.scale ?? 1, binding.yawRad ?? 0, binding.rider !== undefined);
    records.set(binding.contentHash, {
      state: 'ready',
      scene: gltf.scene,
      clips: [...gltf.animations],
      extents,
    });
  } catch (error) {
    disposeScene(gltf.scene);
    reportModelFailure(binding, error);
  }
  emitChange(binding.contentHash);
}

function reportModelFailure(binding: ExternalGlbModelBinding, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  const url = externalModelUrl(binding);
  const downgradeReason = `actor-model-load-failed: ${binding.url} (${url}): ${reason}; displaying a procedural placeholder instead of the authored GLB`;
  records.set(binding.contentHash, { state: 'failed', url, downgradeReason });
  console.error('[actor-model]', downgradeReason);
}

function normaliseScene(
  scene: Group,
  scale: number,
  yawRad: number,
  ridden = false,
): Readonly<{ l: number; w: number; h: number }> {
  scene.scale.multiplyScalar(scale);
  scene.rotateY(yawRad);
  scene.updateMatrixWorld(true);

  // A ridden two-wheeler is placed by its bike; its rider's skinned bind pose
  // is not where the rider is drawn.
  const measure = (): Box3 => (ridden ? modelBoundsWithoutRider(scene) : new Box3().setFromObject(scene));
  const bounds = measure();
  if (bounds.isEmpty()) throw new Error('External model has no measurable geometry');
  const centre = bounds.getCenter(new Vector3());
  scene.position.x -= centre.x;
  scene.position.y -= bounds.min.y;
  scene.position.z -= centre.z;
  scene.updateMatrixWorld(true);

  const size = measure().getSize(new Vector3());
  return { l: size.x, w: size.z, h: size.y };
}

/**
 * A binding that declares a rider must deliver it: the tagged rider subtree
 * and the clip that poses it. Anything less would draw a riderless bike.
 */
function assertRider(binding: ExternalGlbModelBinding, scene: Group, clips: readonly AnimationClip[]): void {
  if (!binding.rider) return;
  // GLTFLoader keeps node extras on the node's object; a multi-primitive
  // node becomes a Group whose child meshes carry no extras of their own.
  let riders = 0;
  scene.traverse((object) => {
    if ((object as Mesh).isMesh && isRiderSubtree(object)) riders++;
  });
  if (riders === 0) throw new Error('ridden model has no mesh tagged semanticClass "rider"');
  if (!clips.some((clip) => clip.name === binding.rider!.clip)) {
    throw new Error(`ridden model has no "${binding.rider.clip}" clip`);
  }
}

export function isRiderSubtree(object: Object3D): boolean {
  for (let node: Object3D | null = object; node; node = node.parent) {
    if (node.userData?.semanticClass === 'rider') return true;
  }
  return false;
}

/** Bounds of a model's vehicle geometry, ignoring its rider. */
export function modelBoundsWithoutRider(scene: Object3D): Box3 {
  scene.updateMatrixWorld(true);
  const bounds = new Box3();
  scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh || isRiderSubtree(mesh)) return;
    mesh.geometry.computeBoundingBox();
    bounds.union(mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld));
  });
  if (bounds.isEmpty()) throw new Error('ridden model has no vehicle geometry outside its rider');
  return bounds;
}



function emitChange(contentHash: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(contentHash);
    } catch {
      // One host listener must not prevent other renderers from observing completion.
    }
  }
}

function disposeScene(scene: Group): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof Texture) textures.add(value);
      }
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}
