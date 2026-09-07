/**
 * Content digests.
 *
 * Every bundle pins the bytes it was built from, and every gate result is only meaningful
 * against a specific reconstruction, so hashing is on the critical path of both import and
 * qualification. Streaming rather than buffering: NuRec packages are gigabytes.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import { deferred } from './deferred.js';

/** Streaming sha256 of a file, lowercase hex. */
export function sha256File(filePath: string): Promise<string> {
  const { promise, resolve, reject } = deferred<string>();
  const hash = createHash('sha256');
  createReadStream(filePath)
    .on('data', (chunk) => hash.update(chunk))
    .on('error', reject)
    .on('end', () => resolve(hash.digest('hex')));
  return promise;
}
