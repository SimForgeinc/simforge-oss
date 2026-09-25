#!/usr/bin/env node
// Content-addressed asset closures for repository tooling: tests, the golden
// harness, the catalog generators and the parity scripts. The CLI's
// `simforge assets pull` does the same through the Rust crate
// `simforge-assets`; render workers use packages/render/src/native/actor-assets.ts.
// All three share one origin layout and one cache layout.
//
// Origin (public CDN; SIMFORGE_ACTOR_ASSETS_BASE_URL overrides it):
//   <origin>/actor-assets/closures/<digest>.json    closure document, identity = its sha256
//   <origin>/actor-assets/blobs/sha256/<aa>/<sha256> every member's bytes
// A `file://` origin is a local closure root holding `closures/` and `blobs/` directly.
//
// Cache (SIMFORGE_ACTOR_ASSETS_CACHE_DIR, else $SIMFORGE_CACHE_DIR/actor-assets,
// else $XDG_CACHE_HOME/simforge/actor-assets, else ~/.cache/simforge/actor-assets):
//   blobs/sha256/<aa>/<sha256>   a blob is renamed into place only after it hashes to its name
//   closures/<digest>.json       closure documents, verified the same way
//   trees/<digest>/...           a closure laid out by member path, hard links into blobs/
//
// A closure document may carry a `licenses` table (member -> {license,
// attribution?, source?}); the digest binds it and v1 readers ignore it. A
// public closure has a confirmed licence for every member
// (unlicensedMembers). A closure's catalog-models.json may list catalog ids it
// deliberately does not carry under `withheld` (public-closure.mjs); the render
// refuses those by name (native_actor_model_withheld).
//
// The pins live in oss/catalog/closures.lock.json. Nothing here substitutes
// anything: an asset that cannot be fetched or does not verify is an error
// naming the digest and the URL.
//
//   node oss/scripts/actor-assets/closures.mjs pull <name...|all>   materialize pinned closures, print their directories
//   node oss/scripts/actor-assets/closures.mjs dir <name>            the materialized directory of one pin (pulls if needed)
//   node oss/scripts/actor-assets/closures.mjs blob <sha256> <bytes> fetch one blob, print its cache path
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, copyFile, link, mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const CLOSURE_SCHEMA = 'simforge.actor-assets-closure/v1';
export const LOCK_SCHEMA = 'simforge.asset-closures-lock/v1';
export const DEFAULT_ORIGIN = 'https://da3tufozhdsvl.cloudfront.net';
export const TREE_COMPLETE_MARKER = '.simforge-closure-complete';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LOCK_PATH = path.join(REPO_ROOT, 'catalog', 'closures.lock.json');

const SHA256 = /^[0-9a-f]{64}$/u;

/** A pinned asset is unavailable or is not the pinned bytes. Never caught to substitute something else. */
export class AssetUnavailableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AssetUnavailableError';
    this.code = 'asset_unavailable';
    this.details = details;
  }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function hashFile(file) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

function assertIdentity(identity, what) {
  if (!identity || typeof identity.sha256 !== 'string' || !SHA256.test(identity.sha256)
    || !Number.isInteger(identity.bytes) || identity.bytes < 0) {
    throw new Error(`${what} needs a {sha256, bytes} identity, got ${JSON.stringify(identity)}`);
  }
}

/** The origin root; a trailing `/actor-assets` is folded away, as the render package does. */
export function assetsOrigin(configured = process.env.SIMFORGE_ACTOR_ASSETS_BASE_URL) {
  const base = (configured?.trim() || DEFAULT_ORIGIN).replace(/\/+$/u, '');
  return base.startsWith('file://') ? base : base.replace(/\/actor-assets$/u, '');
}

function prefix(origin) {
  const base = assetsOrigin(origin);
  return base.startsWith('file://') ? base : `${base}/actor-assets`;
}

export function blobUrl(sha256, origin) {
  return `${prefix(origin)}/blobs/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

export function closureUrl(digest, origin) {
  return `${prefix(origin)}/closures/${digest}.json`;
}

export function cacheRoot(env = process.env) {
  const explicit = env.SIMFORGE_ACTOR_ASSETS_CACHE_DIR?.trim();
  if (explicit) return explicit;
  const cache = env.SIMFORGE_CACHE_DIR?.trim();
  if (cache) return path.join(cache, 'actor-assets');
  const xdg = env.XDG_CACHE_HOME?.trim();
  return path.join(xdg || path.join(homedir(), '.cache'), 'simforge', 'actor-assets');
}

export function blobCachePath(sha256, cacheDir = cacheRoot()) {
  return path.join(cacheDir, 'blobs', 'sha256', sha256.slice(0, 2), sha256);
}

function safeMemberPath(memberPath) {
  const parts = memberPath.split('/');
  if (parts.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\\'))) {
    throw new Error(`unsafe closure member path: ${memberPath}`);
  }
  return parts;
}

/** Parses closure document bytes against their declared identity (the digest is the document's sha256). */
export function parseClosure(bytes, declared) {
  assertIdentity(declared, 'closure');
  const digest = sha256Bytes(bytes);
  if (digest !== declared.sha256 || bytes.byteLength !== declared.bytes) {
    throw new AssetUnavailableError(`closure document does not match its pin: expected ${declared.sha256}/${declared.bytes}, got ${digest}/${bytes.byteLength}`, { closure: declared.sha256 });
  }
  const document = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (document.schema !== CLOSURE_SCHEMA || !document.members || typeof document.members !== 'object' || Array.isArray(document.members)) {
    throw new Error(`closure ${digest} is not a ${CLOSURE_SCHEMA} document`);
  }
  const members = new Map();
  for (const [memberPath, member] of Object.entries(document.members).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    safeMemberPath(memberPath);
    assertIdentity(member, `closure ${digest} member ${memberPath}`);
    members.set(memberPath, { sha256: member.sha256, bytes: member.bytes });
  }
  const licenses = parseLicenses(document.licenses, members, digest);
  return { digest, bytes: bytes.byteLength, members, licenses };
}

/** The licence value for a member whose redistribution terms have not been confirmed. */
export const UNCONFIRMED_LICENSE = 'UNCONFIRMED';

/**
 * Optional `licenses` table of a v1 closure (older readers ignore it; the
 * digest binds it): member path -> {license, attribution?, source?}. `license`
 * is an SPDX id (or LicenseRef-*), or UNCONFIRMED while the terms are open.
 */
function parseLicenses(raw, members, digest) {
  const licenses = new Map();
  if (raw === undefined) return licenses;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`closure ${digest}: licenses is not an object`);
  for (const [memberPath, entry] of Object.entries(raw)) {
    if (!members.has(memberPath)) throw new Error(`closure ${digest}: licenses names ${memberPath}, which is not a member`);
    if (!entry || typeof entry.license !== 'string' || entry.license.length === 0) throw new Error(`closure ${digest}: ${memberPath} has no license`);
    for (const key of ['attribution', 'source']) {
      if (entry[key] !== undefined && typeof entry[key] !== 'string') throw new Error(`closure ${digest}: ${memberPath} ${key} is not a string`);
    }
    licenses.set(memberPath, { license: entry.license, ...(entry.attribution ? { attribution: entry.attribution } : {}), ...(entry.source ? { source: entry.source } : {}) });
  }
  return licenses;
}

/** Members a public distribution may not carry: no licence recorded, or UNCONFIRMED. */
export function unlicensedMembers(closure) {
  return [...closure.members.keys()].filter((memberPath) => {
    const license = closure.licenses?.get(memberPath)?.license;
    return !license || license === UNCONFIRMED_LICENSE;
  });
}

/**
 * The canonical closure document for `members` ({path: {sha256, bytes}}) and,
 * optionally, their `licenses` ({path: {license, attribution?, source?}}):
 * its bytes and identity.
 */
export function sealClosure(members, { licenses } = {}) {
  const sorted = {};
  for (const memberPath of Object.keys(members).sort()) {
    safeMemberPath(memberPath);
    assertIdentity(members[memberPath], `member ${memberPath}`);
    sorted[memberPath] = { bytes: members[memberPath].bytes, sha256: members[memberPath].sha256 };
  }
  const document = { schema: CLOSURE_SCHEMA, members: sorted };
  if (licenses) {
    const memberMap = new Map(Object.entries(sorted));
    parseLicenses(licenses, memberMap, '(sealing)');
    document.licenses = Object.fromEntries(Object.keys(licenses).sort().map((memberPath) => {
      const { license, attribution, source } = licenses[memberPath];
      return [memberPath, { license, ...(attribution ? { attribution } : {}), ...(source ? { source } : {}) }];
    }));
  }
  const bytes = Buffer.from(canonicalJson(document));
  return { bytes, sha256: sha256Bytes(bytes), size: bytes.byteLength };
}

/** Downloads `url` to `destination` only if the bytes are `expected`; atomic, read-only. */
async function fetchVerified(url, expected, destination, what) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    if (url.startsWith('file://')) {
      try {
        await copyFile(fileURLToPath(url), temporary);
      } catch (error) {
        throw new AssetUnavailableError(`${what} ${expected.sha256} is not in the local closure root: ${url} (${error.code ?? error.message})`, { sha256: expected.sha256, url });
      }
    } else {
      let response;
      try {
        response = await fetch(url);
      } catch (error) {
        throw new AssetUnavailableError(`${what} ${expected.sha256} could not be fetched from ${url}: ${error.cause?.message ?? error.message}`, { sha256: expected.sha256, url });
      }
      if (!response.ok || !response.body) {
        throw new AssetUnavailableError(`${what} ${expected.sha256} is not served by the origin (HTTP ${response.status}): ${url}`, { sha256: expected.sha256, url, status: response.status });
      }
      const file = await open(temporary, 'w');
      await pipeline(Readable.fromWeb(response.body), file.createWriteStream());
    }
    const actual = await hashFile(temporary);
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
      throw new AssetUnavailableError(`${what} from ${url} does not verify: expected ${expected.sha256}/${expected.bytes}, got ${actual.sha256}/${actual.bytes}`, { sha256: expected.sha256, url });
    }
    await chmod(temporary, 0o444);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** A cached file is reused when its size matches; SIMFORGE_CACHE_VERIFY=full re-hashes it. */
async function cachedValid(file, expected) {
  const stats = await stat(file).catch(() => null);
  if (!stats?.isFile() || stats.size !== expected.bytes) return false;
  if (process.env.SIMFORGE_CACHE_VERIFY !== 'full') return true;
  const actual = await hashFile(file);
  return actual.sha256 === expected.sha256;
}

const inflight = new Map();
function once(key, work) {
  const pending = inflight.get(key);
  if (pending) return pending;
  const promise = work().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/** Fetches one blob by digest into the cache (or proves the cached copy) and returns its path. */
export function pullBlob(identity, { origin, cacheDir = cacheRoot() } = {}) {
  assertIdentity(identity, 'blob');
  const destination = blobCachePath(identity.sha256, cacheDir);
  return once(destination, async () => {
    if (await cachedValid(destination, identity)) return destination;
    await rm(destination, { force: true });
    await fetchVerified(blobUrl(identity.sha256, origin), identity, destination, 'blob');
    return destination;
  });
}

/** Fetches a closure document by digest (cached) and parses it. */
export async function pullClosureDocument(identity, { origin, cacheDir = cacheRoot() } = {}) {
  assertIdentity(identity, 'closure');
  const destination = path.join(cacheDir, 'closures', `${identity.sha256}.json`);
  await once(destination, async () => {
    if (await cachedValid(destination, identity)) return;
    await rm(destination, { force: true });
    await fetchVerified(closureUrl(identity.sha256, origin), identity, destination, 'closure document');
  });
  return { path: destination, closure: parseClosure(await readFile(destination), identity) };
}

async function linkOrCopy(source, target) {
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await link(source, target);
  } catch (error) {
    if (error.code !== 'EXDEV' && error.code !== 'EPERM') throw error;
    await copyFile(source, target);
  }
}

async function treeIsComplete(directory, closure, cacheDir) {
  if (!existsSync(path.join(directory, TREE_COMPLETE_MARKER))) return false;
  for (const [memberPath, member] of closure.members) {
    const file = path.join(directory, ...safeMemberPath(memberPath));
    const [tree, blob] = await Promise.all([stat(file).catch(() => null), stat(blobCachePath(member.sha256, cacheDir)).catch(() => null)]);
    if (!tree?.isFile() || tree.size !== member.bytes) return false;
    if (blob && blob.ino === tree.ino && blob.dev === tree.dev && process.env.SIMFORGE_CACHE_VERIFY !== 'full') continue;
    if ((await hashFile(file)).sha256 !== member.sha256) return false;
  }
  return true;
}

/**
 * Materializes a closure by digest: every member fetched and verified into the
 * blob cache, then laid out once under `<cache>/trees/<digest>/` (hard links,
 * so no extra bytes) and shared by later calls. Returns that directory.
 */
export async function materializeClosure(identity, { origin, cacheDir = cacheRoot(), concurrency = 8, onBlob } = {}) {
  const { closure } = await pullClosureDocument(identity, { origin, cacheDir });
  const directory = path.join(cacheDir, 'trees', closure.digest);
  if (await treeIsComplete(directory, closure, cacheDir)) {
    const now = new Date();
    await utimes(directory, now, now).catch(() => undefined);
    return { directory, closure };
  }
  const entries = [...closure.members];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, entries.length)) }, async () => {
    while (cursor < entries.length) {
      const [memberPath, member] = entries[cursor++];
      await pullBlob(member, { origin, cacheDir });
      onBlob?.(memberPath, member);
    }
  }));
  const temporary = `${directory}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await rm(temporary, { recursive: true, force: true });
  for (const [memberPath, member] of entries) {
    await linkOrCopy(blobCachePath(member.sha256, cacheDir), path.join(temporary, ...safeMemberPath(memberPath)));
  }
  await writeFile(path.join(temporary, TREE_COMPLETE_MARKER), `${closure.digest}\n`);
  await rm(directory, { recursive: true, force: true });
  try {
    await rename(temporary, directory);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    // Another process published the same tree first.
    if (!(await treeIsComplete(directory, closure, cacheDir))) throw error;
  }
  return { directory, closure };
}

/** oss/catalog/closures.lock.json: the closures this repository pins, by name. */
export function readLock(lockPath = LOCK_PATH) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  if (lock.schema !== LOCK_SCHEMA || !lock.closures || typeof lock.closures !== 'object') {
    throw new Error(`${lockPath} is not a ${LOCK_SCHEMA} document`);
  }
  for (const [name, pin] of Object.entries(lock.closures)) assertIdentity(pin, `${lockPath} closure ${name}`);
  return lock;
}

export function lockedClosure(name, lock = readLock()) {
  const pin = lock.closures[name];
  if (!pin) throw new Error(`no closure named ${name} in ${LOCK_PATH}; pinned: ${Object.keys(lock.closures).join(', ')}`);
  return pin;
}

/** The sealed closure of a pack as git records it (`catalog/<pack>/closure.json`), verified against the lock. Offline. */
export function packClosure(name, lock = readLock()) {
  const pin = lockedClosure(name, lock);
  if (!pin.document) throw new Error(`closure ${name} has no document in git`);
  return parseClosure(readFileSync(path.join(path.dirname(LOCK_PATH), pin.document)), pin);
}

/**
 * Synchronous, offline: the directory of a pinned closure already materialized
 * in the cache (marker present, every member at its size). Throws, naming the
 * pull command, when it is not; never fetches.
 */
export function pinnedDirSync(name, { cacheDir = cacheRoot(), lockPath } = {}) {
  const pin = lockedClosure(name, readLock(lockPath));
  const directory = path.join(cacheDir, 'trees', pin.sha256);
  const document = path.join(cacheDir, 'closures', `${pin.sha256}.json`);
  const missing = () => new AssetUnavailableError(
    `closure ${name} (${pin.sha256}) is not materialized in ${cacheDir}; run: node scripts/actor-assets/closures.mjs pull ${name}`,
    { closure: pin.sha256 },
  );
  if (!existsSync(path.join(directory, TREE_COMPLETE_MARKER)) || !existsSync(document)) throw missing();
  const closure = parseClosure(readFileSync(document), pin);
  for (const [memberPath, member] of closure.members) {
    const file = path.join(directory, ...safeMemberPath(memberPath));
    if (!existsSync(file) || statSync(file).size !== member.bytes) throw missing();
  }
  return directory;
}

/** The materialized directory of a pinned closure (e.g. `vehicles-carla`), pulling it if needed. */
export async function pullPinned(name, options = {}) {
  const lock = readLock(options.lockPath);
  const pin = lockedClosure(name, lock);
  const { directory } = await materializeClosure(pin, { origin: options.origin ?? process.env.SIMFORGE_ACTOR_ASSETS_BASE_URL ?? lock.origin, ...options });
  return directory;
}

// ------------------------------------------------------------------ CLI

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'pull') {
    const lock = readLock();
    const names = rest.length === 0 || rest.includes('all') ? Object.keys(lock.closures) : rest;
    for (const name of names) {
      const pin = lockedClosure(name, lock);
      const { directory, closure } = await materializeClosure(pin, { origin: process.env.SIMFORGE_ACTOR_ASSETS_BASE_URL ?? lock.origin });
      const total = [...closure.members.values()].reduce((sum, member) => sum + member.bytes, 0);
      process.stdout.write(`${name}\t${pin.sha256}\t${closure.members.size} members\t${(total / 1048576).toFixed(1)} MiB\t${directory}\n`);
    }
    return;
  }
  if (command === 'dir' && rest.length === 1) {
    process.stdout.write(`${await pullPinned(rest[0])}\n`);
    return;
  }
  if (command === 'blob' && rest.length === 2) {
    process.stdout.write(`${await pullBlob({ sha256: rest[0], bytes: Number(rest[1]) })}\n`);
    return;
  }
  process.stderr.write('usage: closures.mjs pull [name...|all] | dir <name> | blob <sha256> <bytes>\n');
  process.exit(64);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`closures: ${error.message}\n`);
    process.exit(1);
  });
}
