#!/usr/bin/env node
// Materializes the pinned actor-appearance closure for a packaged build:
//   <out>/closures/<digest>.json       the closure document (identity = its sha256)
//   <out>/blobs/sha256/<xx>/<sha256>   every member's bytes
// Files already present with the declared sha256/size are kept, so a cached
// output directory needs no network. Anything else is taken from a local
// content-addressed root when one is given (`--from`, or
// `SIMFORGE_ACTOR_ASSETS_SOURCE`), else downloaded from the public origin
// (or --base-url) and verified before it is put in place.
//
//   node packages/render/scripts/fetch-actor-closure.mjs --out <dir> [--base-url <origin>] [--from <cas-dir>]
//
// The pinned closure `b4e2576e` carries the CARLA 0.10.0-UE5 vehicle and
// pedestrian geometry and is not on the public origin: until a maintainer
// uploads `closures/<digest>.json` and the 162 blobs it names, this script
// needs `--from` pointed at the generated root (see
// `scripts/actor-assets/complete-closure.mjs`).
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, link, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PINNED_DIGEST = 'b4e2576e711c4dc78666b25c8143c3840db93d7d3073efb0853a7cfd0526d8f6';
const PINNED_SIZE_BYTES = 22969;
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

/** Hard-links, else copies, a verified file from a local content-addressed root. */
async function place(source, destination, expected) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await rm(temporary, { force: true });
  try {
    await link(source, temporary);
  } catch (error) {
    if (!['EXDEV', 'EPERM', 'EMLINK'].includes(error.code)) throw error;
    await copyFile(source, temporary);
  }
  const actual = await fileDigest(temporary);
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
    await rm(temporary, { force: true });
    throw new Error(`${source}: expected ${expected.sha256}/${expected.bytes}, got ${actual.sha256}/${actual.bytes}`);
  }
  await rename(temporary, destination);
}

/**
 * Puts the declared bytes at `destination`: kept if already correct, taken
 * from the local source root when one is configured and holds them, else
 * downloaded. A configured source root that is missing the member is an
 * error rather than a silent fall back to the origin, since the whole point
 * of `--from` is an install that does not depend on the network.
 */
async function ensure(relative, destination, expected) {
  if (await verified(destination, expected)) return 'kept';
  if (sourceRoot) {
    await place(path.join(sourceRoot, relative), destination, expected);
    return 'linked';
  }
  await download(`${baseUrl}/${relative}`, destination, expected);
  return 'downloaded';
}

const outputRoot = path.resolve(option('--out'));
const baseUrl = option('--base-url', DEFAULT_BASE_URL).replace(/\/+$/u, '');
const sourceOption = option('--from', process.env.SIMFORGE_ACTOR_ASSETS_SOURCE ?? '');
const sourceRoot = sourceOption ? path.resolve(sourceOption) : null;
const closureRelative = `closures/${PINNED_DIGEST}.json`;
const closurePath = path.join(outputRoot, 'closures', `${PINNED_DIGEST}.json`);
const closureExpected = { sha256: PINNED_DIGEST, bytes: PINNED_SIZE_BYTES };
const tally = { kept: 0, linked: 0, downloaded: 0 };
// The origin serves the closure document under `actor-assets/`; a local root
// is the generator's own layout, where it sits at `closures/<digest>.json`.
tally[sourceRoot
  ? await ensure(closureRelative, closurePath, closureExpected)
  : await ensure(`actor-assets/${closureRelative}`, closurePath, closureExpected)] += 1;

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
  const relative = `blobs/sha256/${member.sha256.slice(0, 2)}/${member.sha256}`;
  tally[await ensure(relative, path.join(outputRoot, ...relative.split('/')), member)] += 1;
  totalBytes += member.bytes;
}
process.stdout.write(`${JSON.stringify({ digest: PINNED_DIGEST, members: members.length, bytes: totalBytes, ...tally, source: sourceRoot ?? baseUrl, out: outputRoot })}\n`);
