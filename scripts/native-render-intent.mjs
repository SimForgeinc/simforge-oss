#!/usr/bin/env node
/**
 * Build a `simforge.render-intent/v1` + input map for one catalog scenario,
 * targeting the `native` engine, from a pulled native map corpus.
 *
 * Usage:
 *   node scripts/native-render-intent.mjs --instance <instance.json> \
 *     --trace <trace.json.gz> --map-root <native-corpus-root/<map>> \
 *     --out <dir> [--camera pronto-cam1] [--width 736] [--height 416] [--fps 24]
 *
 * `--map-root` is the directory `simforge maps pull --native-corpus-root`
 * materialized: `master.gltf`, its buffers and images, the road sidecars, and
 * the `.map-release.json` installation receipt. Every receipt member (the
 * receipt itself excepted) becomes one intent asset named by the same
 * derivation the control planes and the worker use — `map.tile.000000` for
 * `master.gltf`, `map.resource.<sha256(relativePath)>` for everything else —
 * after its bytes are verified against the receipt digest and size. The
 * resulting `inputs.json` is what `simforge render run --engine native
 * --inputs` consumes.
 *
 * The actor closure is the same explicit asset the Studio hosts declare:
 * `actors.native-closure`, the pinned immutable closure document whose bytes
 * are downloaded into `<out>/actor-assets/closure.json` and verified against
 * the pinned digest and size before the intent is written. Each sensor host
 * carries the catalog identity the native lowering renders for its actor, so
 * the engine's host-identity check binds the rig to that appearance.
 *
 * `--camera` restricts the rendered sources to one rig dash camera; by
 * default every dash camera in the qualification rig is rendered.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const {
  NATIVE_ACTOR_ASSETS_INPUT_ID, NATIVE_MAP_MASTER_PATH,
  assertSafeNativeMapMemberPath, collectNativeMapMembers, nativeActorAssetsInput, nativeActorCatalogId, nativeMapMemberInputId,
} = await import(path.join(repoRoot, 'packages/render/dist/native/index.js'));
const { extractOpenScenarioExecutionPlan } =
  await import(path.join(repoRoot, 'packages/openscenario/dist/execution-plan.js'));

function argsOf(argv) {
  const map = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`unexpected argument ${key}`);
    map.set(key.slice(2), argv[i + 1]);
  }
  return map;
}

async function readJsonMaybeGzip(file) {
  if (file.endsWith('.gz')) return JSON.parse(gunzipSync(await fs.readFile(file)));
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

const digestFile = async (file) => {
  const bytes = await fs.readFile(file);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength };
};

const args = argsOf(process.argv.slice(2));
const instancePath = args.get('instance');
const tracePath = args.get('trace');
const mapRoot = args.get('map-root');
const outDir = path.resolve(args.get('out'));
if (!instancePath || !tracePath || !mapRoot || !args.get('out')) {
  throw new Error('--instance, --trace, --map-root and --out are all required');
}
const width = Number(args.get('width') ?? 736);
const height = Number(args.get('height') ?? 416);
const fps = Math.max(1, Math.floor(Number(args.get('fps') ?? 24)));
const cameraId = args.get('camera');

const instanceDoc = await readJsonMaybeGzip(instancePath);
const trace = await readJsonMaybeGzip(tracePath);
const input = instanceDoc.input;

// --- rig definition from the qualification program -------------------------
const program = JSON.parse(await fs.readFile(path.join(repoRoot, 'qualification/render-qualification-program.v1.json'), 'utf8'));
const rig = program.prontoRig;
const cameras = rig.sensors.filter((sensor) => sensor.type === 'dash_camera' && (cameraId === undefined || sensor.id === cameraId));
if (cameras.length === 0) throw new Error(`--camera ${cameraId} is not a rig dash camera`);

const actorId = input.actors[0]?.id ?? 'ego';

// --- sources ---------------------------------------------------------------
// The native retained engine renders RGB dash cameras only; lidar and radar
// sources belong to the CARLA qualification path.
const video = { width, height, fps, container: 'mp4', codec: 'h264', quality: 'high' };
const mmToM = (mm) => mm / 1000;
const sources = cameras.map((sensor) => ({
  actorId,
  sensorId: sensor.id,
  outputName: sensor.id.replace(/^pronto-/, 'cam').replace(/-/g, '_'),
  modality: 'rgb',
  transform: {
    position: {
      x: mmToM(sensor.sourceMountMm.longitudinal),
      y: mmToM(sensor.sourceMountMm.up),
      z: -mmToM(sensor.sourceMountMm.lateralRight),
    },
    rotation: {
      yawRad: ((sensor.rotationDeg?.yaw ?? 0) * Math.PI) / 180,
      pitchRad: ((sensor.rotationDeg?.pitch ?? 0) * Math.PI) / 180,
      rollRad: ((sensor.rotationDeg?.roll ?? 0) * Math.PI) / 180,
    },
  },
  attributes: { width, height, fps, horizontalFovDeg: sensor.horizontalFovDeg, nearM: 0.5, farM: 900 },
}));

// --- native map closure ------------------------------------------------------
const receiptPath = path.join(mapRoot, '.map-release.json');
const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
if (receipt.schema !== 'simforge.map-installation.v1' || receipt.profile !== 'native') {
  throw new Error(`${receiptPath} is not a native map installation receipt`);
}
if (input.mapId !== receipt.name || path.basename(path.resolve(mapRoot)) !== receipt.name) {
  throw new Error('the instance and supplied native map installation must identify the same map');
}
if (!receipt.members?.[NATIVE_MAP_MASTER_PATH]) throw new Error(`${mapRoot} installation lacks ${NATIVE_MAP_MASTER_PATH}`);
const mapInputs = [];
for (const [relativePath, member] of Object.entries(receipt.members).sort(([left], [right]) => left.localeCompare(right))) {
  assertSafeNativeMapMemberPath(relativePath);
  const file = path.join(mapRoot, ...relativePath.split('/'));
  const actual = await digestFile(file);
  if (actual.sha256 !== member.sha256 || actual.sizeBytes !== member.bytes) {
    throw new Error(`${relativePath} does not match the installation receipt (expected ${member.sha256}/${member.bytes}, got ${actual.sha256}/${actual.sizeBytes})`);
  }
  mapInputs.push({ inputId: nativeMapMemberInputId(relativePath), relativePath, path: file, ...actual });
}
// Proves the closure the engine will accept: unique safe paths, ids derived
// from those paths, and the master present.
collectNativeMapMembers(mapInputs);

// --- scenario.xosc export ---------------------------------------------------
await fs.mkdir(outDir, { recursive: true });
const xoscPath = path.join(outDir, 'scenario.xosc');
// Use this stack's exporter and the same verified installation as the renderer.
const exportCli = path.join(repoRoot, 'packages/cli/bin/simforge.js');
execFileSync(process.execPath, [
  exportCli, 'export', path.resolve(instancePath), '--format', 'xosc-1.4', '--out', xoscPath,
], {
  stdio: 'inherit',
  cwd: repoRoot,
  env: { ...process.env, SCEN_DEV_ASSETS: path.dirname(path.resolve(mapRoot)) },
});

// --- actor closure -------------------------------------------------------------
// One input convention across Local, Cloud, and this script: the closure
// document is the intent asset; its members are content-addressed under the
// blob origin and verified by the engine when the job runs.
const actorClosure = nativeActorAssetsInput();
const actorClosurePath = path.join(outDir, ...actorClosure.relativePath.split('/'));
await fs.mkdir(path.dirname(actorClosurePath), { recursive: true });
const closureResponse = await fetch(actorClosure.downloadUrl);
if (!closureResponse.ok) throw new Error(`actor closure download failed ${closureResponse.status}: ${actorClosure.downloadUrl}`);
const closureBytes = new Uint8Array(await closureResponse.arrayBuffer());
const closureDigest = createHash('sha256').update(closureBytes).digest('hex');
if (closureDigest !== actorClosure.sha256 || closureBytes.byteLength !== actorClosure.sizeBytes) {
  throw new Error(`${actorClosure.downloadUrl} is not the pinned actor closure (expected ${actorClosure.sha256}/${actorClosure.sizeBytes}, got ${closureDigest}/${closureBytes.byteLength})`);
}
await fs.writeFile(actorClosurePath, closureBytes);

// --- sensor host identity ----------------------------------------------------
// The host's catalogAssetId is the identity the native lowering renders for the
// host actor (its authored `catalog:` tag, else the semantic class default), read
// from the exported OpenSCENARIO the engine will lower.
const xoscDigest = await digestFile(xoscPath);
const plan = extractOpenScenarioExecutionPlan(await fs.readFile(xoscPath, 'utf8'), { sourceSha256: xoscDigest.sha256 });
const hostActor = plan.actors.find((candidate) => candidate.id === actorId);
if (!hostActor) throw new Error(`exported scenario has no actor ${actorId} to host the rig`);
const hostCatalogId = nativeActorCatalogId(hostActor.kind, plan.actorMetadata[hostActor.id]?.tags ?? hostActor.tags);

// --- intent -----------------------------------------------------------------
const times = trace.ticks.t;
const clipEnd = times[times.length - 1];
const slot = instanceDoc.catalogSlot ?? {};
const identity = String(slot.identity ?? 'native-e2e-scenario').slice(0, 100);
const traceDigest = await digestFile(tracePath);

const revisionId = String(instanceDoc.manifest?.revisionId ?? slot.identity ?? 'revision').replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 100) || 'revision';
const intent = {
  schema: 'simforge.render-intent/v1',
  intentId: `native-e2e-${identity}`.slice(0, 120),
  executionPackage: { id: `native-e2e-${identity}-package`.slice(0, 120), sourceInputDigest: traceDigest.sha256 },
  scenarioRevision: {
    revisionId,
    scenarioSha256: traceDigest.sha256,
    openScenario: xoscDigest,
    map: { mapId: input.mapId, revisionId: receipt.releaseDigest, sha256: receipt.canonicalDigest },
  },
  sensorHosts: sources.map((source) => ({
    sourceId: source.outputName,
    actorId: source.actorId,
    vehicleAsset: { catalogAssetId: hostCatalogId },
  })).sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
  renderSpec: {
    schema: 'simforge.render-spec/v3',
    sources,
    clip: { startSeconds: 0, endSeconds: Number(clipEnd.toFixed(3)) },
    video,
    artifacts: ['manifest', 'video', 'trace'],
    capabilityIntent: {
      required: ['sensor.rgb', 'artifact.manifest', 'artifact.video', 'artifact.trace', 'environment.authored', 'timing.fixed_step'],
      preferred: [],
      fidelity: 'dataset',
    },
    authoredEnvironment: {},
  },
  assets: [
    ...mapInputs.map(({ inputId, sha256, sizeBytes }) => ({ assetId: inputId, kind: 'map', sha256, sizeBytes })),
    { assetId: actorClosure.inputId, kind: 'catalog', sha256: actorClosure.sha256, sizeBytes: actorClosure.sizeBytes },
  ],
  seed: Number.parseInt(String(slot.designDigest ?? '00000000').slice(0, 8), 16),
};

const intentPath = path.join(outDir, 'intent.json');
await fs.writeFile(intentPath, `${JSON.stringify(intent, null, 2)}\n`);

// `simforge render run --inputs`: a bare path for the scenario, and
// `{ path, relativePath }` for every native map member so the engine can bind
// the member id to the closure path the master's URIs resolve against, plus
// the actor closure document under its own id.
const inputs = { 'scenario.xosc': xoscPath };
for (const member of mapInputs) inputs[member.inputId] = { path: member.path, relativePath: member.relativePath };
inputs[NATIVE_ACTOR_ASSETS_INPUT_ID] = { path: actorClosurePath, relativePath: actorClosure.relativePath };
await fs.writeFile(path.join(outDir, 'inputs.json'), `${JSON.stringify(inputs, null, 2)}\n`);

console.log(JSON.stringify({
  intentPath,
  inputsPath: path.join(outDir, 'inputs.json'),
  map: { name: receipt.name, version: receipt.version, releaseDigest: receipt.releaseDigest, memberCount: mapInputs.length },
  actorClosure: { inputId: actorClosure.inputId, sha256: actorClosure.sha256, hostCatalogId },
  sources: sources.map((source) => source.outputName),
}, null, 2));
