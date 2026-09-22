/**
 * SUMO end to end on one host, over the production code paths:
 *
 *   scenario → authored simulation (ambient off) → worker SUMO step → merged
 *   authoritative trace → render timeline (buildRenderTimeline) → native
 *   engine with the `render.timeline` input → Bevy retained service → video.
 *
 * Then it checks the SUMO vehicles against the trace:
 *   - every SUMO actor the timeline has at a rendered frame is in the frame
 *     sent to Bevy, with the SUMO body (`vehicle.sedan`);
 *   - `observed.jsonl` (the poses sent to the service, recorded per frame by
 *     the engine) through WS-B's comparator `compareObserved(timeline, …)`
 *     with the Bevy profile, per SUMO actor.
 *
 *   tsx --conditions=development packages/cli/scripts/sumo-e2e-render.mts \
 *     <scenario.json> <out-dir> [--seconds 3] [--width 640] [--height 360] [--fps 10]
 *
 * Needs the pinned SUMO runtime and the map's SUMO derivative + native master
 * installed, SIMFORGE_NATIVE_RENDER_BINARY (the retained service) and a GPU.
 */

import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { DEV_ASSETS, detectKind, executionSourceInputDigest, loadMap, readInstance, resolveExecutionInput } from '@simforge-oss/compiler/node';
import {
  ambientTrafficProfileFromExtensions,
  resolveAmbientTrafficProfile,
  traceToSceneFrame,
  type SimScenarioInput,
} from '@simforge-oss/engine';
import type { RenderIntentV1 } from '@simforge-oss/scenario';
import { createFixedSchedules, type RenderInputFile } from '@simforge-oss/render';
import { createRenderEngine, nativeActorAssetsInput } from '@simforge-oss/render/native';
import { buildRenderTimeline, compareObserved, openRenderTimeline, pose, RENDER_TIMELINE_INPUT_ID } from '@simforge-oss/render/timeline';

import { runWorkerSumo, sumoExecutionInput } from '../src/sumo-headless.js';

const run = promisify(execFile);
const [scenarioFile, outArg, ...rest] = process.argv.slice(2);
if (!scenarioFile || !outArg) throw new Error('usage: sumo-e2e-render.mts <scenario.json> <out-dir> [--seconds N] [--width W] [--height H] [--fps F]');
const flag = (name: string, fallback: number) => {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? Number(rest[index + 1]) : fallback;
};
const seconds = flag('seconds', 3);
const width = flag('width', 640);
const height = flag('height', 360);
const fps = flag('fps', 10);
const attitude = rest.includes('--attitude');
const out = path.resolve(outArg);
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(path.join(out, 'inputs'), { recursive: true });

// 1. Resolve and simulate exactly as the SUMO job does.
const kind = await detectKind(scenarioFile);
let input: SimScenarioInput;
let profileExtensions: Record<string, unknown> | undefined;
let mapId: string;
if (kind === 'instance') {
  const instance = await readInstance(scenarioFile);
  mapId = instance.input.mapId;
  input = sumoExecutionInput(instance.input, await loadMap(mapId));
} else {
  const content = JSON.parse(await fs.readFile(scenarioFile, 'utf8')) as { anchor: { pin: { mapId: string } }; extensions?: Record<string, unknown> };
  mapId = content.anchor.pin.mapId;
  input = resolveExecutionInput(content, await loadMap(mapId), 'sumo').resolvedInput;
  profileExtensions = content.extensions;
}
const bundle = await loadMap(mapId);
const authored = profileExtensions ? ambientTrafficProfileFromExtensions(profileExtensions) : null;
const profile = authored && authored.preset !== 'off'
  ? authored
  : resolveAmbientTrafficProfile({ version: 1, preset: 'city', seed: 'ambient-1' });
const worker = await runWorkerSumo({
  input,
  bundle,
  profile,
  sourceInputDigest: executionSourceInputDigest(input),
  map: { assetId: mapId, versionId: 'e2e' },
});
await fs.writeFile(path.join(out, 'trace.json'), JSON.stringify(worker.trace));
await fs.writeFile(path.join(out, 'materialized-traffic.json'), worker.traffic.artifact.bytes);

// 2. The render timeline of the merged, authoritative trace.
const xodr = await fs.readFile(path.join(DEV_ASSETS, mapId, 'map.xodr'));
const topology = await fs.readFile(path.join(DEV_ASSETS, mapId, 'topology-index.json.gz'));
const timeline = await buildRenderTimeline({ trace: worker.trace, xodr, topology });
const timelinePath = path.join(out, 'inputs', 'render.timeline.json');
await fs.writeFile(timelinePath, timeline.bytes);
const timelineDoc = JSON.parse(new TextDecoder().decode(timeline.bytes)) as {
  actors: { id: string; origin: string; catalogId: string }[];
};
const sumoInTimeline = timelineDoc.actors.filter((actor) => actor.origin === 'sumo');

// 3. Camera: the authored mover whose forward view holds the most SUMO
//    vehicles (render intents accept only URL-safe host ids, so a `sumo:`
//    actor cannot carry the camera), mounted high to see across junctions.
const scene = traceToSceneFrame(worker.trace);
const dt = worker.trace.header.dt;
const sumoIds = Object.keys(scene.ticks.actors).filter((id) => id.startsWith('sumo:'));
const hosts = Object.keys(scene.ticks.actors).filter((id) =>
  /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/.test(id) && !worker.trace.header.actorMetadata?.[id]?.static
  && ['car', 'vehicle', 'truck', 'van', 'bus'].includes(worker.trace.header.actorMetadata?.[id]?.kind ?? ''));
let best = { host: hosts[0]!, start: 0, score: -1 };
for (const host of hosts) {
  const track = scene.ticks.actors[host]!;
  for (let start = 0; start + seconds <= worker.trace.header.clipSeconds + 1e-9; start += 0.5) {
    let score = 0;
    for (let t = start; t < start + seconds; t += 0.5) {
      const tick = Math.round(t / dt);
      if (track.present[tick] !== 1) { score -= 100; continue; }
      // Heading is measured in the xodr-local frame; scene z = -y.
      const hx = Math.cos(track.headingRad[tick]!);
      const hz = -Math.sin(track.headingRad[tick]!);
      for (const id of sumoIds) {
        if (id === host) continue;
        const other = scene.ticks.actors[id]!;
        if (other.present[tick] !== 1) continue;
        const dx = other.x[tick]! - track.x[tick]!;
        const dz = other.z[tick]! - track.z[tick]!;
        const ahead = dx * hx + dz * hz;
        // Near vehicles dominate the frame; weight by proximity.
        if (ahead > 3 && ahead < 80 && Math.abs(dx * hz - dz * hx) < ahead) score += 20 / (20 + ahead);
      }
    }
    if (score > best.score) best = { host, start, score };
  }
}
const hostArg = rest.includes('--host') ? rest[rest.indexOf('--host') + 1]! : null;
if (hostArg) best = { host: hostArg, start: rest.includes('--start') ? flag('start', 0) : 0, score: -1 };
const start = best.start;
const end = start + seconds;

// 4. The native (Bevy) engine with the render.timeline input.
const closure = nativeActorAssetsInput();
const closureBytes = new Uint8Array(await (await fetch(closure.downloadUrl)).arrayBuffer());
const closurePath = path.join(out, 'inputs', ...closure.relativePath.split('/'));
await fs.mkdir(path.dirname(closurePath), { recursive: true });
await fs.writeFile(closurePath, closureBytes);
// The derived OpenSCENARIO export is not the scene source when a timeline is
// supplied; the engine still requires the member, so a labelled stub stands in.
const xoscPath = path.join(out, 'inputs', 'scenario.xosc');
await fs.writeFile(xoscPath, '<!-- scene source: render.timeline -->\n');
const xoscBytes = await fs.readFile(xoscPath);
const xoscSha256 = createHash('sha256').update(xoscBytes).digest('hex');
const intent: RenderIntentV1 = {
  schema: 'simforge.render-intent/v1',
  // Small texture tier: the render shares the GPU with other workloads.
  renderTextures: 'bc7-512',
  nativeVramBudgetBytes: 4 * 1024 ** 3,
  intentId: 'sumo-e2e',
  executionPackage: { id: 'sumo-e2e-package', sourceInputDigest: executionSourceInputDigest(input) },
  scenarioRevision: {
    revisionId: 'sumo-e2e-revision', scenarioSha256: 'b'.repeat(64),
    openScenario: { sha256: xoscSha256, sizeBytes: xoscBytes.byteLength },
    map: { mapId, revisionId: 'installed', sha256: 'c'.repeat(64) },
  },
  sensorHosts: [{
    sourceId: 'front-rgb', actorId: best.host,
    vehicleAsset: { catalogAssetId: timelineDoc.actors.find((actor) => actor.id === best.host)?.catalogId ?? 'vehicle.sedan' },
  }],
  renderSpec: {
    schema: 'simforge.render-spec/v3',
    sources: [{
      actorId: best.host, sensorId: 'front-camera', outputName: 'front-rgb', modality: 'rgb',
      transform: { position: { x: flag('cam-back', -8), y: flag('cam-height', 6), z: 0 }, rotation: { yawRad: flag('cam-yaw', 0), pitchRad: flag('cam-pitch', -0.25), rollRad: 0 } },
      attributes: { width, height, fps, horizontalFovDeg: 90, nearM: 0.05, farM: 1_000 },
    }],
    clip: { startSeconds: start, endSeconds: end },
    video: { width, height, fps, container: 'mp4', codec: 'h264', quality: 'high' },
    artifacts: ['manifest', 'video', 'trace'],
    capabilityIntent: {
      required: ['sensor.rgb', 'artifact.manifest', 'artifact.video', 'artifact.trace', 'environment.authored', 'timing.fixed_step'],
      preferred: [], fidelity: 'dataset',
    },
    authoredEnvironment: { weather: 'clear', timeOfDay: 'noon', surfacePatches: [] },
  },
  assets: [{ assetId: closure.inputId, kind: 'catalog', sha256: closure.sha256, sizeBytes: closure.sizeBytes }],
  seed: 1,
};
const inputs: RenderInputFile[] = [
  { inputId: 'scenario.xosc', path: xoscPath, sha256: xoscSha256, sizeBytes: xoscBytes.byteLength },
  { inputId: RENDER_TIMELINE_INPUT_ID, path: timelinePath, sha256: timeline.timelineSha256, sizeBytes: timeline.bytes.byteLength },
  { inputId: closure.inputId, path: closurePath, relativePath: closure.relativePath, sha256: closure.sha256, sizeBytes: closure.sizeBytes },
];
const master = path.join(os.homedir(), '.local', 'share', 'simforge', 'maps', '.corpus', mapId);
for (const entry of await fs.readdir(master, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const file = path.join(entry.parentPath, entry.name);
  const relativePath = path.relative(master, file).split(path.sep).join('/');
  if (/^images\/[^/]+\.(?:png|jpe?g|webp|avif)$/i.test(relativePath)) continue;
  const digest = createHash('sha256'); let sizeBytes = 0;
  for await (const chunk of createReadStream(file)) { digest.update(chunk as Buffer); sizeBytes += (chunk as Buffer).length; }
  inputs.push({
    inputId: relativePath === 'master.gltf' ? 'map.tile.000000' : `map.resource.${createHash('sha256').update(relativePath).digest('hex')}`,
    path: file, relativePath, sha256: digest.digest('hex'), sizeBytes,
  });
}
const workspace = path.join(out, 'render');
let renderError: string | null = null;
const manifest = await createRenderEngine({
  binary: process.env.SIMFORGE_NATIVE_RENDER_BINARY,
  applyAttitude: attitude,
  // The pinned actor closure's blobs, fetched and verified like a worker does.
  actorAssetsBaseUrl: process.env.SIMFORGE_ACTOR_ASSETS_BASE_URL ?? new URL(closure.downloadUrl).origin,
  // A packaged closure directory (`blobs/sha256/<xx>/<sha>`) is verified in place.
  ...(process.env.SIMFORGE_ACTOR_ASSETS_CACHE_DIR ? { actorAssetsCacheDir: process.env.SIMFORGE_ACTOR_ASSETS_CACHE_DIR } : {}),
}).execute({
  jobId: 'sumo-e2e', attempt: 1, intent, intentSha256: 'd'.repeat(64),
  executionPackageControlSha256: 'e'.repeat(64), schedules: createFixedSchedules(intent),
  inputs: new Map(inputs.map((item) => [item.inputId, item])), workspace,
  signal: new AbortController().signal, reportProgress: async () => undefined,
}).catch((error: unknown) => {
  // The engine's blocking parity gate throws after writing its evidence; keep
  // going so the report shows exactly which SUMO actors disagreed.
  renderError = error instanceof Error ? error.message : String(error);
  return null;
});
const video = manifest?.artifacts.find((artifact) => artifact.identity.role === 'video');
if (renderError) console.error(`native render: ${renderError}`);

// 5. SUMO vehicles in the rendered frames vs the timeline.
const sent = JSON.parse(await fs.readFile(path.join(workspace, 'trace', 'native-trace.json'), 'utf8')) as {
  frames: { tick: number; actors: { id: string; kind: string; catalogId: string; transform: { position: number[]; rotation: number[] } }[] }[];
};
const frameTimes = Array.from({ length: sent.frames.length }, (_, index) => start + index / fps);
const handle = await openRenderTimeline(timeline.bytes);
// Prefer what Bevy reports it drew (`observe_actors` → trace/observed-frames.jsonl);
// a service without that op leaves only the poses the engine sent it.
const observedPath = path.join(workspace, 'trace', 'observed-frames.jsonl');
const observedSource = await fs.access(observedPath).then(() => 'bevy-observed' as const, () => 'sent-to-service' as const);
const observed = observedSource === 'bevy-observed'
  ? (await fs.readFile(observedPath, 'utf8')).trim()
  : sent.frames.map((frame, index) => JSON.stringify({
    t: Number(frameTimes[index]!.toFixed(6)),
    actors: frame.actors.filter((actor) => actor.kind !== 'despawn').map((actor) => ({ id: actor.id, position: actor.transform.position, rotation: actor.transform.rotation })),
  })).join('\n');
await fs.writeFile(path.join(out, 'observed.jsonl'), `${observed}\n`);
const parity = compareObserved(handle, observed, {
  name: 'bevy', positionToleranceM: 1e-3, angleToleranceDeg: 0.05,
  frame: 'scene-yup', heightReference: 'ground', compareAttitude: attitude,
});
const missingSumo: { t: number; id: string }[] = [];
const wrongBody: string[] = [];
for (const [index, frame] of sent.frames.entries()) {
  const drawn = new Map(frame.actors.filter((actor) => actor.kind !== 'despawn').map((actor) => [actor.id, actor]));
  for (const actor of sumoInTimeline) {
    const present = pose(handle, actor.id, frameTimes[index]!).present;
    if (present && !drawn.has(actor.id)) missingSumo.push({ t: frameTimes[index]!, id: actor.id });
    const body = drawn.get(actor.id);
    if (body && body.catalogId !== 'vehicle.sedan') wrongBody.push(actor.id);
  }
}
const sumoPerActor = Object.fromEntries(Object.entries(parity.perActor).filter(([id]) => id.startsWith('sumo:')));
const stills: string[] = [];
if (video) {
  for (const fraction of [0.1, 0.5, 0.9]) {
    const still = path.join(out, `still-${Math.round(fraction * 100)}.png`);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(seconds * fraction), '-i', path.join(workspace, video.relativePath), '-frames:v', '1', still]);
    stills.push(still);
  }
}
const report = {
  schema: 'simforge.sumo-e2e-render/v1',
  mapId,
  scenario: path.resolve(scenarioFile),
  sumo: {
    key: worker.traffic.key,
    materializedTrafficSha256: worker.traffic.artifact.sha256,
    actors: worker.traffic.artifact.artifact.actors.length,
    signalAgreementMismatches: worker.traffic.diagnostics.signalAgreement.mismatches,
    redLightViolations: worker.signalAudit.redViolations.length,
  },
  trace: { traceSha256: worker.traceSha256, authoredTraceSha256: worker.authoredTraceSha256 },
  timeline: { key: timeline.timelineKey, sha256: timeline.timelineSha256, sumoActors: sumoInTimeline.length },
  render: {
    host: best.host, clip: [start, end], frames: sent.frames.length,
    video: video?.relativePath ?? null, renderError, attitude,
    sumoActorsDrawnPerFrame: sent.frames.map((frame) => frame.actors.filter((actor) => actor.id.startsWith('sumo:') && actor.kind !== 'despawn').length),
  },
  checks: {
    missingSumoActorsInFrames: missingSumo.length,
    sumoWithWrongBody: [...new Set(wrongBody)],
    parity: {
      observedSource,
      profile: parity.profile.name, pass: parity.pass, comparedPoses: parity.comparedPoses,
      maxPositionErrorM: parity.maxPositionErrorM, maxHeadingErrorDeg: parity.maxHeadingErrorDeg,
      presenceMismatches: parity.presenceMismatches,
      sumoActorsCompared: Object.keys(sumoPerActor).length,
      sumoMaxPositionErrorM: Math.max(0, ...Object.values(sumoPerActor).map((actor) => actor.maxPositionErrorM)),
      sumoMaxHeadingErrorDeg: Math.max(0, ...Object.values(sumoPerActor).map((actor) => actor.maxHeadingErrorDeg)),
    },
  },
  stills,
};
await fs.writeFile(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
handle.free();
