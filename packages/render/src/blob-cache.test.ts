import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { blobStampSeconds, contentAddressedBlobPath, hasBlobStamp, markBlobVerified, verifyCachedBlob } from './blob-cache.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

it('trusts a stamped blob with one stat and re-hashes anything written after the stamp', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'blob-cache-'));
  roots.push(root);
  const file = path.join(root, 'blob');
  await writeFile(file, 'payload');
  expect(await hasBlobStamp(file, sha('payload'), 7)).toBe(false);
  expect(await verifyCachedBlob(file, sha('payload'), 7)).toBe(true); // hashed, then stamped
  expect(await hasBlobStamp(file, sha('payload'), 7)).toBe(true);
  await chmod(file, 0o644);
  await writeFile(file, 'PAYLOAD'); // same size, new bytes, fresh mtime
  expect(await hasBlobStamp(file, sha('payload'), 7)).toBe(false);
  expect(await verifyCachedBlob(file, sha('payload'), 7)).toBe(false);
  await writeFile(file, 'payload');
  await markBlobVerified(file, sha('payload'));
  expect(await verifyCachedBlob(file, sha('payload'), 7, 'full')).toBe(true);
});

it('derives a per-digest stamp and the shared content-addressed layout', () => {
  expect(blobStampSeconds('0'.repeat(64))).not.toBe(blobStampSeconds('f'.repeat(64)));
  expect(contentAddressedBlobPath('/cache', 'ab'.repeat(32))).toBe(`/cache/blobs/sha256/ab/${'ab'.repeat(32)}`);
  expect(() => contentAddressedBlobPath('/cache', '../etc')).toThrow('invalid sha256');
});
