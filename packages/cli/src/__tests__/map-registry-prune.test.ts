import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRegistryBackend, RETENTION_REFS_SCHEMA, publishVersion, sha256 } from '@simforge-oss/map-registry';
import { afterEach, expect, it, vi } from 'vitest';
import { loadRetentionRefs, registryMapsPrune } from '../commands/map-registry.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function seeded() {
  const root = await mkdtemp(join(tmpdir(), 'simforge-cli-prune-'));
  roots.push(root);
  const url = `file://${join(root, 'registry')}`;
  const backend = new FileRegistryBackend(url);
  const road = Buffer.from('<OpenDRIVE/>');
  for (const [version, payload] of [['v1', 'one'], ['v2', 'two']] as const) {
    const master = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, extras: { payload } }));
    const files: Record<string, Buffer> = { 'master.gltf': master, ...(version === 'v1' ? { 'map.xodr': road } : {}) };
    await publishVersion(backend, {
      name: 'cli-map', version, files,
      closure: {
        schema: 'map-closure.v1', kind: 'canonical', metadata: { master: true },
        members: Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, { sha256: sha256(bytes), bytes: bytes.byteLength }])),
      },
    });
  }
  const roadDigest = sha256(road);
  return { root, url, backend, roadKey: `blobs/sha256/${roadDigest.slice(0, 2)}/${roadDigest}`, roadDigest };
}

it('refuses --gc without --refs and deletes nothing', async () => {
  const { url, backend, roadKey } = await seeded();
  await expect(registryMapsPrune({ reference: 'cli-map@v1', registry: url, gc: true, apply: true, pretty: false }))
    .rejects.toMatchObject({ code: 'retention_refs_required' });
  expect(await backend.exists('maps/cli-map/v1/closure.json')).toBe(true);
  expect(await backend.exists(roadKey)).toBe(true);
});

it('keeps blobs the refs document names when collecting garbage', async () => {
  const { root, url, backend, roadKey, roadDigest } = await seeded();
  const refs = join(root, 'refs.json');
  await writeFile(refs, JSON.stringify({
    schema: RETENTION_REFS_SCHEMA, generatedAt: new Date().toISOString(), source: 'test-host', digests: [roadDigest],
  }));
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await registryMapsPrune({ reference: 'cli-map@v1', registry: url, gc: true, refs: [refs], apply: true, pretty: false });
  const report = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
  expect(report).toMatchObject({ applied: true, removedBlobCount: 1, retainedBlobCount: 1 });
  expect(report.retentionSource).toContain('test-host');
  expect(await backend.exists(roadKey)).toBe(true);
  expect(await backend.exists('maps/cli-map/v1/closure.json')).toBe(false);
});

it('fails loudly on unreadable, malformed, stale or unreachable refs', async () => {
  const { root } = await seeded();
  await expect(loadRetentionRefs([join(root, 'missing.json')])).rejects.toMatchObject({ code: 'retention_refs_unavailable' });
  const bad = join(root, 'bad.json');
  await writeFile(bad, '{"schema":"simforge.retention-refs.v1","generatedAt":"2026-01-01T00:00:00Z","source":"x","digests":[]}');
  await expect(loadRetentionRefs([bad])).rejects.toThrow(/older than 60 min/);
  const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }));
  await expect(loadRetentionRefs(['https://studio.example/refs'], { fetchImpl: fetchImpl as typeof fetch }))
    .rejects.toThrow(/HTTP 503/);
  const ok = vi.fn(async () => new Response(JSON.stringify({
    schema: RETENTION_REFS_SCHEMA, generatedAt: new Date().toISOString(), source: 'remote', digests: ['a'.repeat(64)],
  })));
  const source = await loadRetentionRefs(['https://studio.example/refs'], { fetchImpl: ok as typeof fetch, token: 't0k' });
  expect([...await source.referenced(['a'.repeat(64)])]).toEqual(['a'.repeat(64)]);
  expect((ok.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ authorization: 'Bearer t0k' });
});
