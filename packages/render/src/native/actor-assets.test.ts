import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultCatalogIdForActorKind } from '@simforge-oss/playback';

import {
  assertActorAnimationsBound,
  assertActorAppearanceGrounded,
  ensureActorAssets,
  parseActorClosureCatalog,
  type ActorClosureModel,
} from './actor-assets.js';
import { NATIVE_KIND_DEFAULT_CATALOG_IDS, nativeActorCatalogId, nativeActorClass, type NativeSceneState } from './lowering.js';

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** A file:// registry serving `members` under content-addressed blobs and the closure document as an input file. */
async function registry(members: Record<string, Buffer>) {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.actor-assets-test-'));
  roots.push(root);
  const closureMembers: Record<string, { bytes: number; sha256: string }> = {};
  for (const [memberPath, bytes] of Object.entries(members).sort(([left], [right]) => left.localeCompare(right))) {
    const memberDigest = digest(bytes);
    const blob = path.join(root, 'registry', 'blobs', 'sha256', memberDigest.slice(0, 2), memberDigest);
    await fs.mkdir(path.dirname(blob), { recursive: true });
    await fs.writeFile(blob, bytes);
    closureMembers[memberPath] = { bytes: bytes.byteLength, sha256: memberDigest };
  }
  const closureBytes = Buffer.from(JSON.stringify({ members: closureMembers, schema: 'simforge.actor-assets-closure/v1' }));
  const closurePath = path.join(root, 'inputs', 'closure.json');
  await fs.mkdir(path.dirname(closurePath), { recursive: true });
  await fs.writeFile(closurePath, closureBytes);
  return {
    root,
    baseUrl: `file://${root}/registry`,
    cacheDir: path.join(root, 'cache'),
    destination: path.join(root, 'workspace', 'actor-assets'),
    closure: { path: closurePath, sha256: digest(closureBytes), sizeBytes: closureBytes.byteLength },
  };
}

const sedanGlb = Buffer.from('glb:vehicle.sedan');
const catalog = Buffer.from(JSON.stringify({
  'vehicle.sedan': { model: { glbPath: 'models/vehicle.sedan/model.glb' }, tintable: true, scaleToDims: false },
}));


describe('ensureActorAssets', () => {
  it('materializes exactly the closure members and binds catalog ids to verified models', async () => {
    const fixture = await registry({ 'catalog-models.json': catalog, 'models/vehicle.sedan/model.glb': sedanGlb });
    const assets = await ensureActorAssets(fixture);
    expect(assets.digest).toBe(fixture.closure.sha256);
    expect(assets.directory).toBe(fixture.destination);
    expect(await fs.readFile(path.join(assets.directory, 'models/vehicle.sedan/model.glb'))).toEqual(sedanGlb);
    expect([...assets.models.keys()]).toEqual(['vehicle.sedan']);
    expect((await fs.readdir(assets.directory)).sort()).toEqual(['catalog-models.json', 'models']);
  });

  it('materializes verified model bytes when installed-file hard links are forbidden', async () => {
    const fixture = await registry({ 'catalog-models.json': catalog, 'models/vehicle.sedan/model.glb': sedanGlb });
    vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('hard link not permitted'), { code: 'EPERM' }));

    const assets = await ensureActorAssets(fixture);
    const model = assets.models.get('vehicle.sedan')!;
    expect(await fs.readFile(path.join(assets.directory, model.glbPath))).toEqual(sedanGlb);
  });

  it('refuses a closure input whose bytes are not the declared identity', async () => {
    const fixture = await registry({ 'catalog-models.json': catalog, 'models/vehicle.sedan/model.glb': sedanGlb });
    await expect(ensureActorAssets({ ...fixture, closure: { ...fixture.closure, sha256: 'f'.repeat(64) } }))
      .rejects.toThrow(/does not match its declared identity/);
  });

  it('re-verifies cached member bytes on every job instead of trusting the cache', async () => {
    const fixture = await registry({ 'catalog-models.json': catalog, 'models/vehicle.sedan/model.glb': sedanGlb });
    const first = await ensureActorAssets(fixture);
    const cached = path.join(fixture.cacheDir, 'blobs', 'sha256', digest(sedanGlb).slice(0, 2), digest(sedanGlb));
    await fs.rm(cached, { force: true });
    await fs.writeFile(cached, 'tampered');
    const second = await ensureActorAssets({ ...fixture, destination: `${fixture.destination}-2` });
    expect(await fs.readFile(path.join(second.directory, 'models/vehicle.sedan/model.glb'))).toEqual(sedanGlb);
    expect(await fs.readFile(path.join(first.directory, 'models/vehicle.sedan/model.glb'))).toEqual(sedanGlb);
  });

  it('fails when the origin cannot serve a member with the declared bytes', async () => {
    const fixture = await registry({ 'catalog-models.json': catalog, 'models/vehicle.sedan/model.glb': sedanGlb });
    const blob = path.join(fixture.root, 'registry', 'blobs', 'sha256', digest(sedanGlb).slice(0, 2), digest(sedanGlb));
    await fs.writeFile(blob, 'not the sedan');
    await expect(ensureActorAssets(fixture)).rejects.toThrow(/blob digest mismatch/);
  });

  it('refuses a catalog that binds an id to a path outside the closure', async () => {
    const fixture = await registry({
      'catalog-models.json': Buffer.from(JSON.stringify({ 'vehicle.sedan': { model: { glbPath: 'models/elsewhere.glb' }, tintable: true, scaleToDims: false } })),
    });
    await expect(ensureActorAssets(fixture)).rejects.toThrow(/not a closure member/);
  });
});

describe('parseActorClosureCatalog', () => {
  const members = new Map([
    ['models/pedestrian.adult/model.glb', { sha256: 'a'.repeat(64), bytes: 1 }],
    ['models/pedestrian.adult/walk.glb', { sha256: 'b'.repeat(64), bytes: 1 }],
  ]);
  const parse = (table: unknown) => parseActorClosureCatalog(Buffer.from(JSON.stringify(table)), members);
  const entry = { model: { glbPath: 'models/pedestrian.adult/model.glb' }, tintable: false, scaleToDims: false };

  it('binds animations and in-model clips by motion, as the service does', () => {
    const models = parse({
      version: 3,
      'pedestrian.adult': { ...entry, animations: { walk: { glbPath: 'models/pedestrian.adult/walk.glb', clip: 'Walk', groundOffsetM: 0.027 } } },
      'pedestrian.child': { ...entry, model: { glbPath: 'models/pedestrian.adult/model.glb', clips: { idle: 'Idle', locomotion: 'Run' }, clipGroundOffsetM: { idle: 0.274, locomotion: 0.285 } } },
      'vehicle.bicycle': { ...entry, animations: { ride: { glbPath: 'models/pedestrian.adult/walk.glb', clip: 'ride' } } },
    });
    expect(models.get('pedestrian.adult')!.animations.get('walk')).toEqual({ glbPath: 'models/pedestrian.adult/walk.glb', clip: 'Walk', groundOffsetM: 0.027 });
    expect([...models.get('pedestrian.child')!.animations]).toEqual([
      ['idle', { glbPath: 'models/pedestrian.adult/model.glb', clip: 'Idle', groundOffsetM: 0.274 }],
      ['walk', { glbPath: 'models/pedestrian.adult/model.glb', clip: 'Run', groundOffsetM: 0.285 }],
    ]);
    // A rider clip is placed by its bike's wheels, not by soles.
    expect(models.get('vehicle.bicycle')!.animations.get('ride')).toEqual({ glbPath: 'models/pedestrian.adult/walk.glb', clip: 'ride' });
  });

  it('refuses every malformed entry by name instead of skipping it', () => {
    for (const [table, message] of [
      [{ 'pedestrian.adult': 'model.glb' }, /entry pedestrian.adult is not an object/],
      [{ 'pedestrian.adult': { ...entry, model: { glbPath: 7 } } }, /pedestrian.adult model has no glbPath/],
      [{ 'pedestrian.adult': { model: entry.model, scaleToDims: false } }, /does not declare tintable/],
      [{ 'pedestrian.adult': { ...entry, uniformScale: 'big' } }, /uniformScale is not a finite number/],
      [{ 'pedestrian.adult': { ...entry, animations: { walk: { glbPath: 'models/pedestrian.adult/walk.glb' } } } }, /animation walk names no clip/],
      [{ 'pedestrian.adult': { ...entry, animations: [] } }, /animations is not an object/],
      [{ 'pedestrian.adult': { ...entry, animations: { walk: { glbPath: 'models/pedestrian.adult/walk.glb', clip: 'Walk' } } } }, /walk clip without a measured groundOffsetM/],
      [{ 'pedestrian.adult': { ...entry, animations: { walk: { glbPath: 'models/pedestrian.adult/walk.glb', clip: 'Walk', groundOffsetM: 'low' } } } }, /animation walk groundOffsetM is not a finite number/],
      [{ 'pedestrian.adult': { ...entry, model: { ...entry.model, clips: { idle: 'Idle' } } } }, /idle clip without a measured groundOffsetM/],
      [{ 'pedestrian.adult': { ...entry, model: { ...entry.model, clips: { sprint: 'Run' } } } }, /model.clips.sprint is not a known motion/],
      [{ 'pedestrian.adult': { ...entry, model: { ...entry.model, animated: true } } }, /is animated but binds no animation clips/],
      [[], /expected an object/],
    ] as const) {
      expect(() => parse(table), JSON.stringify(table)).toThrow(expect.objectContaining({ code: 'native_actor_catalog_invalid', message: expect.stringMatching(message) }));
    }
  });
});

const model = (catalogId: string, animations: Record<string, string> = {}): ActorClosureModel => ({
  catalogId, glbPath: `models/${catalogId}/model.glb`,
  animations: new Map(Object.entries(animations).map(([motion, clip]) => [motion, { glbPath: `models/${catalogId}/model.glb`, clip }])),
});

describe('assertActorAppearanceGrounded', () => {
  const assets = { digest: 'a'.repeat(64), models: new Map([['vehicle.sedan', model('vehicle.sedan')]]) };
  const host = { sourceId: 'cam1', actorId: 'ego', vehicleAsset: { catalogAssetId: 'vehicle.sedan' } };


  it('refuses an authored identity the closure cannot model', () => {
    expect(() => assertActorAppearanceGrounded([
      { actorId: 'ego', kind: 'car', catalogId: 'vehicle.sedan', authored: false },
      { actorId: 'parked', kind: 'car', catalogId: 'vehicle.hatchback', authored: true },
    ], [host], assets)).toThrow(expect.objectContaining({
      code: 'native_actor_model_missing', message: expect.stringMatching(/parked requires catalog model vehicle.hatchback/),
    }));
  });

  it('refuses an unauthored actor whose kind default the closure cannot model: no class primitive stands in', () => {
    expect(() => assertActorAppearanceGrounded([
      { actorId: 'truck-1', kind: 'truck', catalogId: 'vehicle.box_truck', authored: false },
    ], [], assets)).toThrow(expect.objectContaining({
      code: 'native_actor_model_missing', message: expect.stringMatching(/truck-1 requires catalog model vehicle.box_truck \(truck default\)/),
    }));
  });

  it('refuses an unauthored actor of an unknown kind, or rendered as another kind\'s default', () => {
    expect(() => assertActorAppearanceGrounded([
      { actorId: 'thing', kind: 'hovercraft', catalogId: 'vehicle.sedan', authored: false },
    ], [], assets)).toThrow(expect.objectContaining({ code: 'native_actor_kind_unmapped' }));
    // The Rust scene-state table sends an unauthored van to the sedan.
    expect(() => assertActorAppearanceGrounded([
      { actorId: 'van-1', kind: 'van', catalogId: 'vehicle.sedan', authored: false },
    ], [], assets)).toThrow(expect.objectContaining({
      code: 'native_actor_default_mismatch', message: expect.stringMatching(/documented default for van is vehicle.van/),
    }));
  });

  it('accepts declared procedural identity but refuses an absent model of the same vehicle', () => {
    const empty = { digest: assets.digest, models: new Map() };
    expect(() => assertActorAppearanceGrounded([
      { actorId: 'parked', kind: 'car', catalogId: 'vehicle.hatchback.low_poly', authored: true },
    ], [], empty)).not.toThrow();
    expect(() => assertActorAppearanceGrounded([
      { actorId: 'parked', kind: 'car', catalogId: 'vehicle.hatchback', authored: true },
    ], [], empty)).toThrow(/parked requires catalog model vehicle.hatchback/);
  });

  it('refuses a sensor host whose contract identity is not what the scenario renders', () => {
    expect(() => assertActorAppearanceGrounded(
      [{ actorId: 'ego', kind: 'car', catalogId: 'vehicle.sedan', authored: false }],
      [{ ...host, vehicleAsset: { catalogAssetId: 'vehicle.kia.carnival' } }],
      assets,
    )).toThrow(/identifies actor ego as vehicle.kia.carnival, but the scenario renders it as vehicle.sedan/);
  });

  it('refuses a sensor host riding an actor that is never present', () => {
    expect(() => assertActorAppearanceGrounded([], [host], assets)).toThrow(/never present/);
  });
});

describe('native actor kind tables', () => {
  it('are the playback kind defaults, one table for browser and native', () => {
    for (const kind of ['vehicle', 'car', 'truck', 'bus', 'van', 'motorcycle', 'bicycle', 'pedestrian', 'scooter', 'sidewalk_robot', 'drone', 'animal', 'static_object'] as const) {
      expect(NATIVE_KIND_DEFAULT_CATALOG_IDS[kind], kind).toBe(defaultCatalogIdForActorKind(kind));
      expect(() => nativeActorClass(kind)).not.toThrow();
    }
  });

  it('refuse a kind they do not map instead of a sedan or a prop', () => {
    expect(() => nativeActorCatalogId('hovercraft', [], 'actor h')).toThrow(expect.objectContaining({ code: 'native_actor_kind_unmapped' }));
    expect(() => nativeActorClass('hovercraft', 'actor h')).toThrow(expect.objectContaining({ code: 'native_actor_kind_unmapped' }));
    expect(nativeActorCatalogId('hovercraft', ['catalog:vehicle.suv'])).toBe('vehicle.suv');
    expect(nativeActorClass('vehicle')).toBe('car');
  });
});

describe('assertActorAnimationsBound', () => {
  const frame = (tick: number, actors: { id: string; catalogId: string; speed: number }[]): NativeSceneState => ({
    version: 'simforge.scene-state.v1', mapId: 'm', tick, tickHz: 24, weather: { preset: 'clear' }, timeOfDay: 12, groundY: 0,
    actors: actors.map((actor) => ({
      id: actor.id, kind: tick === 0 ? 'spawn' : 'update', catalogId: actor.catalogId, actorClass: 'pedestrian',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, velocity: [actor.speed, 0, 0],
    })),
  });
  const walker = { actorId: 'walker', kind: 'pedestrian', catalogId: 'pedestrian.adult', authored: true };

  it('accepts a pedestrian whose model binds the clips its motion needs', () => {
    const assets = { digest: 'c'.repeat(64), models: new Map([['pedestrian.adult', model('pedestrian.adult', { walk: 'walk', idle: 'idle' })]]) };
    expect(() => assertActorAnimationsBound([walker], [
      frame(0, [{ id: 'walker', catalogId: 'pedestrian.adult', speed: 0 }]),
      frame(1, [{ id: 'walker', catalogId: 'pedestrian.adult', speed: 1.4 }]),
    ], assets)).not.toThrow();
  });

  it('refuses a moving pedestrian whose model has no walk clip: it would slide in a static pose', () => {
    const assets = { digest: 'c'.repeat(64), models: new Map([['pedestrian.adult', model('pedestrian.adult', { idle: 'idle' })]]) };
    expect(() => assertActorAnimationsBound([walker], [frame(0, [{ id: 'walker', catalogId: 'pedestrian.adult', speed: 1.4 }])], assets))
      .toThrow(expect.objectContaining({ code: 'native_actor_animation_missing', message: expect.stringMatching(/pedestrian walker moves but its catalog model pedestrian.adult binds no walk clip/) }));
  });

  it('refuses a moving animal without a walk clip, and ignores a standing one', () => {
    const dog = { actorId: 'dog', kind: 'animal', catalogId: 'animal.dog', authored: false };
    const assets = { digest: 'c'.repeat(64), models: new Map([['animal.dog', model('animal.dog')]]) };
    expect(() => assertActorAnimationsBound([dog], [frame(0, [{ id: 'dog', catalogId: 'animal.dog', speed: 0 }])], assets)).not.toThrow();
    expect(() => assertActorAnimationsBound([dog], [frame(0, [{ id: 'dog', catalogId: 'animal.dog', speed: 3 }])], assets))
      .toThrow(expect.objectContaining({ code: 'native_actor_animation_missing' }));
  });
});

describe('shared actor closure tree', () => {
  it('lays the closure out once per digest and reuses it without copying or re-hashing', async () => {
    const fixture = await registry({ 'catalog-models.json': catalog, 'models/vehicle.sedan/model.glb': sedanGlb });
    const treeRoot = path.join(fixture.cacheDir, 'trees');
    const first = await ensureActorAssets({ ...fixture, treeRoot });
    expect(first.directory).toBe(path.join(treeRoot, fixture.closure.sha256));
    const blob = path.join(fixture.cacheDir, 'blobs', 'sha256', digest(sedanGlb).slice(0, 2), digest(sedanGlb));
    const [tree, cached] = await Promise.all([fs.stat(path.join(first.directory, 'models/vehicle.sedan/model.glb')), fs.stat(blob)]);
    expect(tree.ino).toBe(cached.ino);
    const second = await ensureActorAssets({ ...fixture, destination: `${fixture.destination}-2`, treeRoot });
    expect(second.directory).toBe(first.directory);
    await expect(fs.stat(`${fixture.destination}-2`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rebuilds a shared tree whose member was modified', async () => {
    const fixture = await registry({ 'catalog-models.json': catalog, 'models/vehicle.sedan/model.glb': sedanGlb });
    const treeRoot = path.join(fixture.cacheDir, 'trees');
    const first = await ensureActorAssets({ ...fixture, treeRoot });
    const member = path.join(first.directory, 'models/vehicle.sedan/model.glb');
    await fs.rm(member);
    await fs.writeFile(member, 'tampered');
    const second = await ensureActorAssets({ ...fixture, treeRoot });
    expect(await fs.readFile(path.join(second.directory, 'models/vehicle.sedan/model.glb'))).toEqual(sedanGlb);
  });
});

describe('actor asset origin layout', () => {
  it('reaches the same published objects whether the base is the origin or <origin>/actor-assets', async () => {
    const { actorAssetBlobUrl, actorAssetsClosureUrl } = await import('./actor-assets.js');
    const sha = 'ab'.repeat(32);
    for (const base of ['https://cdn.example', 'https://cdn.example/', 'https://cdn.example/actor-assets', 'https://cdn.example/actor-assets/']) {
      expect(actorAssetBlobUrl(sha, base)).toBe(`https://cdn.example/actor-assets/blobs/sha256/ab/${sha}`);
      expect(actorAssetsClosureUrl(sha, base)).toBe(`https://cdn.example/actor-assets/closures/${sha}.json`);
    }
    expect(actorAssetBlobUrl(sha, 'file:///opt/closure')).toBe(`file:///opt/closure/blobs/sha256/ab/${sha}`);
  });
});
