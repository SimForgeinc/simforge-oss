import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileRegistryBackend,
  RETENTION_REFS_SCHEMA,
  RetainedReferenceError,
  RetentionRefsRequiredError,
  combineRetentionSources,
  parseRetentionRefs,
  pruneVersions,
  publishVersion,
  retentionSourceFromDocument,
  sha256,
} from '../index.js';
import type { MapClosure, RetentionReferenceSource } from '../index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function registry(): Promise<FileRegistryBackend> {
  const root = await mkdtemp(join(tmpdir(), 'simforge-retention-'));
  roots.push(root);
  return new FileRegistryBackend(`file://${join(root, 'registry')}`);
}

function input(payload: string, extra?: { name: string; bytes: Buffer }) {
  const master = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, extras: { payload } }));
  const files: Record<string, Buffer> = { 'master.gltf': master };
  const members: MapClosure['members'] = { 'master.gltf': { sha256: sha256(master), bytes: master.byteLength } };
  if (extra) {
    files[extra.name] = extra.bytes;
    members[extra.name] = { sha256: sha256(extra.bytes), bytes: extra.bytes.byteLength };
  }
  const closure: MapClosure = { schema: 'map-closure.v1', kind: 'canonical', metadata: { master: true }, members };
  return { closure, files };
}

function staticRefs(digests: Iterable<string>, description = 'test refs'): RetentionReferenceSource {
  const set = new Set(digests);
  return { description, referenced: async (candidates) => new Set(candidates.filter((digest) => set.has(digest))) };
}

/** v1 carries a road file only it uses; v2 (latest) does not. */
async function twoVersions() {
  const backend = await registry();
  const road = Buffer.from('<OpenDRIVE>v1 roads</OpenDRIVE>');
  const shared = Buffer.from('shared-bytes');
  const v1 = await publishVersion(backend, { name: 'retained-map', version: 'v1', ...input('one', { name: 'map.xodr', bytes: road }) });
  await publishVersion(backend, { name: 'retained-map', version: 'v2', ...input('two', { name: 'shared.bin', bytes: shared }) });
  const blobKey = (bytes: Buffer) => { const digest = sha256(bytes); return `blobs/sha256/${digest.slice(0, 2)}/${digest}`; };
  return { backend, v1, roadDigest: sha256(road), roadKey: blobKey(road), v1MasterKey: blobKey(input('one').files['master.gltf']!) };
}

describe('maps prune --gc retention', () => {
  it('refuses to collect garbage without a retention reference source, even as a dry run', async () => {
    const { backend, roadKey } = await twoVersions();
    for (const dryRun of [true, false]) {
      await expect(pruneVersions(backend, { name: 'retained-map', versions: ['v1'], collectGarbage: true, dryRun }))
        .rejects.toBeInstanceOf(RetentionRefsRequiredError);
    }
    await expect(pruneVersions(backend, { name: 'retained-map', keepLatest: true, collectGarbage: true }))
      .rejects.toThrow(/--refs <file\|https-url>.*Nothing was deleted/s);
    // Nothing moved: the version still resolves and its blob is still there.
    expect(await backend.exists('maps/retained-map/v1/closure.json')).toBe(true);
    expect(await backend.exists(roadKey)).toBe(true);
  });

  it('retains unreachable blobs that host records still reference and deletes the rest', async () => {
    const { backend, roadDigest, roadKey, v1MasterKey } = await twoVersions();
    const result = await pruneVersions(backend, {
      name: 'retained-map', versions: ['v1'], collectGarbage: true, retentionRefs: staticRefs([roadDigest], 'revisions'),
    });
    expect(result.removedVersions).toEqual(['v1']);
    expect(result.retainedBlobs).toEqual([roadKey]);
    expect(result.removedBlobs).toEqual([v1MasterKey]);
    expect(result.retentionSource).toBe('revisions');
    expect(await backend.exists(roadKey)).toBe(true);
    expect(await backend.exists(v1MasterKey)).toBe(false);
  });

  it('refuses to prune a version whose closure or release a host record pins', async () => {
    const { backend, v1, roadKey } = await twoVersions();
    for (const digest of [v1.record.closureDigest, v1.record.releaseDigest!]) {
      const error = await pruneVersions(backend, {
        name: 'retained-map', keepLatest: true, collectGarbage: true, retentionRefs: staticRefs([digest]),
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RetainedReferenceError);
      expect((error as RetainedReferenceError).referenced).toEqual([digest]);
      expect(String(error)).toContain('retained-map@v1');
    }
    // Also enforced for a plain (non-gc) version prune when refs are supplied.
    await expect(pruneVersions(backend, {
      name: 'retained-map', versions: ['v1'], retentionRefs: staticRefs([v1.record.closureDigest]),
    })).rejects.toBeInstanceOf(RetainedReferenceError);
    expect(await backend.exists('maps/retained-map/v1/closure.json')).toBe(true);
    expect(await backend.exists(roadKey)).toBe(true);
  });

  it('propagates a failing reference source instead of treating it as "nothing referenced"', async () => {
    const { backend, roadKey } = await twoVersions();
    const broken: RetentionReferenceSource = {
      description: 'unreachable host',
      referenced: async () => { throw new Error('database unavailable'); },
    };
    await expect(pruneVersions(backend, { name: 'retained-map', versions: ['v1'], collectGarbage: true, retentionRefs: broken }))
      .rejects.toThrow('database unavailable');
    expect(await backend.exists(roadKey)).toBe(true);
    expect(await backend.exists('maps/retained-map/v1/closure.json')).toBe(true);
  });

  it('keeps plain version prunes without --gc working without refs', async () => {
    const { backend, roadKey } = await twoVersions();
    const result = await pruneVersions(backend, { name: 'retained-map', versions: ['v1'] });
    expect(result.removedVersions).toEqual(['v1']);
    expect(result.removedBlobs).toEqual([]);
    expect(await backend.exists(roadKey)).toBe(true);
  });
});

describe('retention refs documents', () => {
  const now = Date.parse('2026-09-22T12:00:00.000Z');
  const digest = 'a'.repeat(64);
  const document = { schema: RETENTION_REFS_SCHEMA, generatedAt: '2026-09-22T11:50:00.000Z', source: 'studio:test', digests: [digest] };

  it('parses a valid document and answers membership', async () => {
    const source = retentionSourceFromDocument(parseRetentionRefs(document, 'refs.json'), 'refs.json', { now: () => now });
    expect([...await source.referenced([digest, 'b'.repeat(64)])]).toEqual([digest]);
    expect(source.description).toContain('studio:test');
  });

  it.each([
    [{ ...document, schema: 'other' }, /schema must be/],
    [{ ...document, generatedAt: 'yesterday' }, /generatedAt/],
    [{ ...document, source: ' ' }, /source/],
    [{ ...document, digests: 'x' }, /digests array/],
    [{ ...document, digests: [digest, 'ABC'] }, /digests\[1\]/],
    [[], /JSON object/],
  ])('rejects malformed document %#', (value, message) => {
    expect(() => parseRetentionRefs(value, 'refs.json')).toThrow(message);
  });

  it('rejects stale and future snapshots', () => {
    const stale = parseRetentionRefs({ ...document, generatedAt: '2026-09-22T10:00:00.000Z' }, 'refs.json');
    expect(() => retentionSourceFromDocument(stale, 'refs.json', { now: () => now })).toThrow(/older than 60 min/);
    expect(retentionSourceFromDocument(stale, 'refs.json', { now: () => now, maxAgeMs: 3 * 3600_000 })).toBeDefined();
    const future = parseRetentionRefs({ ...document, generatedAt: '2026-09-22T13:00:00.000Z' }, 'refs.json');
    expect(() => retentionSourceFromDocument(future, 'refs.json', { now: () => now })).toThrow(/in the future/);
  });

  it('combines sources as a union', async () => {
    const combined = combineRetentionSources([staticRefs(['a'.repeat(64)], 'one'), staticRefs(['b'.repeat(64)], 'two')]);
    expect(combined.description).toBe('one + two');
    expect((await combined.referenced(['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)])).size).toBe(2);
  });
});
