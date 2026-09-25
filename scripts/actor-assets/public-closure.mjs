#!/usr/bin/env node
// The actor closure every render binds, fully attributed: the base render
// closure's catalog and models, plus an ATTRIBUTION.json member covering every
// catalog entry and a `licenses` table covering every member. It is what the
// SDK distributes (`simforge assets pull`) and what hosted renders pin.
//
//   node scripts/actor-assets/public-closure.mjs [--base <digest> --base-bytes <n>] [--publish [--bucket b] [--profile p]]
//
// Licence by the catalog entry's `model.source`:
//   carla-0.10.0-ue5          CC-BY-4.0: the entry's attribution string, and the
//                             title, source and modifications of its model in
//                             the CARLA pack's ATTRIBUTION.json (via
//                             provenance.boundUrl)
//   meshy-refined             CC-BY-4.0, (c) SimForge, Inc., generated with Meshy
//                             (the user's decision of 2026-09-24, flagged for
//                             correction; provenance in tools/meshy/PROVENANCE.json)
//   asset-catalog-procedural  Apache-2.0, SimForge, Inc. (the procedural catalog
//                             geometry of @simforge-oss/asset-catalog)
//   anything else             refused: nothing is published without a licence.
// Members no catalog entry binds are dropped and reported (`excluded`): their
// origin is not recorded, so they are not redistributed. catalog-models.json is
// carried byte for byte, so renders do not change. The result is pinned as the
// lock's `actors`.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOCK_PATH, assetsOrigin, cacheRoot, lockedClosure, materializeClosure, parseClosure, readLock, sealClosure, sha256Bytes,
  unlicensedMembers,
} from './closures.mjs';
import { DEFAULT_BUCKET, publishClosure } from './publish.mjs';

const CATALOG_MEMBER = 'catalog-models.json';
const ATTRIBUTION_MEMBER = 'ATTRIBUTION.json';
const CATALOG_DIR = path.join(path.dirname(LOCK_PATH));
const CC_BY = 'https://creativecommons.org/licenses/by/4.0/';
const APACHE = 'https://www.apache.org/licenses/LICENSE-2.0';
export const MESHY_ATTRIBUTION = '(c) SimForge, Inc. Generated with Meshy (meshy.ai); licensed CC BY 4.0.';
export const MESHY_NOTE = 'Licence and copyright holder recorded per the user decision of 2026-09-24 (CC BY 4.0, SimForge, Inc., generated with Meshy); flagged for the user to confirm or correct.';

function option(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

/** Every member path an entry binds (its model and its animation clips). */
function boundPaths(entry) {
  const model = entry.model ?? entry;
  return [model.glbPath, ...Object.values(entry.animations ?? {}).map((animation) => animation.glbPath)];
}

/** The CARLA packs' per-model attribution, keyed by pack-relative file (`<pack>/models/x.glb`). */
export function carlaPackRecords(catalogDir = CATALOG_DIR) {
  const records = new Map();
  for (const pack of ['vehicles-carla', 'pedestrians-carla']) {
    const file = path.join(catalogDir, pack, 'ATTRIBUTION.json');
    if (!existsSync(file)) throw new Error(`${file} is missing`);
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    const assets = Array.isArray(doc.assets) ? doc.assets.map((item) => [item.file, item]) : Object.entries(doc.assets).map(([stem, item]) => [`models/${stem}.glb`, item]);
    for (const [memberPath, item] of assets) {
      const modifications = Array.isArray(item.modifications) ? item.modifications : [item.modifications].filter(Boolean);
      records.set(`${pack}/${memberPath}`, {
        title: item.title ?? item.id ?? path.basename(memberPath, '.glb'),
        license: item.license ?? doc.license,
        license_url: item.licenseUrl ?? item.license_url ?? doc.licenseUrl ?? doc.license_url ?? CC_BY,
        attribution: item.attribution,
        source: item.source ?? (item.source_packages ? `${doc.source}: ${item.source_packages.join('; ')}` : doc.source),
        modifications,
      });
    }
  }
  return records;
}

/** Attribution record for one catalog entry, or an error naming why it cannot be published. */
function recordFor(catalogId, entry, carla) {
  const model = entry.model ?? entry;
  switch (model.source) {
    case 'carla-0.10.0-ue5': {
      const bound = /^\/catalog\/([^/]+)\/(models\/.+)$/u.exec(entry.provenance?.boundUrl ?? '');
      const pack = bound ? carla.get(`${bound[1]}/${bound[2]}`) : undefined;
      if (!pack) throw new Error(`${catalogId}: CARLA entry without a pack model to take its attribution from (${entry.provenance?.boundUrl})`);
      if (pack.license !== 'CC-BY-4.0' || !pack.modifications.length) throw new Error(`${catalogId}: its pack record lacks a CC-BY licence or modifications`);
      return { ...pack, attribution: model.attribution ?? pack.attribution };
    }
    case 'meshy-refined':
      return {
        title: catalogId,
        license: 'CC-BY-4.0',
        license_url: CC_BY,
        attribution: MESHY_ATTRIBUTION,
        source: `Meshy text-to-3D (preview + refine) via tools/meshy for SimForge, Inc.${entry.approvedManifestSha256 ? `; approved manifest ${entry.approvedManifestSha256}` : ''}`,
        modifications: ['generated with Meshy, then normalized to the catalog dimensions, frame and grounding'],
        note: MESHY_NOTE,
      };
    case 'asset-catalog-procedural':
      return {
        title: catalogId,
        license: 'Apache-2.0',
        license_url: APACHE,
        attribution: `SimForge, Inc.: ${model.attribution ?? 'procedural catalog model'}`,
        source: 'SimForge procedural catalog geometry (@simforge-oss/asset-catalog buildProp, exported to glTF)',
        modifications: [],
      };
    default:
      throw new Error(`${catalogId}: model source ${JSON.stringify(model.source)} has no known licence; not publishing it`);
  }
}

export function deriveAttributed(base, catalogBytes, carla = carlaPackRecords()) {
  const catalog = JSON.parse(Buffer.from(catalogBytes).toString('utf8'));
  const assets = {};
  const licenses = {};
  for (const [catalogId, entry] of Object.entries(catalog)) {
    if (!catalogId.includes('.')) continue;
    const record = recordFor(catalogId, entry, carla);
    assets[catalogId] = record;
    for (const memberPath of boundPaths(entry)) {
      if (!base.members.has(memberPath)) throw new Error(`${catalogId} binds ${memberPath}, which the base closure lacks`);
      const prior = licenses[memberPath];
      if (prior && prior.license !== record.license) throw new Error(`${memberPath} is bound under ${prior.license} and ${record.license}`);
      licenses[memberPath] ??= { license: record.license, attribution: record.attribution, source: record.source };
    }
  }
  const attributionBytes = Buffer.from(`${JSON.stringify({
    schema: 'simforge.actor-attribution/v1',
    notice: 'Per-model licence and attribution for every catalog entry of this closure. CC BY 4.0 models: credit, licence, source and modifications as CC BY 4.0 section 3(a) asks.',
    licenses: { 'CC-BY-4.0': CC_BY, 'Apache-2.0': APACHE },
    assets,
  }, null, 2)}\n`);
  const members = {};
  for (const memberPath of Object.keys(licenses)) members[memberPath] = base.members.get(memberPath);
  members[CATALOG_MEMBER] = { sha256: sha256Bytes(catalogBytes), bytes: catalogBytes.byteLength };
  members[ATTRIBUTION_MEMBER] = { sha256: sha256Bytes(attributionBytes), bytes: attributionBytes.byteLength };
  const metadata = { license: 'Apache-2.0', attribution: 'SimForge, Inc.', source: 'simforge' };
  licenses[CATALOG_MEMBER] = metadata;
  licenses[ATTRIBUTION_MEMBER] = metadata;
  const excluded = [...base.members.keys()].filter((memberPath) => !(memberPath in members));
  return { attributionBytes, members, licenses, assets, excluded };
}

async function main(argv) {
  const lock = readLock();
  const origin = assetsOrigin(option(argv, '--origin', lock.origin));
  const basePin = option(argv, '--base', null)
    ? { sha256: option(argv, '--base'), bytes: Number(option(argv, '--base-bytes')) }
    : lockedClosure('actors', lock);
  const cacheDir = cacheRoot();
  const { directory, closure: base } = await materializeClosure(basePin, { origin, cacheDir });
  const catalogBytes = await readFile(path.join(directory, CATALOG_MEMBER));
  const { attributionBytes, members, licenses, assets, excluded } = deriveAttributed(base, catalogBytes);
  const sealed = sealClosure(members, { licenses });
  const closure = parseClosure(sealed.bytes, { sha256: sealed.sha256, bytes: sealed.size });
  if (unlicensedMembers(closure).length) throw new Error(`closure would carry unlicensed members: ${unlicensedMembers(closure).join(', ')}`);
  const bySource = {};
  for (const record of Object.values(assets)) bySource[record.license] = (bySource[record.license] ?? 0) + 1;
  const report = {
    base: basePin.sha256,
    closure: { sha256: sealed.sha256, bytes: sealed.size, members: closure.members.size },
    entries: Object.keys(assets).length,
    licences: bySource,
    excluded: excluded.sort(),
  };
  const staging = path.join(cacheDir, 'staging');
  await mkdir(staging, { recursive: true });
  const attributionFile = path.join(staging, `${members[ATTRIBUTION_MEMBER].sha256}.json`);
  await writeFile(attributionFile, attributionBytes);
  await writeFile(path.join(staging, `${sealed.sha256}.json`), sealed.bytes);
  report.staged = { document: path.join(staging, `${sealed.sha256}.json`), attribution: attributionFile };
  if (argv.includes('--publish')) {
    report.published = await publishClosure({
      closure, documentBytes: sealed.bytes, pin: { sha256: sealed.sha256, bytes: sealed.size },
      bucket: option(argv, '--bucket', DEFAULT_BUCKET), profile: option(argv, '--profile', process.env.AWS_PROFILE), origin,
      label: 'actors',
      localFile: async (memberPath) => (memberPath === ATTRIBUTION_MEMBER ? attributionFile : path.join(directory, memberPath)),
    });
    lock.closures.actors = {
      sha256: sealed.sha256,
      bytes: sealed.size,
      members: closure.members.size,
      description: `The actor closure every render binds and the SDK distributes: the catalog and models of ${basePin.sha256.slice(0, 8)} with an ATTRIBUTION.json member and a licence for every member (scripts/actor-assets/public-closure.mjs).`,
    };
    delete lock.closures['actors-public'];
    const ordered = Object.fromEntries(Object.entries(lock.closures).sort(([a], [b]) => a.localeCompare(b)));
    await writeFile(LOCK_PATH, `${JSON.stringify({ ...lock, closures: ordered }, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`public-closure: ${error.message}\n`);
    process.exit(1);
  });
}
