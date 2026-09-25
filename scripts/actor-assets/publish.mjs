// Publishing a closure to the public asset store (aws CLI; never prints
// credentials) and proving it through the public origin. Shared by
// seal-packs.mjs and public-closure.mjs.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { closureUrl, hashFile, pullBlob, sha256Bytes } from './closures.mjs';

export const DEFAULT_BUCKET = 'simforge-maps-public';
const IMMUTABLE = 'public, max-age=31536000, immutable';

function aws(args, profile) {
  const env = { ...process.env, ...(profile ? { AWS_PROFILE: profile } : {}), AWS_PAGER: '' };
  const result = spawnSync('aws', args, { env, encoding: 'utf8', maxBuffer: 1 << 26 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: (result.stderr ?? '').replace(/(AKIA|ASIA)[A-Z0-9]{16}/gu, '<key>') };
}

export function remoteSize(bucket, key, profile) {
  const result = aws(['s3api', 'head-object', '--bucket', bucket, '--key', key, '--query', 'ContentLength', '--output', 'text'], profile);
  if (result.status === 0) return Number(result.stdout.trim());
  if (/Not Found|404|NoSuchKey/u.test(result.stderr)) return null;
  throw new Error(`head-object s3://${bucket}/${key} failed: ${result.stderr.trim().split('\n').pop()}`);
}

export function upload(bucket, key, file, contentType, cacheControl, profile) {
  const result = aws(['s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', file, '--content-type', contentType,
    '--cache-control', cacheControl, '--checksum-algorithm', 'SHA256', '--output', 'text', '--query', 'ChecksumSHA256'], profile);
  if (result.status !== 0) throw new Error(`put-object s3://${bucket}/${key} failed: ${result.stderr.trim().split('\n').pop()}`);
}

/**
 * Uploads every member blob and the closure document the bucket lacks (a
 * content-addressed object that exists with another size is refused, never
 * overwritten), then reads the document and every member back through
 * `origin` and checks each sha256. `localFile(memberPath, member)` returns a
 * local file with the member's bytes, or null when the bucket must already
 * hold it. Returns {uploaded, present}.
 */
export async function publishClosure({ closure, documentBytes, pin, localFile, bucket = DEFAULT_BUCKET, profile, origin, label }) {
  let uploaded = 0;
  let present = 0;
  for (const [memberPath, member] of closure.members) {
    const key = `actor-assets/blobs/sha256/${member.sha256.slice(0, 2)}/${member.sha256}`;
    const size = remoteSize(bucket, key, profile);
    if (size === member.bytes) { present += 1; continue; }
    if (size !== null) throw new Error(`s3://${bucket}/${key} exists with ${size} bytes, not ${member.bytes}; refusing to overwrite a content-addressed blob`);
    const local = await localFile(memberPath, member);
    if (!local || !existsSync(local)) throw new Error(`${label} member ${memberPath} (${member.sha256}) is in neither the bucket nor a local source`);
    const actual = await hashFile(local);
    if (actual.sha256 !== member.sha256) throw new Error(`${local} does not hash to its sealed identity ${member.sha256}`);
    upload(bucket, key, local, 'application/octet-stream', IMMUTABLE, profile);
    uploaded += 1;
  }
  const documentKey = `actor-assets/closures/${pin.sha256}.json`;
  const documentSize = remoteSize(bucket, documentKey, profile);
  if (documentSize === null) {
    const scratch = await mkdtemp(path.join(tmpdir(), 'publish-closure-'));
    try {
      const file = path.join(scratch, 'closure.json');
      await writeFile(file, documentBytes);
      upload(bucket, documentKey, file, 'application/json', IMMUTABLE, profile);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  } else if (documentSize !== pin.bytes) {
    throw new Error(`s3://${bucket}/${documentKey} exists with ${documentSize} bytes, not ${pin.bytes}`);
  }

  const scratch = await mkdtemp(path.join(tmpdir(), 'publish-verify-'));
  try {
    const response = await fetch(closureUrl(pin.sha256, origin));
    if (!response.ok) throw new Error(`${closureUrl(pin.sha256, origin)} -> HTTP ${response.status}`);
    if (sha256Bytes(Buffer.from(await response.arrayBuffer())) !== pin.sha256) throw new Error(`the origin serves a different closure document for ${pin.sha256}`);
    const entries = [...closure.members.values()];
    let cursor = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (cursor < entries.length) await pullBlob(entries[cursor++], { origin, cacheDir: scratch });
    }));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return { uploaded, present };
}
