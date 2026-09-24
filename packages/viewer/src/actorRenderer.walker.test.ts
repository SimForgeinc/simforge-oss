import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AnimationClip, Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, VectorKeyframeTrack } from 'three';
import { clearExternalCatalogEntries, registerExternalCatalogEntry, type ExternalModelBinding } from '@simforge-oss/asset-catalog';
import { ActorRenderer, disposePropTemplates, type ActorView } from './actorRenderer';
import { disposeExternalModels, onExternalModelChange, requestExternalModel, setExternalModelLoader } from './externalModel';

const HASH = 'c'.repeat(64);
const CATALOG_ID = 'gallery.99999999-3333-3333-4444-555555555555.v1';

beforeAll(() => {
  if (typeof (globalThis as { document?: unknown }).document !== 'undefined') return;
  (globalThis as { document: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => null }),
  };
});

/** Idle lowers the hips 0.1 m below the bind pose; walk lowers them 0.3 m, as the CARLA child clips do. */
const BINDING: ExternalModelBinding = {
  kind: 'glb',
  url: 'https://example.test/walker.glb',
  contentHash: HASH,
  animated: true,
  clips: { idle: 'idle', locomotion: 'walk' },
  groundOffsets: { idle: 0.1, locomotion: 0.3 },
};

function walkerGltf(): { scene: Group; animations: AnimationClip[] } {
  const scene = new Group();
  const hips = new Object3D();
  hips.name = 'hips';
  const body = new Mesh(new BoxGeometry(0.4, 1, 0.3), new MeshStandardMaterial());
  body.name = 'body';
  body.position.y = 0.5; // bind pose: soles at y = 0
  hips.add(body);
  scene.add(hips);
  const drop = (name: string, y: number) => new AnimationClip(name, 1, [new VectorKeyframeTrack('hips.position', [0, 1], [0, y, 0, 0, y, 0])]);
  return { scene, animations: [drop('idle', -0.1), drop('walk', -0.3)] };
}

async function load(): Promise<ActorRenderer> {
  registerExternalCatalogEntry({
    id: CATALOG_ID,
    label: 'Walker',
    class: 'pedestrian',
    description: 'Animated walker test double.',
    dims: { l: 0.3, w: 0.4, h: 1 },
    tags: [],
    defaultParams: {},
    model: BINDING,
  });
  setExternalModelLoader(async () => walkerGltf());
  const ready = new Promise<void>((resolve) => {
    const off = onExternalModelChange((hash) => {
      if (hash !== HASH) return;
      off();
      resolve();
    });
  });
  requestExternalModel(BINDING);
  await ready;
  return new ActorRenderer();
}

function actor(overrides: Partial<ActorView> = {}): ActorView {
  return {
    id: 'walker-0',
    catalogId: CATALOG_ID as ActorView['catalogId'],
    catalogIdAuthored: true,
    x: 0,
    y: 0,
    z: 0,
    headingRad: 0,
    dims: { l: 0.3, w: 0.4, h: 1 },
    ...overrides,
  } as ActorView;
}

function soleHeight(renderer: ActorRenderer): number {
  let body: Object3D | undefined;
  renderer.group.traverse((object) => {
    if (object.name === 'body' && object.parent?.name === 'hips') body = object;
  });
  if (!body) throw new Error('walker body not rendered');
  renderer.group.updateMatrixWorld(true);
  return new Box3().setFromObject(body).min.y;
}

describe('animated walkers', () => {
  afterEach(() => {
    clearExternalCatalogEntries();
    disposeExternalModels();
    disposePropTemplates();
  });

  it('stands the posed soles on the ground with the playing clip\'s measured lift', async () => {
    const renderer = await load();
    renderer.sync([actor({ speedMps: 0, animationTimeS: 0.5 })]);
    expect(soleHeight(renderer)).toBeCloseTo(0, 5);
    renderer.sync([actor({ speedMps: 1.4, animationTimeS: 0.5 })]);
    expect(soleHeight(renderer)).toBeCloseTo(0, 5);
    renderer.sync([actor({ speedMps: 0, animationTimeS: 0.7 })]);
    expect(soleHeight(renderer)).toBeCloseTo(0, 5);
    renderer.dispose();
  });
});
