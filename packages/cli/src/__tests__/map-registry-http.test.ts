import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRegistryBackend, publishVersion, sha256 } from '@simforge-oss/map-registry';
import { expect, it } from 'vitest';
import { registryMapsPull } from '../commands/map-registry.js';

it('pulls the immutable native and web release from a read-only HTTP registry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simforge-cli-http-registry-'));
  const backend = new FileRegistryBackend(`file://${join(root, 'registry')}`);
  const master = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0, nodes: [] }));
  const webManifest = Buffer.from(JSON.stringify({ version: '1.2.0', tiles: [], vegetationTiles: [], staticLayers: [] }));
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    try {
      const bytes = await backend.get(new URL(request.url!, 'http://localhost').pathname.slice(1));
      const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
      const body = bytes.subarray(start, end + 1);
      if (range) response.writeHead(206, { 'content-range': `bytes ${start}-${end}/${bytes.length}` });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(404).end();
    }
  });
  try {
    await publishVersion(backend, {
      name: 'test-map', version: 'v1',
      closure: {
        schema: 'map-closure.v1', kind: 'canonical', metadata: { master: true },
        members: { 'master.gltf': { sha256: sha256(master), bytes: master.length } },
      },
      files: { 'master.gltf': master },
      derived: [{
        closure: {
          schema: 'map-closure.v1', kind: 'web', toolFingerprint: 'http-web-tier',
          members: { '3d/manifest.json': { sha256: sha256(webManifest), bytes: webManifest.length } },
        },
        files: { '3d/manifest.json': webManifest },
      }],
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP registry did not bind a TCP port');
    const cacheRoot = join(root, 'cache');
    expect(await registryMapsPull({
      reference: 'test-map@v1', registry: `http://127.0.0.1:${address.port}`,
      cacheRoot, pretty: false,
    })).toBe(0);
    expect(await readFile(join(cacheRoot, '.corpus/test-map/master.gltf'))).toEqual(master);
    expect(await readFile(join(cacheRoot, 'map-bundles/test-map/3d/manifest.json'))).toEqual(webManifest);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
