import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STUDIO_HOST_PROTOCOL_VERSION } from '@simforge-oss/studio-host';
import { writeLocalHostState } from '@simforge-oss/studio-host/node';
import { expect, it } from 'vitest';
import { hostRequest } from '../host-client.js';

const TOKEN = 'test-only-control-token';

/** A host record pointing at a fake host whose capability document is `capabilities`. */
async function fakeHost(capabilities: unknown) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'simforge-cli-host-protocol-'));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401).end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/simforge/host/capabilities') response.end(JSON.stringify(capabilities));
    else response.end(JSON.stringify({ answered: request.url }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake host did not bind a TCP port');
  await writeLocalHostState({
    schema: 'simforge.local-host-state/v1',
    pid: process.pid,
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    controlToken: TOKEN,
    startedAt: new Date(0).toISOString(),
    withWorker: false,
  }, { SIMFORGE_CLOUD_ROOT: dataRoot });
  return {
    dataRoot,
    requests,
    async close() {
      server.closeAllConnections();
      server.close();
      await rm(dataRoot, { recursive: true, force: true });
    },
  };
}

it('issues the call once the host speaks this CLI protocol version', async () => {
  const host = await fakeHost({ protocolVersion: STUDIO_HOST_PROTOCOL_VERSION, transports: ['http'] });
  try {
    await expect(hostRequest('/api/simforge/maps', { dataRoot: host.dataRoot })).resolves.toEqual({ answered: '/api/simforge/maps' });
    expect(host.requests).toEqual(['/api/simforge/host/capabilities', '/api/simforge/maps']);
  } finally {
    await host.close();
  }
});

it('refuses a host on another protocol version before issuing the call, naming the side to upgrade', async () => {
  const host = await fakeHost({ protocolVersion: STUDIO_HOST_PROTOCOL_VERSION + 1, transports: ['http'] });
  try {
    await expect(hostRequest('/api/simforge/maps', { dataRoot: host.dataRoot })).rejects.toMatchObject({
      code: 'host_incompatible',
      reason: expect.stringMatching(new RegExp(`protocol ${STUDIO_HOST_PROTOCOL_VERSION + 1}.*protocol ${STUDIO_HOST_PROTOCOL_VERSION}.*upgrade the client`)),
    });
    expect(host.requests).toEqual(['/api/simforge/host/capabilities']);
  } finally {
    await host.close();
  }
});

it('refuses a host whose capability document predates the protocol version', async () => {
  const host = await fakeHost({ schema: 'simforge.studio-host-capabilities/v1', host: { kind: 'local', version: '0.0.1' } });
  try {
    await expect(hostRequest('/api/simforge/maps', { dataRoot: host.dataRoot })).rejects.toMatchObject({
      code: 'host_incompatible',
      reason: expect.stringMatching(/upgrade the host/),
    });
    expect(host.requests).toEqual(['/api/simforge/host/capabilities']);
  } finally {
    await host.close();
  }
});
