import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { crc32 } from 'node:zlib';

import { decode, encode } from '@msgpack/msgpack';
import { afterEach, describe, expect, it } from 'vitest';

import { NATIVE_SERVICE_PROTOCOL, NativeServiceClient, NativeServiceTimeoutError } from './service-client.js';

type Request = { readonly i: number; readonly op: string };

interface FakeService {
  readonly endpoint: string;
  /** Resolves once every connection the client opened has closed on the server side. */
  allConnectionsClosed(): Promise<unknown>;
  stop(): Promise<void>;
}

/**
 * A service double speaking the framed msgpack wire: `answer` decides per op;
 * `undefined` means never reply, `'close'` drops the connection (what an
 * older service does with an op it cannot decode).
 */
async function fakeService(answer: (request: Request) => Record<string, unknown> | 'close' | undefined): Promise<FakeService> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'sf-client-test-'));
  const endpoint = path.join(directory, 'rpc.sock');
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.byteLength >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.byteLength < 4 + length) return;
        const request = decode(buffer.subarray(4, 4 + length)) as Request;
        buffer = buffer.subarray(4 + length);
        const reply = answer(request);
        if (reply === 'close') {
          socket.destroy();
          return;
        }
        if (!reply) continue;
        const payload = Buffer.from(encode({ i: request.i, op: request.op, ok: true, ...reply }));
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32LE(payload.byteLength);
        socket.write(Buffer.concat([header, payload]));
      }
    });
  });
  server.listen(endpoint);
  await once(server, 'listening');
  const connections = new Set<net.Socket>();
  const closedConnections: Promise<void>[] = [];
  server.on('connection', (socket) => {
    connections.add(socket);
    closedConnections.push(once(socket, 'close').then(() => undefined));
  });
  return {
    endpoint,
    allConnectionsClosed: () => Promise.all(closedConnections),
    async stop() {
      for (const socket of connections) socket.destroy();
      server.close();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

const hello = { protocol: NATIVE_SERVICE_PROTOCOL, shm: { path: '/dev/null', size_bytes: 0, meta_bytes: 0 } };

describe('NativeServiceClient', () => {
  let service: FakeService | undefined;
  afterEach(async () => {
    await service?.stop();
    service = undefined;
  });

  it('exposes operation-specific reply fields without a copy', async () => {
    service = await fakeService((request) => request.op === 'hello' ? hello : { coverage: [{ sensorId: 'cam', fraction: 0.5 }] });
    const client = await NativeServiceClient.connect(service.endpoint);
    const response = await client.rpc({ op: 'render' });
    expect(response.op).toBe('render');
    expect(response.coverage).toEqual([{ sensorId: 'cam', fraction: 0.5 }]);
    await client.close();
  });

  it('refuses a service speaking another protocol', async () => {
    service = await fakeService((request) => request.op === 'hello' ? { ...hello, protocol: NATIVE_SERVICE_PROTOCOL + 1 } : {});
    await expect(NativeServiceClient.connect(service.endpoint)).rejects.toThrow(/protocol/);
  });

  it('fails the whole connection when one RPC times out, leaving nothing pending', async () => {
    service = await fakeService((request) => request.op === 'hello' ? hello : undefined);
    const client = await NativeServiceClient.connect(service.endpoint);
    const late = client.rpc({ op: 'render' }, 50);
    const sibling = client.rpc({ op: 'coverage' });
    await Promise.all([
      expect(late).rejects.toBeInstanceOf(NativeServiceTimeoutError),
      expect(late).rejects.toMatchObject({ name: 'TimeoutError' }),
      expect(sibling).rejects.toBeInstanceOf(NativeServiceTimeoutError),
    ]);
    // The connection is gone: later calls reject immediately instead of dangling on a wedged service.
    await expect(client.rpc({ op: 'hello' })).rejects.toBeInstanceOf(NativeServiceTimeoutError);
    await service.allConnectionsClosed();
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('fails the handshake instead of hanging when hello is never answered', async () => {
    service = await fakeService(() => undefined);
    await expect(NativeServiceClient.connect(service.endpoint, { helloTimeoutMs: 50 })).rejects.toBeInstanceOf(NativeServiceTimeoutError);
    await service.allConnectionsClosed();
  });

  it('rejects in-flight calls when the service drops the connection', async () => {
    service = await fakeService((request) => request.op === 'hello' ? hello : undefined);
    const client = await NativeServiceClient.connect(service.endpoint);
    const pending = client.rpc({ op: 'render' });
    // Whichever the socket reports first (a reset or a plain close) must reach the caller.
    const rejection = expect(pending).rejects.toThrow(/ECONNRESET|socket closed/);
    await service.stop();
    service = undefined;
    await rejection;
  });

  it('never sends observe_actors to a service that does not advertise it', async () => {
    const seen: string[] = [];
    // An older service: no capabilities, and it drops the connection on the unknown op.
    service = await fakeService((request) => {
      seen.push(request.op);
      if (request.op === 'hello') return hello;
      if (request.op === 'observe_actors') return 'close';
      return { rendered: true };
    });
    const client = await NativeServiceClient.connect(service.endpoint);
    expect(client.supports('observe_actors')).toBe(false);
    await expect(client.observeActors()).resolves.toBeNull();
    // The connection is intact: the render carries on without observation.
    await expect(client.rpc({ op: 'render' })).resolves.toMatchObject({ rendered: true });
    expect(seen).toEqual(['hello', 'render']);
    await client.close();
  });

  it('observes actors on a service that advertises the op', async () => {
    const actor = { id: 'a', position: [1, 2, 3], rotation: [0, 0, 0, 1], bodyCentre: [1, 2.75, 3], visible: true };
    service = await fakeService((request) => {
      if (request.op === 'hello') return { ...hello, capabilities: ['observe_actors'] };
      if (request.op === 'observe_actors') return { tick: 4, actors: [actor] };
      return {};
    });
    const client = await NativeServiceClient.connect(service.endpoint);
    expect(client.supports('observe_actors')).toBe(true);
    await expect(client.observeActors()).resolves.toEqual({ tick: 4, actors: [actor] });
    await client.close();
  });

  it('reports the placement height source and refuses an unknown one', async () => {
    const sha256 = 'a'.repeat(64);
    service = await fakeService((request) => request.op === 'hello' ? { ...hello, capabilities: ['ground_mesh'], ground: { source: 'ground-mesh', sha256 } } : {});
    let client = await NativeServiceClient.connect(service.endpoint);
    expect(client.ground).toEqual({ source: 'ground-mesh', sha256 });
    await client.close();
    await service.stop();

    service = await fakeService((request) => request.op === 'hello' ? { ...hello, ground: { source: 'legacy-mesh-field' } } : {});
    client = await NativeServiceClient.connect(service.endpoint);
    expect(client.ground).toEqual({ source: 'legacy-mesh-field' });
    await client.close();
    await service.stop();

    // A service that predates the report says nothing; the engine refuses it.
    service = await fakeService((request) => request.op === 'hello' ? hello : {});
    client = await NativeServiceClient.connect(service.endpoint);
    expect(client.ground).toBeNull();
    await client.close();
    await service.stop();

    service = await fakeService((request) => request.op === 'hello' ? { ...hello, ground: { source: 'xodr' } } : {});
    await expect(NativeServiceClient.connect(service.endpoint)).rejects.toThrow(/unknown ground source/);
  });

  it('verifies every shared-memory payload against the CRC32 the service published', async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'sf-shm-test-'));
    const shm = path.join(directory, 'ring');
    const payload = Buffer.from('rgba-bytes-of-one-frame');
    await fs.writeFile(shm, Buffer.concat([Buffer.alloc(128), payload]));
    service = await fakeService((request) => request.op === 'hello' ? { ...hello, shm: { path: shm, size_bytes: 1024, meta_bytes: 0 } } : {});
    const client = await NativeServiceClient.connect(service.endpoint);
    const record = {
      sensorId: 'cam', pass: 'rgb', offset: 0, len: payload.byteLength, width: 1, height: 1, format: 'rgba8', tickId: 3,
      digest: crc32(payload).toString(16).padStart(8, '0'),
    };
    await expect(client.readFrame(record)).resolves.toEqual(payload);
    await expect(client.readFrame({ ...record, digest: '00000000' }))
      .rejects.toMatchObject({ code: 'native_frame_digest_mismatch', retryable: false });
    await client.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
});
