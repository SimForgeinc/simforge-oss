import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { runInstalledMapChecks } from './installed-map-checks.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const mapId = 'mapv_qualification';
const root = `/api/simforge/maps/${mapId}`;
async function fixture(t, { corrupt = false, cached = true, registered = cached, installFails = false, external = false, textureMode } = {}) {
  const browser = Buffer.from(JSON.stringify({ schema: 'qualification-fixture', members: [] }));
  const master = Buffer.from(JSON.stringify({
    asset: { version: '2.0' }, meshes: [{ primitives: [] }], buffers: [{ uri: 'mesh.bin', byteLength: 4 }],
    ...(textureMode ? { images: [{ uri: 'missing.png' }, { uri: 'mesh.bin' }],
      textures: [{ source: 0, ...(textureMode === 'basisu' ? { extensions: { KHR_texture_basisu: { source: 1 } } } : {}) }] } : {}),
  }));
  const mesh = Buffer.from([1, 2, 3, 4]);
  const assets = new Map([[`${root}/browser-assets/manifest.json`, browser], [`${root}/semantic-assets/master.gltf`, master], [`${root}/semantic-assets/mesh.bin`, mesh]]);
  const calls = [];
  const counts = new Map();
  const descriptor = {
    mapVersionId: mapId, sourceMapId: 'richmond-field-station', label: 'Richmond Field Station',
    access: 'public', locked: false, installed: { browser: registered, semantic: registered },
    browserClosureSha256: digest(browser), browserManifestUrl: `${root}/browser-assets/manifest.json`,
    topologyArtifactUrl: `${root}/browser-assets/manifest.json`, derivedTopologyUrl: `${root}/browser-assets/manifest.json`,
    locationsUrl: `${root}/browser-assets/manifest.json`, signalsArtifactUrl: `${root}/browser-assets/manifest.json`,
    xodr: { artifactId: 'artifact_xodr' }, coordinateSystem: { id: 'coordinate_local' },
  };
  if (external) descriptor.locationsUrl = 'http://external.invalid/credentials-must-not-leave';
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    calls.push({ path, method: request.method });
    const json = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (path === '/api/simforge/maps/catalog' || path === '/api/simforge/maps') return json({ maps: [descriptor] });
    if (path === root) return json(descriptor);
    if (path === '/api/simforge/maps/cache-plan') return json({ maps: [{ mapVersionId: mapId, closureSha256: descriptor.browserClosureSha256, assets: [{ relativePath: 'manifest.json', sha256: digest(browser), byteLength: browser.length }] }] });
    if (path === `${root}/install`) {
      const profile = body.profile;
      const count = (counts.get(profile) ?? 0) + 1;
      counts.set(profile, count);
      if (!installFails) descriptor.installed[profile] = true;
      return json({ mapVersionId: mapId, profile, state: installFails ? 'error' : 'ready', directory: `/owned/${profile}`, progress: { members: count === 1 ? 1 : 0, completedMembers: count === 1 ? 1 : 0, bytes: count === 1 ? 4 : 0, completedBytes: count === 1 ? 4 : 0 } });
    }
    if (path === '/api/simforge/map-cache/has') return json({ cached });
    if (path === '/api/simforge/map-cache/ensure') return json({ cacheHit: true, sha256: body.sha256, sizeBytes: body.sizeBytes });
    if (assets.has(path)) {
      const bytes = assets.get(path);
      response.writeHead(200, { 'content-length': bytes.length, 'x-content-sha256': digest(bytes) });
      return response.end(corrupt && path.includes('browser-assets') ? Buffer.alloc(bytes.length) : bytes);
    }
    json({ error: 'unexpected route' }, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, calls, counts };
}
const named = (checks, name) => { const result = checks.find(check => check.name === name); assert.ok(result, `Missing ${name}`); return result; };

test('verified map bytes and repeated installation establish cache reuse, not native execution', async t => {
  const host = await fixture(t);
  const checks = await runInstalledMapChecks({ ...host, allowMapDownload: true });
  for (const name of ['map-browser-bytes', 'map-editor-assets', 'map-semantic-bytes', 'map-repeat-install', 'map-cache-reuse']) assert.equal(named(checks, name).status, 'passed', JSON.stringify(checks));
  assert.equal(host.counts.get('browser'), 2);
  assert.equal(host.counts.get('semantic'), 2);
  assert.equal(named(checks, 'map-native-render').status, 'blocked');
});

test('corrupted cached bytes fail even when install and metadata say ready', async t => {
  const host = await fixture(t, { corrupt: true });
  const checks = await runInstalledMapChecks({ ...host, allowMapDownload: true });
  assert.equal(named(checks, 'map-browser-bytes').status, 'failed');
  assert.equal(named(checks, 'map-cache-reuse').status, 'blocked');
});

test('read-only checks never install or fetch missing map bytes', async t => {
  const host = await fixture(t, { cached: false });
  const checks = await runInstalledMapChecks(host);
  assert.equal(named(checks, 'map-install-browser').status, 'blocked');
  assert.equal(named(checks, 'map-browser-ready').status, 'blocked');
  assert.equal(host.calls.some(call => call.path.endsWith('/install') || call.path.includes('-assets/') || call.path.endsWith('/ensure')), false);
});

test('failed install cannot turn into installed readiness', async t => {
  const host = await fixture(t, { cached: false, installFails: true });
  const checks = await runInstalledMapChecks({ ...host, allowMapDownload: true });
  assert.equal(named(checks, 'map-install-browser').status, 'failed');
  assert.equal(named(checks, 'map-browser-ready').status, 'blocked');
  assert.equal(named(checks, 'map-repeat-install').status, 'blocked');
});

test('external editor asset routes are rejected before credentialed retrieval', async t => {
  const host = await fixture(t, { external: true });
  const checks = await runInstalledMapChecks({ ...host, headers: { authorization: 'Bearer qualification-secret' }, allowMapDownload: true });
  assert.equal(named(checks, 'map-editor-assets').status, 'failed');
  assert.equal(JSON.stringify(checks).includes('qualification-secret'), false);
});

test('pre-cancelled qualification makes no network requests and passes no map checks', async t => {
  const host = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  const checks = await runInstalledMapChecks({ ...host, signal: controller.signal, allowMapDownload: true });
  assert.equal(checks.every(check => check.status === 'blocked'), true);
  assert.deepEqual(host.calls, []);
});

test('stale installed metadata cannot cause read-only asset GETs on cache misses', async t => {
  const host = await fixture(t, { cached: false, registered: true });
  const checks = await runInstalledMapChecks(host);
  assert.equal(named(checks, 'map-browser-bytes').status, 'blocked');
  assert.equal(named(checks, 'map-semantic-bytes').status, 'blocked');
  assert.ok(host.calls.some(call => call.path.endsWith('/has')));
  assert.equal(host.calls.some(call => call.path.includes('-assets/') || call.path.endsWith('/ensure') || call.path.endsWith('/install')), false);
});

test('native BasisU selection verifies the required image without requesting unused PNG fallbacks', async t => {
  const host = await fixture(t, { textureMode: 'basisu' });
  const checks = await runInstalledMapChecks({ ...host, allowMapDownload: true });
  assert.equal(named(checks, 'map-semantic-bytes').status, 'passed');
  assert.equal(host.calls.some(call => call.path.endsWith('/missing.png')), false);
});

test('a missing selected texture is still a semantic verification failure', async t => {
  const host = await fixture(t, { textureMode: 'png' });
  const checks = await runInstalledMapChecks({ ...host, allowMapDownload: true });
  assert.equal(named(checks, 'map-semantic-bytes').status, 'failed');
  assert.equal(named(checks, 'map-cache-reuse').status, 'blocked');
});
