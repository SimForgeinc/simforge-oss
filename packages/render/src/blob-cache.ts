import { chmod, stat, utimes } from 'node:fs/promises';
import path from 'node:path';

import { hashFile } from './hash.js';

/**
 * Verification stamps for a content-addressed blob cache shared by jobs,
 * worker restarts, image updates and co-located workers.
 *
 * A blob is hashed exactly once, when it is written (or the first time a
 * pre-existing file is read). Once its bytes match its sha256, the file is
 * made read-only and its mtime is set to a sentinel derived from the digest.
 * Any later write, truncate or replacement moves the mtime (and usually the
 * size), so a later reader proves "these are still the verified bytes" with
 * one `stat` instead of re-hashing gigabytes per job. `SIMFORGE_CACHE_VERIFY=full`
 * restores a full re-hash on every read.
 *
 * The access time is the LRU clock: `touchVerifiedBlob` sets it explicitly on
 * every use (relatime would otherwise update it at most daily).
 */

const STAMP_EPOCH_S = 946_684_800; // 2000-01-01T00:00:00Z
const STAMP_RANGE_S = 31_536_000;

export type BlobVerifyMode = 'stamp' | 'full';

export function blobVerifyMode(env: NodeJS.ProcessEnv = process.env): BlobVerifyMode {
  return env.SIMFORGE_CACHE_VERIFY?.trim() === 'full' ? 'full' : 'stamp';
}

/** Seconds since the epoch the verified file's mtime is pinned to. */
export function blobStampSeconds(sha256: string): number {
  return STAMP_EPOCH_S + (Number.parseInt(sha256.slice(0, 8), 16) % STAMP_RANGE_S);
}

/** `<root>/blobs/sha256/<aa>/<sha256>`: the one on-disk layout for every cached blob. */
export function contentAddressedBlobPath(root: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new Error(`invalid sha256 ${sha256}`);
  return path.join(root, 'blobs', 'sha256', sha256.slice(0, 2), sha256);
}

/** Records that `file` holds exactly `sha256`'s bytes. Call only after hashing it. */
export async function markBlobVerified(file: string, sha256: string, accessedAt = new Date()): Promise<void> {
  await chmod(file, 0o444);
  await utimes(file, accessedAt, blobStampSeconds(sha256));
}

/** Cheap proof that a verified blob was not modified since it was hashed. */
export async function hasBlobStamp(file: string, sha256: string, sizeBytes: number): Promise<boolean> {
  try {
    const info = await stat(file);
    return info.isFile() && info.size === sizeBytes && Math.floor(info.mtimeMs / 1000) === blobStampSeconds(sha256);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** LRU clock: the access time is the last use; the mtime stays the stamp. */
export async function touchVerifiedBlob(file: string, sha256: string, at = new Date()): Promise<void> {
  await utimes(file, at, blobStampSeconds(sha256)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT' && error.code !== 'EPERM' && error.code !== 'EACCES' && error.code !== 'EROFS') throw error;
  });
}

/**
 * True when `file` holds `sha256`/`sizeBytes`. A stamped file is trusted in
 * `stamp` mode; anything else is hashed, and stamped when it matches. A
 * mismatching file is never stamped (the caller replaces it).
 */
export async function verifyCachedBlob(
  file: string,
  sha256: string,
  sizeBytes: number,
  mode: BlobVerifyMode = blobVerifyMode(),
): Promise<boolean> {
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!info.isFile() || info.size !== sizeBytes) return false;
  if (mode === 'stamp' && Math.floor(info.mtimeMs / 1000) === blobStampSeconds(sha256)) {
    await touchVerifiedBlob(file, sha256);
    return true;
  }
  const actual = await hashFile(file);
  if (actual.sha256 !== sha256 || actual.sizeBytes !== sizeBytes) return false;
  await markBlobVerified(file, sha256).catch((error: NodeJS.ErrnoException) => {
    // A read-only packaged closure is still verified; it just cannot carry a stamp.
    if (error.code !== 'EPERM' && error.code !== 'EACCES' && error.code !== 'EROFS') throw error;
  });
  return true;
}
