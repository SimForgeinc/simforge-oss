import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AnimationClip,
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  NumberKeyframeTrack,
  Object3D,
} from 'three';
import {
  clearExternalCatalogEntries,
  registerExternalCatalogEntry,
  type ExternalModelBinding,
} from '@simforge-oss/asset-catalog';
import { ActorRenderer, disposePropTemplates, fnv1a32, riderClipTimeS, type ActorView } from './actorRenderer';
import {
  disposeExternalModels,
  externalModelDiagnostics,
  onExternalModelChange,
  requestExternalModel,
  setExternalModelLoader,
} from './externalModel';

const HASH = 'b'.repeat(64);
const CATALOG_ID = 'gallery.99999999-2222-3333-4444-555555555555.v1';
const RED: readonly [number, number, number] = [1, 0, 0];

beforeAll(() => {
  if (typeof (globalThis as { document?: unknown }).document !== 'undefined') return;
  (globalThis as { document: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => null }),
  };
});

const RIDER = {
  clip: 'ride',
  clipDurationS: 1,
  metersPerCycle: 4,
  slots: ['rider_top'],
  palettes: [null, { rider_top: RED }],
} as const;

const BINDING: ExternalModelBinding = {
  kind: 'glb',
  url: 'https://example.test/bike.glb',
  contentHash: HASH,
  paint: 'body_paint',
  animated: true,
  rider: RIDER,
};

/**
 * A 2 m bike (`body`) under a 1.7 m tall rider standing far off to the side in
 * its bind pose, as a skinned rider's raw geometry would. `Crank.rotation.z`
 * runs 0 -> 1 over the one-second `ride` clip.
 */
function riddenGltf(options: { rider?: boolean } = {}): { scene: Group; animations: AnimationClip[] } {
  const scene = new Group();
  const bike = new Object3D();
  bike.name = 'bike';
  const body = new Mesh(new BoxGeometry(2, 1, 0.5), new MeshStandardMaterial({ name: 'body_paint' }));
  body.name = 'body';
  body.position.y = 0.5;
  bike.add(body);
  const crank = new Object3D();
  crank.name = 'Crank';
  bike.add(crank);
  scene.add(bike);
  if (options.rider !== false) {
    const rider = new Mesh(new BoxGeometry(0.5, 1.7, 0.5), new MeshStandardMaterial({ name: 'rider_top' }));
    rider.name = 'rider_mesh';
    rider.userData.semanticClass = 'rider';
    rider.position.set(0, 0.85, 5);
    scene.add(rider);
  }
  return {
    scene,
    animations: [new AnimationClip('ride', 1, [new NumberKeyframeTrack('Crank.rotation[z]', [0, 1], [0, 1])])],
  };
}

async function load(gltf = riddenGltf()): Promise<ActorRenderer> {
  registerExternalCatalogEntry({
    id: CATALOG_ID,
    label: 'Ridden bike',
    class: 'vehicle',
    actorClass: 'bicycle',
    description: 'Ridden two-wheeler test double.',
    dims: { l: 2, w: 0.5, h: 1 },
    tags: [],
    defaultParams: {},
    model: BINDING,
  });
  setExternalModelLoader(async () => gltf);
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
    id: 'bike-0',
    catalogId: CATALOG_ID as ActorView['catalogId'],
    catalogIdAuthored: true,
    x: 0,
    y: 0,
    z: 0,
    headingRad: 0,
    dims: { l: 2, w: 0.5, h: 1 },
    ...overrides,
  } as ActorView;
}

function find(renderer: ActorRenderer, actorId: string, name: string): Object3D {
  let found: Object3D | undefined;
  renderer.group.traverse((object) => {
    if (object.name !== `animated-actor.${actorId}`) return;
    object.traverse((child) => {
      if (child.name === name) found = child;
    });
  });
  if (!found) throw new Error(`${actorId} has no ${name}`);
  return found;
}

/** An actor id whose FNV-1a variant lands on the wanted palette index. */
function idForVariant(variant: number): string {
  for (let i = 0; ; i++) {
    const id = `bike-${i}`;
    if (fnv1a32(id) % RIDER.palettes.length === variant) return id;
  }
}

describe('ridden two-wheelers', () => {
  afterEach(() => {
    clearExternalCatalogEntries();
    disposeExternalModels();
    disposePropTemplates();
  });

  it('hashes actor ids exactly as the native service and asset builder do', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
  });

  it('phases the ride clip by distance travelled, not by the clock', async () => {
    const renderer = await load();
    // 6 m on a 4 m cycle = half-way, whatever the clock says.
    renderer.sync([actor({ odometerM: 6, animationTimeS: 0.1, speedMps: 5 })]);
    expect(find(renderer, 'bike-0', 'Crank').rotation.z).toBeCloseTo(0.5, 5);
    renderer.sync([actor({ odometerM: 6, animationTimeS: 7.3, speedMps: 0 })]);
    expect(find(renderer, 'bike-0', 'Crank').rotation.z).toBeCloseTo(0.5, 5);
    // Seeking back replays the earlier pose exactly.
    renderer.sync([actor({ odometerM: 1, animationTimeS: 7.3 })]);
    expect(find(renderer, 'bike-0', 'Crank').rotation.z).toBeCloseTo(0.25, 5);
    expect(riderClipTimeS(RIDER, 13)).toBeCloseTo(0.25, 9);
    renderer.dispose();
  });

  it('refuses to pedal a moving ridden actor that has no odometer', async () => {
    const renderer = await load();
    expect(() => renderer.sync([actor({ speedMps: 4 })])).toThrow(/odometerM/);
    renderer.sync([actor({ speedMps: 0 })]);
    expect(find(renderer, 'bike-0', 'Crank').rotation.z).toBeCloseTo(0, 5);
    renderer.dispose();
  });

  it('fits and places the model by its bike, not by the rider bind pose', async () => {
    const renderer = await load();
    renderer.sync([actor({ odometerM: 0 })]);
    const body = find(renderer, 'bike-0', 'body');
    body.updateWorldMatrix(true, false);
    // The 2 m bike fills the 2 m catalog length and stays centred on the actor.
    const centre = body.getWorldPosition(body.position.clone());
    expect(centre.x).toBeCloseTo(0, 5);
    expect(centre.z).toBeCloseTo(0, 5);
    renderer.dispose();
  });

  it('colours the rider from the actor-id palette variant, per actor', async () => {
    const renderer = await load();
    const authored = idForVariant(0);
    const painted = idForVariant(1);
    renderer.sync([actor({ id: authored, odometerM: 0 }), actor({ id: painted, x: 5, odometerM: 0 })]);
    const colourOf = (id: string) => ((find(renderer, id, 'rider_mesh') as Mesh).material as MeshStandardMaterial).color;
    expect(colourOf(painted).toArray()).toEqual([...RED]);
    expect(colourOf(authored).toArray()).toEqual([1, 1, 1]);
    renderer.dispose();
  });

  it('tints the bike paint slot of an animated clone with the actor colour', async () => {
    const renderer = await load();
    renderer.sync([actor({ odometerM: 0, bodyColor: '#ff0000' })]);
    const paint = ((find(renderer, 'bike-0', 'body') as Mesh).material as MeshStandardMaterial).color;
    expect(paint.r).toBeGreaterThan(0.9);
    expect(paint.g).toBeLessThan(0.05);
    renderer.dispose();
  });

  it('refuses a ridden binding whose model has no rider instead of drawing a ghost bike', async () => {
    await load(riddenGltf({ rider: false }));
    const diagnostic = externalModelDiagnostics()[HASH];
    expect(diagnostic?.state).toBe('failed');
    expect(diagnostic?.downgradeReason).toContain('rider');
  });
});
