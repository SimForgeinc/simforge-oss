#!/usr/bin/env node
// Materializes the pinned actor-appearance closure for a packaged build:
//   <out>/closures/<digest>.json       the closure document (identity = its sha256)
//   <out>/blobs/sha256/<xx>/<sha256>   every member's bytes
// Files already present with the declared sha256/size are kept, so a cached
// output directory needs no network. Anything else is downloaded from the
// public origin (or --base-url) and verified before it is put in place.
//
//   node packages/render/scripts/fetch-actor-closure.mjs --out <dir> [--base-url <origin>]
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PINNED_DIGEST = '18a0289bcce82ad0742b5d5d47cce5dc905397cd015fac22c509662afdf6d058';
const PINNED_SIZE_BYTES = 7912;
const DEFAULT_BASE_URL = 'https://da3tufozhdsvl.cloudfront.net';
const CLOSURE_SCHEMA = 'simforge.actor-assets-closure/v1';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    if (fallback === undefined) throw new Error(`${name} is required`);
    return fallback;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

async function fileDigest(file) {
  const hash = createHash('sha256');
  let bytes = 0;
  await pipeline(Readable.from(await readFile(file)), async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk);
      bytes += chunk.byteLength;
    }
  });
  return { sha256: hash.digest('hex'), bytes };
}

async function verified(file, expected) {
  try {
    const stats = await stat(file);
    if (!stats.isFile() || stats.size !== expected.bytes) return false;
  } catch {
    return false;
  }
  const actual = await fileDigest(file);
  return actual.sha256 === expected.sha256 && actual.bytes === expected.bytes;
}

async function download(url, destination, expected) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`${url} returned ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { mode: 0o644 }));
  const actual = await fileDigest(temporary);
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
    await rm(temporary, { force: true });
    throw new Error(`${url}: expected ${expected.sha256}/${expected.bytes}, got ${actual.sha256}/${actual.bytes}`);
  }
  await rename(temporary, destination);
}

async function ensure(url, destination, expected) {
  if (await verified(destination, expected)) return false;
  await download(url, destination, expected);
  return true;
}

const outputRoot = path.resolve(option('--out'));
const baseUrl = option('--base-url', DEFAULT_BASE_URL).replace(/\/+$/u, '');
const closurePath = path.join(outputRoot, 'closures', `${PINNED_DIGEST}.json`);
const closureExpected = { sha256: PINNED_DIGEST, bytes: PINNED_SIZE_BYTES };
let downloaded = 0;
if (await ensure(`${baseUrl}/actor-assets/closures/${PINNED_DIGEST}.json`, closurePath, closureExpected)) downloaded += 1;

const closure = JSON.parse(await readFile(closurePath, 'utf8'));
if (closure.schema !== CLOSURE_SCHEMA || !closure.members || typeof closure.members !== 'object') {
  throw new Error(`${closurePath} is not a ${CLOSURE_SCHEMA} document`);
}
const members = Object.entries(closure.members);
let totalBytes = 0;
for (const [memberPath, member] of members) {
  if (typeof member?.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(member.sha256) || !Number.isInteger(member?.bytes)) {
    throw new Error(`closure member ${memberPath} has an invalid declaration`);
  }
  const relative = path.join('blobs', 'sha256', member.sha256.slice(0, 2), member.sha256);
  if (await ensure(`${baseUrl}/${relative.split(path.sep).join('/')}`, path.join(outputRoot, relative), member)) downloaded += 1;
  totalBytes += member.bytes;
}
process.stdout.write(`${JSON.stringify({ digest: PINNED_DIGEST, members: members.length, bytes: totalBytes, downloaded, out: outputRoot })}\n`);
