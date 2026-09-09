import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertActorAppearanceGrounded,
  ensureActorAssets,
} from './actor-assets.js';

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
  'vehicle.sedan': { model: { glbPath: 'models/vehicle.sedan/model.glb' } },
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
      'catalog-models.json': Buffer.from(JSON.stringify({ 'vehicle.sedan': { model: { glbPath: 'models/elsewhere.glb' } } })),
    });
    await expect(ensureActorAssets(fixture)).rejects.toThrow(/not a closure member/);
  });
});

describe('assertActorAppearanceGrounded', () => {
  const assets = { digest: 'a'.repeat(64), models: new Map([['vehicle.sedan', { catalogId: 'vehicle.sedan', glbPath: 'x', animationPaths: [] }]]) };
  const host = { sourceId: 'cam1', actorId: 'ego', vehicleAsset: { catalogAssetId: 'vehicle.sedan' } };


  it('refuses an authored identity the closure cannot model', () => {
    expect(() => assertActorAppearanceGrounded([
      { actorId: 'ego', catalogId: 'vehicle.sedan', authored: false },
      { actorId: 'parked', catalogId: 'vehicle.hatchback', authored: true },
    ], [host], assets)).toThrow(/parked requires catalog model vehicle.hatchback/);
  });

  it('refuses a sensor host whose contract identity is not what the scenario renders', () => {
    expect(() => assertActorAppearanceGrounded(
      [{ actorId: 'ego', catalogId: 'vehicle.sedan', authored: false }],
      [{ ...host, vehicleAsset: { catalogAssetId: 'vehicle.kia.carnival' } }],
      assets,
    )).toThrow(/identifies actor ego as vehicle.kia.carnival, but the scenario renders it as vehicle.sedan/);
  });

  it('refuses a sensor host riding an actor that is never present', () => {
    expect(() => assertActorAppearanceGrounded([], [host], assets)).toThrow(/never present/);
  });
});
