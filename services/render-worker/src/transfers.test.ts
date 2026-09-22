import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import type { JobInputTransfer } from '@simforge-oss/render';

import { BlobStore } from './blob-store.js';
import { downloadInputs, type InputDownloadProgress } from './transfers.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

async function fixture(handler: (request: IncomingMessage, response: ServerResponse, body: Buffer) => void | boolean) {
  const root = await mkdtemp(join(tmpdir(), 'render-inputs-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bodies = new Map<string, Buffer>();
  const requests: { url: string; range?: string }[] = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url!, ...(request.headers.range ? { range: request.headers.range } : {}) });
    const body = bodies.get(request.url!.split('?')[0]!);
    if (!body) { response.writeHead(404).end(); return; }
    if (handler(request, response, body) === true) return;
    const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      response.writeHead(206, { 'content-length': body.length - start }).end(body.subarray(start));
    } else {
      response.writeHead(200, { 'content-length': body.length }).end(body);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind TCP');
  const origin = `http://127.0.0.1:${address.port}`;
  const input = (inputId: string, content: string | Buffer, withUrl = true): JobInputTransfer => {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    bodies.set(`/${inputId}`, bytes);
    return { inputId, sha256: sha(bytes), sizeBytes: bytes.length, ...(withUrl ? { download: { url: `${origin}/${inputId}`, headers: {} } } : {}) };
  };
  const store = (options: Partial<ConstructorParameters<typeof BlobStore>[0]> = {}) => new BlobStore({ root: join(root, 'cache'), log: () => undefined, ...options });
  return { root, origin, requests, input, store };
}

it('fetches misses once and serves every repeat from the content-addressed cache without a request or copy', async () => {
  const f = await fixture(() => undefined);
  const inputs = [f.input('a', 'alpha'), f.input('b', 'bravo'), f.input('c', 'charlie')];
  const store = f.store();
  const progress: InputDownloadProgress[] = [];
  const first = await downloadInputs(inputs, join(f.root, 'w1'), store, AbortSignal.timeout(5000), {
    placement: 'cache', progress: (p) => { progress.push(p); }, log: () => undefined,
  });
  expect(f.requests).toHaveLength(3);
  expect(await readFile(first.get('b')!.path, 'utf8')).toBe('bravo');
  expect(first.get('b')!.path).toBe(store.path(inputs[1]!.sha256));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(progress.at(-1)).toEqual({ completed: 3, total: 3, downloadedBytes: 17, totalBytes: 17 });

  // A second job (fresh store instance = worker restart) downloads nothing.
  const second = await downloadInputs(inputs, join(f.root, 'w2'), f.store(), AbortSignal.timeout(5000), { placement: 'workspace', log: () => undefined });
  expect(f.requests).toHaveLength(3);
  expect(second.summary).toMatchObject({ cacheHits: 3, fetchedBytes: 0 });
  // Workspace placement is a hard link to the verified blob, not a copy.
  const [linked, blob] = await Promise.all([stat(second.get('a')!.path), stat(store.path(inputs[0]!.sha256))]);
  expect(linked.ino).toBe(blob.ino);
});

it('downloads only the inputs the engine selects', async () => {
  const f = await fixture(() => undefined);
  const inputs = [f.input('master', '{"tier":"full"}'), f.input('full', 'full-size texture'), f.input('small', 'small')];
  const result = await downloadInputs(inputs, join(f.root, 'w'), f.store(), AbortSignal.timeout(5000), {
    intent: {} as never,
    selectInputs: async ({ read }) => {
      const master = JSON.parse((await read('master')).toString()) as { tier: string };
      return new Set(['master', master.tier]);
    },
    placement: 'cache',
    log: () => undefined,
  });
  expect([...result.keys()].sort()).toEqual(['full', 'master']);
  expect(f.requests.map((request) => request.url).sort()).toEqual(['/full', '/master']);
});

it('batch-signs inputs the lease sent without a URL, only for cache misses', async () => {
  const f = await fixture(() => undefined);
  const inputs = Array.from({ length: 7 }, (_, index) => f.input(`m${index}`, `member-${index}`, false));
  const store = f.store();
  // Pre-seed two members: they must not be signed.
  await downloadInputs(inputs.slice(0, 2).map((input) => ({ ...input, download: { url: `${f.origin}/${input.inputId}`, headers: {} } })), join(f.root, 'seed'), store, AbortSignal.timeout(5000), { placement: 'cache', log: () => undefined });
  const batches: string[][] = [];
  await downloadInputs(inputs, join(f.root, 'w'), store, AbortSignal.timeout(5000), {
    placement: 'cache',
    log: () => undefined,
    inputUrls: async (ids) => {
      batches.push([...ids]);
      return Object.fromEntries(ids.map((id) => [id, { url: `${f.origin}/${id}`, headers: {} }]));
    },
  });
  expect(batches).toHaveLength(1);
  expect(batches[0]!.sort()).toEqual(['m2', 'm3', 'm4', 'm5', 'm6']);
});

it('rides out dropped connections and resumes a partial download with a range request', async () => {
  let drops = 0;
  const big = Buffer.alloc(256 * 1024, 7);
  const f = await fixture((request, response, body) => {
    if (request.url === '/big' && drops < 2 && !request.headers.range) {
      drops += 1;
      response.writeHead(200, { 'content-length': body.length });
      response.write(body.subarray(0, 64 * 1024), () => setTimeout(() => response.socket?.destroy(), 150));
      return true;
    }
    return false;
  });
  const inputs = [f.input('big', big)];
  const result = await downloadInputs(inputs, join(f.root, 'w'), f.store({ requestIdleTimeoutMs: 2000 }), AbortSignal.timeout(20_000), { placement: 'cache', log: () => undefined });
  expect(sha(await readFile(result.get('big')!.path))).toBe(inputs[0]!.sha256);
  expect(f.requests.some((request) => request.range?.startsWith('bytes='))).toBe(true);
});

it('never fails a download because progress reporting fails', async () => {
  const f = await fixture(() => undefined);
  const inputs = [f.input('a', 'alpha'), f.input('b', 'bravo')];
  const result = await downloadInputs(inputs, join(f.root, 'w'), f.store(), AbortSignal.timeout(5000), {
    placement: 'cache',
    log: () => undefined,
    progress: () => { throw new Error('control plane returned 409: lease_invalid_or_expired'); },
  });
  expect(result.size).toBe(2);
});

it('re-downloads a cached blob whose bytes changed after verification', async () => {
  const f = await fixture(() => undefined);
  const inputs = [f.input('a', 'alpha')];
  const store = f.store();
  await downloadInputs(inputs, join(f.root, 'w1'), store, AbortSignal.timeout(5000), { placement: 'cache', log: () => undefined });
  const blob = store.path(inputs[0]!.sha256);
  await chmod(blob, 0o644);
  await writeFile(blob, 'ALPHA');
  const again = await downloadInputs(inputs, join(f.root, 'w2'), store, AbortSignal.timeout(5000), { placement: 'cache', log: () => undefined });
  expect(await readFile(again.get('a')!.path, 'utf8')).toBe('alpha');
  expect(f.requests).toHaveLength(2);
});

it('rejects duplicate ids before fetching or overwriting any input', async () => {
  const input = { inputId: 'duplicate', sha256: 'a'.repeat(64), sizeBytes: 1, download: { url: 'https://unused.invalid', headers: {} } };
  await expect(downloadInputs([input, input], '/unused', new BlobStore({ root: '/unused' }), new AbortController().signal)).rejects.toThrow('duplicate inputId');
});
