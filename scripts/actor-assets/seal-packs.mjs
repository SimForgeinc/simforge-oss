#!/usr/bin/env node
// The CARLA-derived model packs (catalog/vehicles-carla, catalog/pedestrians-carla)
// live in git as manifests and attribution only; their bytes live in the
// content-addressed actor store (closures.mjs). Each pack is one closure:
//   members = models/** + the sidecars that travel with the models:
//             ATTRIBUTION.json (the CC-BY licence and per-asset attribution),
//             catalog-models.json and manifest.json (what the renderer loads
//             beside the models). Authoring-only JSON (carla-*.json,
//             material-tints.json, assembly-stats.json) stays in git only.
//   licenses = every member's licence, bound by the digest: each model's
//             from ATTRIBUTION.json (its per-asset `license` + `attribution`),
//             the SimForge-authored sidecars Apache-2.0. A model without an
//             attribution entry fails the seal.
//   catalog/<pack>/closure.json    the canonical closure document (git)
//   catalog/closures.lock.json     name -> {sha256, bytes} of that document
//
//   node scripts/actor-assets/seal-packs.mjs seal [--pack <name>]
//       Re-seal after a pack changed. A member is hashed from the working tree
//       when present (models/ is gitignored: the conversion tools write
//       there); a model absent locally keeps its identity from the current
//       closure.json, whose bytes are already in the store. Writes
//       closure.json and the lock.
//   node scripts/actor-assets/seal-packs.mjs publish [--pack <name>] [--bucket <b>] [--profile <p>]
//       Uploads (aws CLI) every member blob and the closure document the
//       bucket lacks, plus catalog/<pack>/ATTRIBUTION.json beside the
//       browser copies, then fetches every member back through the public
//       origin and checks its sha256. Needs write access to the public
//       asset bucket; never prints credentials.
//   node scripts/actor-assets/seal-packs.mjs check
//       Offline: closure.json hashes to the lock, each pack-root JSON in the
//       tree equals its member, every model a sidecar binds is a member, and
//       no model bytes are tracked by git. Runs in the merge gate.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOCK_PATH, LOCK_SCHEMA, assetsOrigin, closureUrl, hashFile, parseClosure, pullBlob, readLock, sealClosure, sha256Bytes,
  unlicensedMembers,
} from './closures.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CATALOG_DIR = path.join(REPO_ROOT, 'catalog');
export const PACKS = ['pedestrians-carla', 'vehicles-carla'];
const DEFAULT_BUCKET = 'simforge-maps-public';

function option(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function packDir(pack) {
  return path.join(CATALOG_DIR, pack);
}

function walk(root, relative = '') {
  const out = [];
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** The sidecars that travel with a pack's models (see the header). */
const SIDECARS = ['ATTRIBUTION.json', 'catalog-models.json', 'manifest.json'];
function sidecarPaths(pack) {
  const present = SIDECARS.filter((name) => existsSync(path.join(packDir(pack), name)));
  if (!present.includes('ATTRIBUTION.json')) throw new Error(`${pack} has no ATTRIBUTION.json; CC-BY models cannot travel without their attribution`);
  return present;
}

function currentClosure(pack) {
  const file = path.join(packDir(pack), 'closure.json');
  if (!existsSync(file)) return null;
  const bytes = readFileSync(file);
  return parseClosure(bytes, { sha256: sha256Bytes(bytes), bytes: bytes.byteLength });
}

/** Every model file a pack's sidecars name (manifest `file`, catalog-models `glbPath`s). */
function boundModels(pack) {
  const found = new Set();
  const visit = (value) => {
    if (typeof value === 'string') {
      if (/^models\/[^\s]+\.glb$/u.test(value)) found.add(value);
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(visit);
    }
  };
  for (const name of ['manifest.json', 'catalog-models.json']) {
    const file = path.join(packDir(pack), name);
    if (existsSync(file)) visit(JSON.parse(readFileSync(file, 'utf8')));
  }
  return found;
}

/** Every member's licence: models from the pack's ATTRIBUTION.json, sidecars Apache-2.0 (SimForge-authored metadata). */
function packLicenses(pack, memberPaths) {
  const attribution = JSON.parse(readFileSync(path.join(packDir(pack), 'ATTRIBUTION.json'), 'utf8'));
  const byFile = new Map();
  const assets = attribution.assets ?? {};
  for (const [key, entry] of Array.isArray(assets) ? assets.map((entry) => [entry.file, entry]) : Object.entries(assets)) {
    byFile.set(key.startsWith('models/') ? key : `models/${key}.glb`, entry);
  }
  const licenses = {};
  for (const memberPath of memberPaths) {
    if (!memberPath.startsWith('models/')) {
      licenses[memberPath] = { license: 'Apache-2.0', source: 'simforge', attribution: `SimForge catalog metadata (${pack})` };
      continue;
    }
    const entry = byFile.get(memberPath);
    if (!entry?.license || !entry.attribution) throw new Error(`${pack}: ${memberPath} has no licence and attribution in ATTRIBUTION.json`);
    licenses[memberPath] = { license: entry.license, attribution: entry.attribution, source: attribution.source ?? 'carla-0.10.0-ue5' };
  }
  return licenses;
}

async function seal(packs) {
  const lock = existsSync(LOCK_PATH) ? readLock() : { schema: LOCK_SCHEMA, origin: assetsOrigin(), closures: {} };
  for (const pack of packs) {
    const dir = packDir(pack);
    const previous = currentClosure(pack);
    const members = {};
    for (const name of sidecarPaths(pack)) members[name] = await hashFile(path.join(dir, name));
    const localModels = existsSync(path.join(dir, 'models')) ? walk(path.join(dir, 'models')).map((rel) => `models/${rel}`) : [];
    for (const rel of localModels) members[rel] = await hashFile(path.join(dir, rel));
    for (const [memberPath, member] of previous?.members ?? []) {
      if (memberPath.startsWith('models/') && !(memberPath in members)) members[memberPath] = member;
    }
    for (const model of boundModels(pack)) {
      if (!(model in members)) throw new Error(`${pack}: a sidecar binds ${model}, which is neither in the working tree nor in the current closure`);
    }
    const sealed = sealClosure(members, { licenses: packLicenses(pack, Object.keys(members)) });
    await writeFile(path.join(dir, 'closure.json'), sealed.bytes);
    const count = Object.keys(members).length;
    const total = Object.values(members).reduce((sum, member) => sum + member.bytes, 0);
    lock.closures[pack] = {
      sha256: sealed.sha256,
      bytes: sealed.size,
      document: `${pack}/closure.json`,
      members: count,
      memberBytes: total,
    };
    process.stdout.write(`${pack}\t${sealed.sha256}\t${count} members\t${(total / 1048576).toFixed(1)} MiB\n`);
  }
  const ordered = Object.fromEntries(Object.entries(lock.closures).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(LOCK_PATH, `${JSON.stringify({ ...lock, closures: ordered }, null, 2)}\n`);
}

function aws(args, { profile, input } = {}) {
  const env = { ...process.env, ...(profile ? { AWS_PROFILE: profile } : {}), AWS_PAGER: '' };
  const result = spawnSync('aws', args, { env, encoding: 'utf8', input, maxBuffer: 1 << 26 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: (result.stderr ?? '').replace(/(AKIA|ASIA)[A-Z0-9]{16}/gu, '<key>') };
}

function remoteExists(bucket, key, profile) {
  const result = aws(['s3api', 'head-object', '--bucket', bucket, '--key', key, '--query', 'ContentLength', '--output', 'text'], { profile });
  if (result.status === 0) return Number(result.stdout.trim());
  if (/Not Found|404|NoSuchKey/u.test(result.stderr)) return null;
  throw new Error(`head-object s3://${bucket}/${key} failed: ${result.stderr.trim().split('\n').pop()}`);
}

function upload(bucket, key, file, contentType, cacheControl, profile) {
  const result = aws(['s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', file, '--content-type', contentType,
    '--cache-control', cacheControl, '--checksum-algorithm', 'SHA256', '--output', 'text', '--query', 'ChecksumSHA256'], { profile });
  if (result.status !== 0) throw new Error(`put-object s3://${bucket}/${key} failed: ${result.stderr.trim().split('\n').pop()}`);
}

async function publish(packs, argv) {
  const bucket = option(argv, '--bucket', DEFAULT_BUCKET);
  const profile = option(argv, '--profile', process.env.AWS_PROFILE);
  const lock = readLock();
  const origin = assetsOrigin(option(argv, '--origin', lock.origin));
  const immutable = 'public, max-age=31536000, immutable';
  for (const pack of packs) {
    const dir = packDir(pack);
    const pin = lock.closures[pack];
    const documentBytes = await readFile(path.join(dir, 'closure.json'));
    const closure = parseClosure(documentBytes, pin);
    let uploaded = 0;
    let present = 0;
    for (const [memberPath, member] of closure.members) {
      const key = `actor-assets/blobs/sha256/${member.sha256.slice(0, 2)}/${member.sha256}`;
      const size = remoteExists(bucket, key, profile);
      if (size === member.bytes) { present += 1; continue; }
      if (size !== null) throw new Error(`s3://${bucket}/${key} exists with ${size} bytes, not ${member.bytes}; refusing to overwrite a content-addressed blob`);
      const local = path.join(dir, memberPath);
      if (!existsSync(local)) throw new Error(`${pack} member ${memberPath} (${member.sha256}) is in neither the bucket nor the working tree`);
      const actual = await hashFile(local);
      if (actual.sha256 !== member.sha256) throw new Error(`${local} no longer hashes to its sealed identity; re-run seal`);
      upload(bucket, key, local, 'application/octet-stream', immutable, profile);
      uploaded += 1;
    }
    const documentKey = `actor-assets/closures/${pin.sha256}.json`;
    const documentSize = remoteExists(bucket, documentKey, profile);
    if (documentSize === null) {
      const scratch = await mkdtemp(path.join(tmpdir(), 'seal-packs-'));
      const file = path.join(scratch, 'closure.json');
      await writeFile(file, documentBytes);
      upload(bucket, documentKey, file, 'application/json', immutable, profile);
      await rm(scratch, { recursive: true, force: true });
    } else if (documentSize !== pin.bytes) {
      throw new Error(`s3://${bucket}/${documentKey} exists with ${documentSize} bytes, not ${pin.bytes}`);
    }
    // The browser-facing copies under catalog/<pack>/models carry their licence beside them.
    upload(bucket, `catalog/${pack}/ATTRIBUTION.json`, path.join(dir, 'ATTRIBUTION.json'), 'application/json', 'public, max-age=3600', profile);
    process.stdout.write(`${pack}: ${uploaded} blobs uploaded, ${present} already present; verifying through ${origin}\n`);

    // Read everything back through the public origin into a throwaway cache.
    const scratch = await mkdtemp(path.join(tmpdir(), 'seal-verify-'));
    try {
      const response = await fetch(closureUrl(pin.sha256, origin));
      if (!response.ok) throw new Error(`${closureUrl(pin.sha256, origin)} -> HTTP ${response.status}`);
      const served = Buffer.from(await response.arrayBuffer());
      if (sha256Bytes(served) !== pin.sha256) throw new Error(`the origin serves a different closure document for ${pin.sha256}`);
      const entries = [...closure.members.values()];
      let cursor = 0;
      await Promise.all(Array.from({ length: 8 }, async () => {
        while (cursor < entries.length) {
          const member = entries[cursor++];
          await pullBlob(member, { origin, cacheDir: scratch });
        }
      }));
      process.stdout.write(`${pack}: closure ${pin.sha256} and all ${entries.length} members verify by sha256 through ${origin}\n`);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

function trackedFiles(prefix) {
  const result = spawnSync('git', ['ls-files', '-z', '--', prefix], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return result.stdout.split('\0').filter(Boolean);
}

async function check() {
  const problems = [];
  const lock = readLock();
  for (const pack of PACKS) {
    const pin = lock.closures[pack];
    if (!pin) { problems.push(`${pack}: not pinned in ${path.relative(REPO_ROOT, LOCK_PATH)}`); continue; }
    const documentFile = path.join(packDir(pack), 'closure.json');
    let closure;
    try {
      closure = parseClosure(readFileSync(documentFile), pin);
    } catch (error) {
      problems.push(`${pack}: ${path.relative(REPO_ROOT, documentFile)} does not match the lock (${error.message}); run seal-packs.mjs seal`);
      continue;
    }
    for (const name of sidecarPaths(pack)) {
      const member = closure.members.get(name);
      const bytes = readFileSync(path.join(packDir(pack), name));
      if (!member) problems.push(`${pack}: ${name} is not a closure member; run seal-packs.mjs seal`);
      else if (sha256Bytes(bytes) !== member.sha256) problems.push(`${pack}: ${name} changed since the closure was sealed; run seal-packs.mjs seal and publish`);
    }
    for (const [memberPath] of closure.members) {
      if (!memberPath.startsWith('models/') && !existsSync(path.join(packDir(pack), memberPath))) {
        problems.push(`${pack}: closure member ${memberPath} is missing from git`);
      }
    }
    for (const model of boundModels(pack)) {
      if (!closure.members.has(model)) problems.push(`${pack}: a sidecar binds ${model}, which the closure does not carry`);
    }
    if (!closure.members.has('ATTRIBUTION.json')) problems.push(`${pack}: the closure does not carry ATTRIBUTION.json (CC-BY attribution must travel with the models)`);
    const unlicensed = unlicensedMembers(closure);
    if (unlicensed.length) problems.push(`${pack}: ${unlicensed.length} member(s) have no confirmed licence in the closure (${unlicensed.slice(0, 3).join(', ')}); a public pack may not carry them`);
    if (pin.members !== closure.members.size) problems.push(`${pack}: the lock records ${pin.members} members, the closure has ${closure.members.size}`);
  }
  // The render closure is pinned in several places; they must name one closure.
  const actors = lock.closures.actors;
  const pins = [
    ['packages/render/src/native/actor-assets.ts', /PINNED_ACTOR_ASSETS_DIGEST = '([0-9a-f]{64})'/u, /PINNED_ACTOR_ASSETS_SIZE_BYTES = (\d+)/u],
    ['native/crates/simforge-assets/src/lib.rs', /PINNED_ACTOR_CLOSURE: Pin = Pin \{\s*sha256: "([0-9a-f]{64})"/u, /PINNED_ACTOR_CLOSURE: Pin = Pin \{[^}]*bytes: (\d+)/u],
    // The release stack config names the digest only; its size check is the lock's.
    ['config/simforge-oss-stack.json', /"actorAssets":\s*\{[^}]*"digest":\s*"([0-9a-f]{64})"/u, null],
  ];
  if (!actors) problems.push(`the lock does not pin the render closure (actors)`);
  for (const [file, digestPattern, sizePattern] of actors ? pins : []) {
    const source = existsSync(path.join(REPO_ROOT, file)) ? readFileSync(path.join(REPO_ROOT, file), 'utf8') : '';
    const digest = digestPattern.exec(source)?.[1];
    const size = sizePattern ? Number(sizePattern.exec(source)?.[1]) : actors.bytes;
    if (digest !== actors.sha256 || size !== actors.bytes) {
      problems.push(`${file} pins the render closure as ${digest ?? '(none)'}/${size}, the lock as ${actors.sha256}/${actors.bytes}`);
    }
  }
  const tracked = trackedFiles(path.relative(REPO_ROOT, CATALOG_DIR)).filter((file) => /\.(glb|gltf|bin|fbx|usdz?|ktx2|png|jpe?g|webp)$/iu.test(file));
  for (const file of tracked) problems.push(`${file}: model/texture bytes are tracked by git; they belong in the content-addressed store (seal-packs.mjs)`);
  if (problems.length) {
    process.stderr.write(`catalog packs: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(`catalog packs: ${PACKS.map((pack) => `${pack} ${lock.closures[pack].sha256.slice(0, 8)}`).join(', ')} consistent\n`);
}

async function main(argv) {
  const [command, ...rest] = argv;
  const only = option(rest, '--pack', null);
  const packs = only ? [only] : PACKS;
  for (const pack of packs) if (!PACKS.includes(pack)) throw new Error(`unknown pack ${pack}; packs: ${PACKS.join(', ')}`);
  if (command === 'seal') return seal(packs);
  if (command === 'publish') return publish(packs, rest);
  if (command === 'check') return check();
  process.stderr.write('usage: seal-packs.mjs seal|publish|check [--pack <name>] [--bucket <b>] [--profile <p>]\n');
  process.exit(64);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`seal-packs: ${error.message}\n`);
  process.exit(1);
});
