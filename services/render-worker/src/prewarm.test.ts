import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { RENDER_WORKER_CONTROL_V2_SCHEMA, contentAddressedBlobPath, type PrewarmSet } from '@simforge-oss/render';

import { BlobStore, listCachedBlobs } from './blob-store.js';
import { Prewarmer } from './prewarm.js';
import type { RenderControlTransport } from './transport.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

it('warms every published set once, reports readiness, and collects blobs no set wants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prewarm-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const contents = new Map<string, string>();
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    const body = contents.get(request.url!.slice(1));
    if (body === undefined) response.writeHead(404).end();
    else response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const member = (relativePath: string, body: string) => {
    contents.set(sha(body), body);
    return { relativePath, sha256: sha(body), sizeBytes: body.length };
  };
  const shared = member('geometry.bin', 'shared geometry');
  const sets: Array<{ set: PrewarmSet; members: ReturnType<typeof member>[] }> = [
    { set: { setId: 'set_a', mapVersionId: 'usmap_a', mapId: 'a', closureSha256: sha('a'), objectCount: 3, byteLength: 0, createdAt: '2026-09-20' },
      members: [shared, member('master.gltf', 'master a'), member('images/x.ktx2', 'texture x')] },
    { set: { setId: 'set_b', mapVersionId: 'usmap_b', mapId: 'b', closureSha256: sha('b'), objectCount: 2, byteLength: 0, createdAt: '2026-09-21' },
      members: [shared, member('master.gltf', 'master b')] },
  ];
  const signed: number[] = [];
  const reports: unknown[] = [];
  const transport = {
    prewarmMembers: async ({ setId, after }: { setId: string; after: string | null }) => {
      const all = sets.find((entry) => entry.set.setId === setId)!.members;
      // Two-member pages exercise pagination.
      const start = after === null ? 0 : Number(after);
      const page = all.slice(start, start + 2);
      return { schema: RENDER_WORKER_CONTROL_V2_SCHEMA, type: 'worker.prewarm-members', members: page, next: start + 2 < all.length ? String(start + 2) : null };
    },
    blobUrls: async ({ sha256s }: { sha256s: string[] }) => {
      signed.push(sha256s.length);
      return { schema: RENDER_WORKER_CONTROL_V2_SCHEMA, type: 'worker.blob-urls', downloads: Object.fromEntries(sha256s.map((digest) => [digest, { url: `${origin}/${digest}`, headers: {} }])) };
    },
    reportCacheStatus: async (request: { cache: unknown }) => {
      reports.push(request.cache);
      return { schema: RENDER_WORKER_CONTROL_V2_SCHEMA, type: 'worker.cache-status' };
    },
  } as unknown as RenderControlTransport;

  // A blob no published set wants, unused for longer than the grace period.
  const stale = 'stale blob';
  const stalePath = contentAddressedBlobPath(join(root, 'cache'), sha(stale));
  await mkdir(join(stalePath, '..'), { recursive: true });
  await writeFile(stalePath, stale);
  const { utimes } = await import('node:fs/promises');
  await utimes(stalePath, new Date(Date.now() - 10 * 86_400_000), new Date(Date.now() - 10 * 86_400_000));

  const store = new BlobStore({ root: join(root, 'cache'), log: () => undefined });
  const prewarmer = new Prewarmer(store, transport, {
    enabled: true, intervalMs: 600_000, pollMs: 120_000, budgetBytes: 1024 ** 3, minFreeBytes: 0,
    unwantedGraceMs: 86_400_000, actorAssets: false,
  }, () => 'uswr_test', () => undefined);
  const manifest = { schema: RENDER_WORKER_CONTROL_V2_SCHEMA, type: 'worker.prewarm-manifest' as const, generation: sha('gen'), sets: sets.map((entry) => entry.set) };

  await prewarmer.cycle(manifest, AbortSignal.timeout(10_000));
  expect(requests).toBe(4); // shared geometry fetched once for both sets
  expect(prewarmer.status()).toMatchObject({ state: 'ready', maps: { ready: 2, total: 2 }, blobs: { cached: 4, wanted: 4 } });
  const cached = (await listCachedBlobs(join(root, 'cache'))).map((entry) => entry.sha256);
  expect(cached).not.toContain(sha(stale));
  expect(cached).toHaveLength(4);

  // Nothing new published: a second pass downloads nothing and re-reads no member pages from disk-cached lists.
  await prewarmer.cycle(manifest, AbortSignal.timeout(10_000));
  expect(requests).toBe(4);
  expect(reports.length).toBeGreaterThan(0);
});
