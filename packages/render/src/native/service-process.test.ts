import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NATIVE_SERVICE_PROTOCOL } from './service-client.js';
import { startNativeRenderService } from './service-process.js';

/**
 * A stand-in for native-render-service driven by `FAKE_SERVICE_MODE`:
 * `ready` serves hello/close over the requested socket after writing the
 * ready file atomically; `exit` dies with code 3; `hang` never becomes
 * ready; `protocol` declares a wire protocol this client cannot speak.
 */
const FAKE_SERVICE = `
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { decode, encode } = require(process.env.MSGPACK);
const args = process.argv.slice(2);
const arg = (flag) => args[args.indexOf(flag) + 1];
fs.writeFileSync(path.join(path.dirname(arg('--scene')), 'service-endpoint'), arg('--socket'));
process.stderr.write('fake service booting\\n');
const mode = process.env.FAKE_SERVICE_MODE;
if (mode === 'exit') { process.stderr.write('boom: no GPU\\n'); process.exit(3); }
if (mode === 'hang') { setInterval(() => {}, 1000); }
else {
  const shm = arg('--shm');
  fs.writeFileSync(shm, Buffer.alloc(16));
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < 4 + length) return;
        const request = decode(buffer.subarray(4, 4 + length));
        buffer = buffer.subarray(4 + length);
        const reply = request.op === 'hello'
          ? { protocol: ${NATIVE_SERVICE_PROTOCOL}, shm: { path: shm, size_bytes: 16, meta_bytes: 0 } }
          : {};
        const payload = Buffer.from(encode({ i: request.i, op: request.op, ok: true, ...reply }));
        const header = Buffer.alloc(4);
        header.writeUInt32LE(payload.length);
        socket.write(Buffer.concat([header, payload]));
        if (request.op === 'close') socket.end(() => process.exit(0));
      }
    });
  });
  server.listen(arg('--socket'), () => {
    const readyFile = arg('--ready-file');
    const ready = {
      protocol: mode === 'protocol' ? ${NATIVE_SERVICE_PROTOCOL} + 1 : ${NATIVE_SERVICE_PROTOCOL},
      pid: process.pid, endpoint: arg('--socket'), shm: { path: shm, size_bytes: 16, meta_bytes: 0 },
    };
    fs.writeFileSync(readyFile + '.tmp', JSON.stringify(ready));
    fs.renameSync(readyFile + '.tmp', readyFile);
  });
}
`;

const require = createRequire(import.meta.url);

// The fake binary is a POSIX shell wrapper around node; the session's Windows path (named pipes) is exercised only by the real service.
describe.skipIf(process.platform === 'win32')('startNativeRenderService', () => {
  let root: string;
  let fakeBinary: string;
  let workspace: string;
  let scenePath: string;
  const originalMode = process.env.FAKE_SERVICE_MODE;
  const originalMsgpack = process.env.MSGPACK;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'sf-service-test-'));
    const script = path.join(root, 'fake-service.cjs');
    await fs.writeFile(script, FAKE_SERVICE);
    fakeBinary = path.join(root, 'fake-service');
    await fs.writeFile(fakeBinary, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
    process.env.MSGPACK = require.resolve('@msgpack/msgpack');
  });

  afterAll(async () => {
    if (originalMode === undefined) delete process.env.FAKE_SERVICE_MODE;
    else process.env.FAKE_SERVICE_MODE = originalMode;
    if (originalMsgpack === undefined) delete process.env.MSGPACK;
    else process.env.MSGPACK = originalMsgpack;
    await fs.rm(root, { recursive: true, force: true });
  });

  async function start(mode: string, options: { readonly signal?: AbortSignal; readonly startupTimeoutMs?: number } = {}) {
    process.env.FAKE_SERVICE_MODE = mode;
    workspace = path.join(root, `workspace-${mode}`);
    scenePath = path.join(workspace, 'scene.json');
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(scenePath, '{}');
    return startNativeRenderService({
      binary: fakeBinary, workspace, jobId: 'job/with:odd chars', scenePath,
      signal: options.signal ?? new AbortController().signal,
      startupTimeoutMs: options.startupTimeoutMs ?? 20_000,
    });
  }

  async function expectSocketRemoved(): Promise<void> {
    const endpoint = await fs.readFile(path.join(workspace, 'service-endpoint'), 'utf8');
    await expect(fs.access(path.dirname(endpoint))).rejects.toMatchObject({ code: 'ENOENT' });
  }

  it('serves a session whose close terminates the process and removes only what it created', async () => {
    const session = await start('ready');
    await session.client.rpc({ op: 'hello' });
    expect(await session.readStderr()).toContain('fake service booting');
    await expect(fs.access(path.join(workspace, 'native-render-ready.json'))).resolves.toBeUndefined();

    await session.close();
    await session.close();
    await expect(session.client.rpc({ op: 'hello' })).rejects.toThrow(/closed/);
    await expect(fs.access(path.join(workspace, 'native-render-ready.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(path.join(workspace, 'native-render.shm'))).rejects.toMatchObject({ code: 'ENOENT' });
    // The workspace, the caller's scene and the captured log all survive teardown.
    expect(await fs.readFile(scenePath, 'utf8')).toBe('{}');
    expect(await session.readStderr()).toContain('fake service booting');
    await expectSocketRemoved();
  });

  it('surfaces a startup crash as its exit code and stderr, never as a timeout', async () => {
    await expect(start('exit')).rejects.toThrow(/exited with code 3[\s\S]*boom: no GPU/);
    await expectSocketRemoved();
    expect(await fs.readFile(scenePath, 'utf8')).toBe('{}');
  });

  it('rejects a missing binary through the spawn error instead of an unhandled event', async () => {
    process.env.FAKE_SERVICE_MODE = 'ready';
    workspace = path.join(root, 'workspace-missing');
    await fs.mkdir(workspace, { recursive: true });
    const failure: unknown = await startNativeRenderService({
      binary: path.join(root, 'no-such-binary'), workspace, jobId: 'missing', scenePath: path.join(workspace, 'scene.json'),
      signal: new AbortController().signal, startupTimeoutMs: 20_000,
    }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).cause).toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(workspace)).isDirectory()).toBe(true);
  });

  it('refuses a service declaring another wire protocol', async () => {
    await expect(start('protocol')).rejects.toThrow(new RegExp(`protocol ${NATIVE_SERVICE_PROTOCOL + 1}`));
  });

  it('fails startup with the abort reason and tears the process down', async () => {
    const controller = new AbortController();
    const reason = new Error('operator cancelled');
    // Real clock on purpose: the abort must land while a real child is mid-startup, which fake timers cannot drive.
    setTimeout(() => controller.abort(reason), 200);
    await expect(start('hang', { signal: controller.signal })).rejects.toBe(reason);
    await expectSocketRemoved();
  });

  it('times out a service that never becomes ready, with its log attached', async () => {
    await expect(start('hang', { startupTimeoutMs: 300 })).rejects.toThrow(/did not become ready within 300 ms[\s\S]*fake service booting/);
  });
});
