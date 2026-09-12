import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type Material,
  Quaternion,
  Vector3,
} from 'three';
import {
  clearExternalCatalogEntries,
  registerExternalCatalogEntry,
  type ExternalModelBinding,
} from '@simforge-oss/asset-catalog';
import { ActorRenderer, disposePropTemplates, type ActorView } from './actorRenderer';
import {
  disposeExternalModels,
  onExternalModelChange,
  requestExternalModel,
  setExternalModelLoader,
} from './externalModel';

const CONTENT_HASH = 'b'.repeat(64);
const CATALOG_ID = 'gallery.rigged-car.v1';
/** Wheel centre height in the stand-in model, i.e. its rolling radius. */
const WHEEL_RADIUS = 0.35;
const WHEEL_X = 1.4;
/** Extent of the stand-in model along +X, which the fit scale divides into. */
const MODEL_LENGTH = 4;
const WHEEL_Z = 0.8;

beforeAll(() => {
  if (typeof (globalThis as { document?: unknown }).document !== 'undefined') return;
  (globalThis as { document: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => null }),
  };
});

/**
 * A stand-in for a `vehicles-carla` GLB in the pack's frame: +X forward, -Z
 * left, ground origin, a tintable `body_paint` hull, untintable `glass`, four
 * wheel nodes whose origin is the wheel centre, and one hinged door.
 */
function riggedGltf(): { scene: Group; animations: readonly [] } {
  const scene = new Group();
  const body = new Mesh(new BoxGeometry(4, 1.4, 1.8), new MeshStandardMaterial({ name: 'body_paint' }));
  body.name = 'body';
  body.position.set(0, 0.7 + WHEEL_RADIUS, 0);
  const glass = new Mesh(new BoxGeometry(1, 0.6, 1.7), new MeshStandardMaterial({ name: 'glass' }));
  glass.name = 'glass';
  glass.position.set(0.2, 1.5, 0);
  scene.add(body, glass);
  for (const [name, x, z] of [
    ['wheel_fl', WHEEL_X, -WHEEL_Z],
    ['wheel_fr', WHEEL_X, WHEEL_Z],
    ['wheel_rl', -WHEEL_X, -WHEEL_Z],
    ['wheel_rr', -WHEEL_X, WHEEL_Z],
  ] as const) {
    const node = new Group();
    node.name = name;
    node.position.set(x, WHEEL_RADIUS, z);
    const tyre = new Mesh(
      new CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.2, 8),
      new MeshStandardMaterial({ name: 'tyre' }),
    );
    tyre.rotation.x = Math.PI / 2;
    node.add(tyre);
    scene.add(node);
  }
  const door = new Group();
  door.name = 'door_fl';
  door.position.set(0.6, 0.9, -WHEEL_Z - 0.1);
  const panel = new Mesh(new BoxGeometry(1, 0.9, 0.06), new MeshStandardMaterial({ name: 'body_paint' }));
  // Hinged at the node origin: the panel extends rearward from the hinge.
  panel.position.set(-0.5, 0, 0);
  door.add(panel);
  scene.add(door);
  return { scene, animations: [] };
}

const BINDING: ExternalModelBinding = {
  kind: 'glb',
  url: 'https://example.test/vehicle.glb',
  contentHash: CONTENT_HASH,
  nodes: {
    wheelsFront: ['wheel_fl', 'wheel_fr'],
    wheelsRear: ['wheel_rl', 'wheel_rr'],
    doors: { left: ['door_fl'] },
  },
  paint: 'body_paint',
};

const DIMS = { l: 4.8, w: 1.9, h: 1.5 };

function actor(overrides: Partial<ActorView> = {}): ActorView {
  return {
    id: 'car-1',
    catalogId: CATALOG_ID as ActorView['catalogId'],
    catalogIdAuthored: true,
    x: 0,
    y: 0,
    z: 0,
    headingRad: 0,
    dims: DIMS,
    ...overrides,
  } as ActorView;
}

async function loadedRenderer(): Promise<ActorRenderer> {
  registerExternalCatalogEntry({
    id: CATALOG_ID,
    label: 'Rigged car',
    class: 'vehicle',
    actorClass: 'car',
    description: 'Stand-in rigged vehicle model.',
    dims: DIMS,
    tags: [],
    defaultParams: { color: '#808080' },
    model: BINDING,
  });
  setExternalModelLoader(async () => riggedGltf());
  const ready = new Promise<void>((resolve) => {
    const unsubscribe = onExternalModelChange((hash) => {
      if (hash !== CONTENT_HASH) return;
      unsubscribe();
      resolve();
    });
  });
  requestExternalModel(BINDING);
  await ready;
  return new ActorRenderer();
}

function batches(renderer: ActorRenderer): InstancedMesh[] {
  const found: InstancedMesh[] = [];
  renderer.group.traverse((object) => {
    const mesh = object as InstancedMesh;
    if (mesh.isInstancedMesh && mesh.name.startsWith('actor-batch.') && mesh.count > 0) found.push(mesh);
  });
  return found;
}

/** Every batch carries exactly one material: the name it was merged under. */
function materialName(mesh: InstancedMesh): string {
  // Not an array here by construction: mergeTemplate buckets per material.
  const material = mesh.material as Material;
  return material.name;
}

/** The instanced batch drawing one articulated node, by material name. */
function nodeBatch(renderer: ActorRenderer, articulation: string, material: string): InstancedMesh {
  const match = batches(renderer)
    .find((mesh) => mesh.userData.articulation === articulation && materialName(mesh) === material);
  if (!match) throw new Error(`no ${articulation}/${material} batch`);
  return match;
}

function hullBatch(renderer: ActorRenderer, material: string): InstancedMesh {
  const match = batches(renderer)
    .find((mesh) => mesh.userData.articulation === undefined && materialName(mesh) === material);
  if (!match) throw new Error(`no hull ${material} batch`);
  return match;
}

function instanceMatrix(mesh: InstancedMesh, index = 0): Matrix4 {
  const matrix = new Matrix4();
  mesh.getMatrixAt(index, matrix);
  return matrix;
}

function instanceColor(mesh: InstancedMesh, index = 0): Color {
  const color = new Color();
  mesh.getColorAt(index, color);
  return color;
}

/**
 * The node's rotation alone. Decomposed rather than read off the matrix: the
 * instance matrix carries the model's fit scale, which a direct
 * `setFromRotationMatrix` would fold into the quaternion.
 */
function nodeRotation(mesh: InstancedMesh): Quaternion {
  const rotation = new Quaternion();
  instanceMatrix(mesh).decompose(new Vector3(), rotation, new Vector3());
  return rotation;
}

/** Steer angle the node was posed with: the yaw it applies to +X forward. */
function steerOf(rotation: Quaternion): number {
  const forward = new Vector3(1, 0, 0).applyQuaternion(rotation);
  return Math.atan2(-forward.z, forward.x);
}

/** Where the top of a wheel sits in world space, which is what rolling moves. */
function wheelTop(mesh: InstancedMesh): Vector3 {
  return new Vector3(0, WHEEL_RADIUS, 0).applyMatrix4(instanceMatrix(mesh));
}

describe('ActorRenderer rigged vehicle models', () => {
  afterEach(() => {
    clearExternalCatalogEntries();
    disposeExternalModels();
    disposePropTemplates();
  });

  it('rolls wheels forward at the recorded rate, reproducibly under scrubbing', async () => {
    const renderer = await loadedRenderer();
    // A quarter turn of the front left wheel: its top point must have moved
    // forward (+X) relative to the wheel centre, not backward.
    const quarter = Math.PI / 2;
    renderer.sync([actor({ wheelAngularSpeedRadps: quarter, animationTimeS: 1 })]);
    const rolled = wheelTop(nodeBatch(renderer, 'wheel-front', 'tyre'));
    renderer.sync([actor({ wheelAngularSpeedRadps: quarter, animationTimeS: 0 })]);
    const still = wheelTop(nodeBatch(renderer, 'wheel-front', 'tyre'));
    renderer.sync([actor({ wheelAngularSpeedRadps: quarter, animationTimeS: 1 })]);
    const replayed = wheelTop(nodeBatch(renderer, 'wheel-front', 'tyre'));

    expect(rolled.x).toBeGreaterThan(still.x + 0.1);
    expect(replayed.toArray()).toEqual(rolled.toArray());
    renderer.dispose();
  });

  it('rolls from road speed and the wheel radius when no wheel channel was recorded', async () => {
    const renderer = await loadedRenderer();
    // The rolling radius is the wheel node's height, scaled by the fit the
    // renderer applies; one second at that x a quarter turn rolls a quarter turn.
    const radius = WHEEL_RADIUS * (DIMS.l / MODEL_LENGTH);
    renderer.sync([actor({ speedMps: radius * (Math.PI / 2), animationTimeS: 1 })]);
    const fromSpeed = wheelTop(nodeBatch(renderer, 'wheel-rear', 'tyre'));
    renderer.sync([actor({ wheelAngularSpeedRadps: Math.PI / 2, animationTimeS: 1 })]);
    const fromChannel = wheelTop(nodeBatch(renderer, 'wheel-rear', 'tyre'));

    for (let axis = 0; axis < 3; axis++) {
      expect(fromSpeed.getComponent(axis)).toBeCloseTo(fromChannel.getComponent(axis), 5);
    }
    renderer.dispose();
  });

  it('steers the front axle only', async () => {
    const renderer = await loadedRenderer();
    renderer.sync([actor({ steerRad: 0.4 })]);
    const front = nodeRotation(nodeBatch(renderer, 'wheel-front', 'tyre'));
    const rear = nodeRotation(nodeBatch(renderer, 'wheel-rear', 'tyre'));

    expect(steerOf(front)).toBeCloseTo(0.4, 6);
    expect(steerOf(rear)).toBeCloseTo(0, 6);
    renderer.dispose();
  });

  it('clamps a steer angle no road wheel reaches', async () => {
    const renderer = await loadedRenderer();
    renderer.sync([actor({ steerRad: 3 })]);
    const steer = steerOf(nodeRotation(nodeBatch(renderer, 'wheel-front', 'tyre')));

    expect(steer).toBeCloseTo(0.7, 6);
    renderer.dispose();
  });

  it('applies the body colour to the paint slot and leaves authored materials alone', async () => {
    const renderer = await loadedRenderer();
    renderer.sync([actor({ bodyColor: '#ff0000' })]);

    const paint = instanceColor(hullBatch(renderer, 'body_paint'));
    const glass = instanceColor(hullBatch(renderer, 'glass'));
    expect(paint.r).toBeGreaterThan(paint.b + 0.5);
    expect(glass.getHex()).toBe(0xffffff);
    // The rigged door is painted metal: it takes the same tint as the hull.
    expect(instanceColor(nodeBatch(renderer, 'left', 'body_paint')).getHex()).toBe(paint.getHex());
    renderer.dispose();
  });

  it('swings the rigged door outward instead of drawing the proxy panel', async () => {
    const renderer = await loadedRenderer();
    renderer.sync([actor({ doors: { left: 'closed' } })]);
    const closed = new Vector3(-0.5, 0, 0).applyMatrix4(instanceMatrix(nodeBatch(renderer, 'left', 'body_paint')));
    renderer.sync([actor({ doors: { left: 'open' } })]);
    const open = new Vector3(-0.5, 0, 0).applyMatrix4(instanceMatrix(nodeBatch(renderer, 'left', 'body_paint')));

    // Left is -Z in the model frame: an opening door's free end moves outward.
    expect(open.z).toBeLessThan(closed.z - 0.2);
    const proxyPanels = batches(renderer).filter((mesh) => mesh.userData.articulation === 'doors.left');
    expect(proxyPanels).toEqual([]);
    renderer.dispose();
  });

  it('fits an authored model uniformly rather than stretching it onto the catalog box', async () => {
    const renderer = await loadedRenderer();
    renderer.sync([actor()]);
    const scale = new Vector3();
    instanceMatrix(hullBatch(renderer, 'body_paint')).decompose(new Vector3(), new Quaternion(), scale);

    expect(scale.y).toBeCloseTo(scale.x, 6);
    expect(scale.z).toBeCloseTo(scale.x, 6);
    // Longest authored axis is length: the 4.8 m box over the 4 m model.
    expect(scale.x).toBeCloseTo(DIMS.l / MODEL_LENGTH, 6);
    renderer.dispose();
  });

  it('draws one batch per material regardless of how many actors are placed', async () => {
    const renderer = await loadedRenderer();
    renderer.sync([actor()]);
    const single = batches(renderer).length;
    renderer.sync(Array.from({ length: 50 }, (_, index) => actor({ id: `car-${index}`, x: index * 6 })));
    const fifty = batches(renderer);

    expect(fifty.length).toBe(single);
    for (const mesh of fifty) expect(mesh.count).toBe(50);
    renderer.dispose();
  });
});
