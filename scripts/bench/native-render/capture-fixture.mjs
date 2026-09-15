#!/usr/bin/env node
/**
 * Capture a native-render benchmark fixture from a real Studio render job.
 *
 * A fixture is one directory holding everything `run.mjs` needs, with no
 * Studio host, database or network involved:
 *
 *   intent.json      the immutable `simforge.render-intent/v1` the job ran
 *   scenario.xosc    the frozen OpenSCENARIO the intent's digest names
 *   closure.json     the pinned actor-appearance closure (`actors.native-closure`)
 *   catalog.json     the local catalog manifest asset (when the intent lists one)
 *   inputs.json      input id -> { path, relativePath } for every intent asset
 *
 * Map members are the bulk (Richmond is ~1.1 GB); they are referenced in
 * place from the prepared map directory rather than copied. The intent only
 * carries `map.resource.<sha256(relativePath)>` ids and content digests, so
 * the map directory is walked and every file is matched by content digest.
 *
 * Usage:
 *   node scripts/bench/native-render/capture-fixture.mjs \
 *     --intent <intent.json> --worker-dir <~/.simforge/cloud/worker/usrj_...> \
 *     --map-dir <~/.simforge/cloud/maps/<usmap_...>/semantic> --out <fixture-dir>
 *
 * `--worker-dir` supplies `inputs/scenario.xosc`, `inputs/actor-assets/closure.json`
 * and `inputs/catalog-manifest.json`; pass `--xosc`, `--closure`, `--catalog`
 * instead to point at files elsewhere.
 */
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function argsOf(argv) {
  const map = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith('--') || argv[i + 1] === undefined) throw new Error(`usage: --key value pairs (got ${key})`);
    map.set(key.slice(2), argv[i + 1]);
  }
  return map;
}

async function digest(file) {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); sizeBytes += chunk.length; }
  return { sha256: hash.digest('hex'), sizeBytes };
}

const args = argsOf(process.argv.slice(2));
const need = (key) => { const v = args.get(key); if (!v) throw new Error(`--${key} is required`); return path.resolve(v); };
const intentPath = need('intent');
const mapDir = need('map-dir');
const out = need('out');
const workerDir = args.has('worker-dir') ? path.resolve(args.get('worker-dir')) : null;
const xoscPath = args.has('xosc') ? path.resolve(args.get('xosc')) : workerDir && path.join(workerDir, 'inputs', 'scenario.xosc');
const closurePath = args.has('closure') ? path.resolve(args.get('closure')) : workerDir && path.join(workerDir, 'inputs', 'actor-assets', 'closure.json');
const catalogPath = args.has('catalog') ? path.resolve(args.get('catalog')) : workerDir && path.join(workerDir, 'inputs', 'catalog-manifest.json');
if (!xoscPath || !closurePath) throw new Error('--worker-dir or --xosc and --closure are required');

const intent = JSON.parse(await fs.readFile(intentPath, 'utf8'));
if (intent.schema !== 'simforge.render-intent/v1') throw new Error(`not a render intent: ${intentPath}`);
await fs.mkdir(out, { recursive: true });

const inputs = {};
const copyVerified = async (inputId, source, name, expected) => {
  const actual = await digest(source);
  if (actual.sha256 !== expected.sha256 || actual.sizeBytes !== expected.sizeBytes) {
    throw new Error(`${inputId}: ${source} has digest ${actual.sha256} (${actual.sizeBytes} B), intent declares ${expected.sha256} (${expected.sizeBytes} B)`);
  }
  await fs.copyFile(source, path.join(out, name));
  inputs[inputId] = { path: name };
};
await copyVerified('scenario.xosc', xoscPath, 'scenario.xosc', intent.scenarioRevision.openScenario);

// Every non-map asset is small and copied; map members are matched in place.
const mapAssets = new Map();
for (const asset of intent.assets) {
  if (asset.kind === 'map') { mapAssets.set(asset.sha256, asset); continue; }
  if (asset.assetId === 'actors.native-closure') { await copyVerified(asset.assetId, closurePath, 'closure.json', asset); continue; }
  if (asset.kind === 'catalog') {
    if (!catalogPath) throw new Error(`intent asset ${asset.assetId} needs --catalog`);
    await copyVerified(asset.assetId, catalogPath, 'catalog.json', asset);
    continue;
  }
  throw new Error(`unsupported intent asset ${asset.assetId} (${asset.kind})`);
}

let matched = 0;
for (const entry of await fs.readdir(mapDir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const file = path.join(entry.parentPath, entry.name);
  const relativePath = path.relative(mapDir, file).split(path.sep).join('/');
  const actual = await digest(file);
  const asset = mapAssets.get(actual.sha256);
  if (!asset || asset.sizeBytes !== actual.sizeBytes) continue;
  if (inputs[asset.assetId]) continue;
  inputs[asset.assetId] = { path: file, relativePath };
  matched += 1;
}
const missing = [...mapAssets.values()].filter((asset) => !inputs[asset.assetId]);
if (missing.length > 0) {
  throw new Error(`${missing.length} map members of ${mapAssets.size} were not found under ${mapDir} (first: ${missing[0].assetId})`);
}

await fs.copyFile(intentPath, path.join(out, 'intent.json'));
await fs.writeFile(path.join(out, 'inputs.json'), `${JSON.stringify(inputs, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  fixture: out,
  intentId: intent.intentId,
  sources: intent.renderSpec.sources.map((source) => `${source.outputName} (${source.modality})`),
  clip: intent.renderSpec.clip,
  mapMembers: matched,
  mapDir,
}, null, 2)}\n`);
