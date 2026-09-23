import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { buildMapIntelFromDir } from '../src/intel/build/build.js';
import { sha256, stableStringify } from '../src/intel/build/hash.js';
import { buildRoadBoundaryOutline } from '../src/topology/road-boundary.js';

const [cacheArg, evidenceArg, ...maps] = process.argv.slice(2);
if (!cacheArg || !evidenceArg || !maps.length) throw new Error('Usage: derive-bench.mts <map-cache-root> <evidence-directory> <map-id>...');
const root = path.resolve(cacheArg.replace(/^~(?=\/|$)/, homedir()));
const evidenceRoot = path.resolve(evidenceArg);
const results = [];
for (const map of maps) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(map)) throw new Error(`Invalid map id: ${map}`);
  const directory = path.join(root, 'dev-assets', map);
  const xodr = await readFile(path.join(directory, 'map.xodr'));
  const intel = await buildMapIntelFromDir(directory);
  const boundary = buildRoadBoundaryOutline(xodr.toString(), sha256(xodr));
  const products = {
    'derived/locations.json.gz': gzipSync(stableStringify(intel.catalog), { level: 9 }),
    'derived/topology-derived.json.gz': gzipSync(stableStringify(intel.derived), { level: 9 }),
    'road-boundary.json.gz': gzipSync(stableStringify(boundary), { level: 9 }),
  };
  const manifest = {
    schema: 'simforge.bench-map-derivation/v1', map,
    recipes: { mapIntel: 'parked-row-sightlines/v1', roadBoundary: boundary.recipe },
    sourceHashes: intel.catalog.sourceHashes,
    members: Object.fromEntries(Object.entries(products).map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha256(bytes) }])),
    catalogRevision: intel.catalog.catalogRevision,
    counts: { ...intel.catalog.stats.byType, roadBoundaries: boundary.boundaries.length, roadBoundaryPoints: boundary.boundaries.reduce((n, b) => n + b.points.length, 0), cutBoundaries: boundary.boundaries.filter((b) => b.cutStart || b.cutEnd).length },
  };
  const manifestBytes = Buffer.from(`${stableStringify(manifest)}\n`);
  const manifestHash = sha256(manifestBytes);
  for (const layout of ['dev-assets', 'map-bundles', '.corpus']) {
    const destination = path.join(root, layout, map);
    const installationPath = path.join(destination, '.map-release.json');
    const installation = JSON.parse(await readFile(installationPath, 'utf8'));
    // Release identity remains the upstream parent. Local derivation gets its own
    // content digest; never pretend modified bytes belong to a published release.
    for (const [name, bytes] of Object.entries({ ...products, 'derived/supply-manifest.json': manifestBytes })) {
      const target = path.join(destination, name), temporary = `${target}.supply-${process.pid}`;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(temporary, bytes, { flag: 'wx' });
      await rename(temporary, target); // break installation→blob hardlinks, never mutate cached source blobs
      installation.members[name] = { bytes: bytes.length, sha256: sha256(bytes) };
    }
    installation.localDerivation = { manifest: 'derived/supply-manifest.json', sha256: manifestHash, parentReleaseDigest: installation.releaseDigest, membersDigest: sha256(stableStringify(installation.members)) };
    const temporary = `${installationPath}.supply-${process.pid}`;
    await writeFile(temporary, `${stableStringify(installation)}\n`, { flag: 'wx' });
    await rename(temporary, installationPath);
  }
  const evidenceDir = path.join(evidenceRoot, map);
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, 'manifest.json'), manifestBytes);
  for (const [name, bytes] of Object.entries(products)) await writeFile(path.join(evidenceDir, path.basename(name)), bytes);
  results.push({ map, manifestSha256: manifestHash, ...manifest.counts });
  console.log(JSON.stringify(results.at(-1)));
}
await writeFile(path.join(evidenceRoot, 'summary.json'), `${JSON.stringify(results, null, 2)}\n`);
