import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { hasBlobStamp } from '@simforge-oss/render';

import { BlobStore, listCachedBlobs } from './blob-store.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** An origin whose responses the test releases by hand. */
async function slowOrigin(body: Buffer) {
  const held: ServerResponse[] = [];
  const requests: { range?: string }[] = [];
  const server = createServer((request, response) => {
    requests.push(request.headers.range ? { range: request.headers.range } : {});
    const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    response.writeHead(range ? 206 : 200, { 'content-length': body.length - start });
    // First half now, the rest when released.
    const middle = Math.max(start, Math.floor(body.length / 2));
    response.write(body.subarray(start, middle));
    held.push(Object.assign(response, { rest: body.subarray(middle) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}/blob`,
    requests,
    release: () => { for (const response of held.splice(0)) response.end((response as ServerResponse & { rest: Buffer }).rest); },
  };
}

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'blob-store-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

it('lets a job join an in-flight prewarm transfer instead of downloading twice', async () => {
  const body = Buffer.alloc(64 * 1024, 3);
  const origin = await slowOrigin(body);
  const store = new BlobStore({ root: await tempRoot(), log: () => undefined });
  const source = { url: async () => ({ url: origin.url, headers: {} }) };
  const half = Math.floor(body.length / 2);
  let prewarmed = 0;
  const prewarm = store.ensure(
    { sha256: sha(body), sizeBytes: body.length, source, priority: 'prewarm', onBytes: (bytes) => { prewarmed += bytes; } },
    AbortSignal.timeout(10_000),
  ).catch((error: unknown) => error);
  // The job arrives once the prewarm transfer holds the origin's first half,
  // not after a fixed sleep: on a loaded machine 100 ms was not always enough
  // for any byte to land, and a transfer with nothing on disk has nothing to resume.
  await vi.waitFor(() => expect(prewarmed).toBe(half), { timeout: 5000, interval: 10 });
  const job = store.ensure({ sha256: sha(body), sizeBytes: body.length, source, priority: 'job' }, AbortSignal.timeout(10_000));
  // Promotion parks the prewarm transfer and resumes it on a job lane from its partial bytes.
  await vi.waitFor(() => expect(origin.requests).toHaveLength(2), { timeout: 5000, interval: 10 });
  origin.release();
  const file = await job;
  // The prewarm caller sees its transfer parked; the bytes arrived for the job.
  expect(String(await prewarm)).toMatch(/parked/);
  expect(sha(await readFile(file))).toBe(sha(body));
  expect(await hasBlobStamp(file, sha(body), body.length)).toBe(true);
  // One fresh transfer and one ranged resume from where it stopped: never two full downloads.
  expect(origin.requests).toEqual([{}, { range: `bytes=${half}-` }]);
});

it('parks prewarm while a job downloads and resumes it from its partial bytes', async () => {
  const body = Buffer.alloc(64 * 1024, 9);
  const origin = await slowOrigin(body);
  const store = new BlobStore({ root: await tempRoot(), log: () => undefined });
  const source = { url: async () => ({ url: origin.url, headers: {} }) };
  const half = Math.floor(body.length / 2);
  let prewarmed = 0;
  const parked = store.ensure(
    { sha256: sha(body), sizeBytes: body.length, source, priority: 'prewarm', onBytes: (bytes) => { prewarmed += bytes; } },
    AbortSignal.timeout(10_000),
  );
  // Park once the first half is on disk (see the join case above for why not a sleep).
  await vi.waitFor(() => expect(prewarmed).toBe(half), { timeout: 5000, interval: 10 });
  store.setMode('job-downloading');
  await expect(parked).rejects.toThrow(/parked/);
  store.setMode('idle');
  const resumed = store.ensure({ sha256: sha(body), sizeBytes: body.length, source, priority: 'prewarm' }, AbortSignal.timeout(10_000));
  await vi.waitFor(() => expect(origin.requests).toHaveLength(2), { timeout: 5000, interval: 10 });
  origin.release();
  expect(sha(await readFile(await resumed))).toBe(sha(body));
  expect(origin.requests).toEqual([{}, { range: `bytes=${half}-` }]);
});

it('halves job lanes on connection failures and fails only after the stall timeout', async () => {
  const events: Record<string, unknown>[] = [];
  const store = new BlobStore({ root: await tempRoot(), jobConcurrency: 8, stallTimeoutMs: 300, log: (event) => events.push(event) });
  const body = Buffer.from('never arrives');
  const source = { url: async () => ({ url: 'http://127.0.0.1:1/unreachable', headers: {} }) };
  await expect(store.ensure({ sha256: sha(body), sizeBytes: body.length, source, priority: 'job' }, AbortSignal.timeout(20_000)))
    .rejects.toThrow(/stalled/);
  expect(store.stats().jobLanes).toBeLessThan(8);
  expect(events.some((event) => event.event === 'blob.lanes')).toBe(true);
}, 30_000);

it('moves the legacy flat cache into the blob layout without re-downloading', async () => {
  const root = await tempRoot();
  const body = Buffer.from('legacy');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, sha(body)), body);
  const store = new BlobStore({ root, log: () => undefined });
  expect(await store.migrateLegacyLayout()).toBe(1);
  expect(await store.has(sha(body), body.length)).toBe(true);
  expect(await hasBlobStamp(store.path(sha(body)), sha(body), body.length)).toBe(true);
  expect((await listCachedBlobs(root)).map((entry) => entry.sha256)).toEqual([sha(body)]);
  expect((await stat(store.path(sha(body)))).mode & 0o222).toBe(0);
});
