import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { MESHY_ATTRIBUTION, deriveAttributed } from './public-closure.mjs';
import {
  AssetUnavailableError, TREE_COMPLETE_MARKER, blobCachePath, blobUrl, closureUrl, materializeClosure, packClosure,
  UNCONFIRMED_LICENSE, parseClosure, pinnedDirSync, pullBlob, readLock, sealClosure, sha256Bytes, unlicensedMembers,
} from './closures.mjs';

const scratch = await mkdtemp(path.join(tmpdir(), 'closures-test-'));
after(() => rm(scratch, { recursive: true, force: true }));

/** A local closure root (`closures/` + `blobs/`) holding `files`; returns its pin and origin. */
async function publish(name, files) {
  const root = path.join(scratch, name);
  const members = {};
  for (const [memberPath, text] of Object.entries(files)) {
    const bytes = Buffer.from(text);
    const identity = { sha256: sha256Bytes(bytes), bytes: bytes.byteLength };
    const blob = path.join(root, 'blobs', 'sha256', identity.sha256.slice(0, 2), identity.sha256);
    await mkdir(path.dirname(blob), { recursive: true });
    await writeFile(blob, bytes);
    members[memberPath] = identity;
  }
  const sealed = sealClosure(members);
  await mkdir(path.join(root, 'closures'), { recursive: true });
  await writeFile(path.join(root, 'closures', `${sealed.sha256}.json`), sealed.bytes);
  return { pin: { sha256: sealed.sha256, bytes: sealed.size }, origin: pathToFileURL(root).href, root, members };
}

describe('content-addressed closures', () => {
  it('materializes a closure by digest, attribution included, and reuses the tree offline', async () => {
    const { pin, origin, root } = await publish('ok', {
      'ATTRIBUTION.json': '{"license":"CC-BY-4.0"}',
      'catalog-models.json': '{}',
      'models/car.glb': 'glTF-car',
    });
    const cacheDir = path.join(scratch, 'cache-ok');
    const first = await materializeClosure(pin, { origin, cacheDir });
    assert.equal(await readFile(path.join(first.directory, 'models/car.glb'), 'utf8'), 'glTF-car');
    assert.ok((await stat(path.join(first.directory, 'ATTRIBUTION.json'))).isFile());
    assert.ok((await stat(path.join(first.directory, TREE_COMPLETE_MARKER))).isFile());
    await rm(root, { recursive: true, force: true });
    const again = await materializeClosure(pin, { origin, cacheDir });
    assert.equal(again.directory, first.directory);
  });

  it('fails loudly, naming the digest, when a member is not served', async () => {
    const { pin, origin, root, members } = await publish('missing', { 'catalog-models.json': '{}', 'models/x.glb': 'x' });
    const gone = members['models/x.glb'].sha256;
    await rm(path.join(root, 'blobs', 'sha256', gone.slice(0, 2), gone));
    const cacheDir = path.join(scratch, 'cache-missing');
    await assert.rejects(materializeClosure(pin, { origin, cacheDir }), (error) => {
      assert.ok(error instanceof AssetUnavailableError);
      assert.match(error.message, new RegExp(gone));
      return true;
    });
    await assert.rejects(stat(path.join(cacheDir, 'trees', pin.sha256)), { code: 'ENOENT' });
  });

  it('never caches bytes that are not the pinned asset', async () => {
    const { origin, root, members } = await publish('tampered', { 'models/x.glb': 'right' });
    const identity = members['models/x.glb'];
    await writeFile(path.join(root, 'blobs', 'sha256', identity.sha256.slice(0, 2), identity.sha256), 'wrong');
    const cacheDir = path.join(scratch, 'cache-tampered');
    await assert.rejects(pullBlob(identity, { origin, cacheDir }), /does not verify/);
    await assert.rejects(stat(blobCachePath(identity.sha256, cacheDir)), { code: 'ENOENT' });
    assert.throws(() => parseClosure(Buffer.from('{}'), { sha256: identity.sha256, bytes: 2 }), /does not match its pin/);
  });

  it('pinnedDirSync never fetches: an unmaterialized pin names the pull command', () => {
    assert.throws(() => pinnedDirSync('vehicles-carla', { cacheDir: path.join(scratch, 'empty') }), /closures\.mjs pull vehicles-carla/);
  });

  it('addresses the origin the way the render workers and the CLI do', () => {
    const digest = 'ab'.repeat(32);
    assert.equal(blobUrl(digest, 'https://cdn.example/actor-assets/'), `https://cdn.example/actor-assets/blobs/sha256/ab/${digest}`);
    assert.equal(closureUrl(digest, 'https://cdn.example'), `https://cdn.example/actor-assets/closures/${digest}.json`);
  });

  it('binds per-member licences into the digest and names the unlicensed members', () => {
    const members = { 'a.glb': { sha256: 'a'.repeat(64), bytes: 1 }, 'b.glb': { sha256: 'b'.repeat(64), bytes: 2 }, 'c.glb': { sha256: 'c'.repeat(64), bytes: 3 } };
    const bare = sealClosure(members);
    const licensed = sealClosure(members, { licenses: { 'a.glb': { license: 'CC-BY-4.0', attribution: 'x © y' }, 'b.glb': { license: UNCONFIRMED_LICENSE, source: 'meshy' } } });
    assert.notEqual(bare.sha256, licensed.sha256);
    const closure = parseClosure(licensed.bytes, { sha256: licensed.sha256, bytes: licensed.size });
    assert.equal(closure.licenses.get('a.glb').license, 'CC-BY-4.0');
    assert.deepEqual(unlicensedMembers(closure), ['b.glb', 'c.glb']);
    assert.throws(() => sealClosure(members, { licenses: { 'z.glb': { license: 'MIT' } } }), /not a member/);
  });

  it('the repository packs are sealed, pinned, licensed and carry their attribution', () => {
    const lock = readLock();
    for (const name of ['vehicles-carla', 'pedestrians-carla']) {
      const closure = packClosure(name, lock);
      assert.deepEqual(unlicensedMembers(closure), [], `${name}: every member has a confirmed licence`);
      assert.ok(closure.members.has('ATTRIBUTION.json'), `${name} carries ATTRIBUTION.json`);
      assert.ok([...closure.members.keys()].some((member) => member.startsWith('models/')), `${name} carries models`);
    }
    assert.equal(lock.closures.actors.sha256, '793ec86ceda7734f1f5f7c0b260a396c11c970a471ab4418987e4d531f33daa4');
  });

  it('the attributed closure licenses every member, attributes every entry and drops orphans', () => {
    const id = (c) => ({ sha256: c.repeat(64), bytes: 1 });
    const base = { members: new Map([
      ['catalog-models.json', id('0')], ['models/vehicle.sedan/model.glb', id('1')], ['models/robot.x/model.glb', id('2')],
      ['models/animal.cat/model.glb', id('3')], ['models/pedestrian.adult/animations/walk.glb', id('4')],
    ]) };
    const catalog = Buffer.from(JSON.stringify({
      'vehicle.sedan': { model: { glbPath: 'models/vehicle.sedan/model.glb', attribution: 'Sedan (c) CARLA, CC BY 4.0', source: 'carla-0.10.0-ue5' },
        provenance: { boundUrl: '/catalog/vehicles-carla/models/vehicle_sedan.glb' } },
      'robot.x': { model: { glbPath: 'models/robot.x/model.glb', attribution: 'procedural robot', source: 'asset-catalog-procedural' } },
      'animal.cat': { model: { glbPath: 'models/animal.cat/model.glb', attribution: 'Generated with Meshy for SimForge', source: 'meshy-refined' } },
    }));
    const carla = new Map([['vehicles-carla/models/vehicle_sedan.glb', {
      title: 'Sedan', license: 'CC-BY-4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/', attribution: 'Sedan (c) CARLA',
      source: 'CARLA 0.10.0', modifications: ['converted to glTF'],
    }]]);
    const result = deriveAttributed(base, catalog, carla);
    assert.deepEqual(result.excluded, ['models/pedestrian.adult/animations/walk.glb']);
    assert.equal(result.assets['animal.cat'].license, 'CC-BY-4.0');
    assert.equal(result.assets['animal.cat'].attribution, MESHY_ATTRIBUTION);
    assert.ok(result.assets['animal.cat'].modifications.length > 0 && result.assets['animal.cat'].note);
    assert.equal(result.assets['robot.x'].license, 'Apache-2.0');
    assert.deepEqual(result.assets['vehicle.sedan'].modifications, ['converted to glTF']);
    assert.equal(result.members['catalog-models.json'].sha256, sha256Bytes(catalog), 'the catalog is carried byte for byte');
    const sealed = sealClosure(result.members, { licenses: result.licenses });
    const closure = parseClosure(sealed.bytes, { sha256: sealed.sha256, bytes: sealed.size });
    assert.deepEqual(unlicensedMembers(closure), []);
    assert.ok(closure.members.has('ATTRIBUTION.json'));
    const unknown = Buffer.from(JSON.stringify({ 'x.y': { model: { glbPath: 'models/robot.x/model.glb', source: 'somewhere' } } }));
    assert.throws(() => deriveAttributed(base, unknown, carla), /no known licence/);
  });
});
