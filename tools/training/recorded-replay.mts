import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { loadMap } from '../../packages/compiler/src/node.js';
import { native } from '../../packages/native-runtime/src/index.js';
import { compareNativeEpisodeTraces } from '../../packages/evaluation/src/campaign.js';
import { verifyRunDirectory } from '../../packages/cli/src/commands/drive/verify.js';
import { annotateFrame } from '../../packages/cli/src/commands/drive/hud.js';
import { actorModelCatalogs, nativeWorldPaths } from '../../packages/cli/src/commands/drive/scene.js';
import { getProfile } from '../../packages/cli/src/commands/drive/profiles.js';
import { resolveNativeLighting } from '../../packages/render/src/native/lighting.js';
import { startNativeRenderService } from '../../packages/render/src/native/service-process.js';
import { stripRgbaPadding } from '../../packages/render/src/native/service-client.js';

export const REPLAY_LABEL = 'recorded-action replay (renderer RGB nondeterministic; not a model re-inference)';
const [sourceArg, scenarioFile, outArg, binary] = process.argv.slice(2);
if (!sourceArg || !scenarioFile || !outArg || !binary) throw new Error('usage: recorded-replay.mts SOURCE_RUN SCENARIO_EPISODES OUTPUT_DIR RENDER_BINARY');
const source = path.resolve(sourceArg), out = path.resolve(outArg);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const original = JSON.parse(await fs.readFile(path.join(source, 'run.json'), 'utf8'));
const originalTrace = await fs.readFile(path.join(source, 'trace.jsonl'), 'utf8');
const originalRows = originalTrace.trim().split('\n').map((line) => JSON.parse(line));
const actions = originalRows.filter((row) => row.phase === 'policy').map((row) => row.a);
const sourceVerification = await verifyRunDirectory(source);
if (!sourceVerification.modelHealth.healthy || original.mode !== 'offline-simtime' || original.appearance || original.controls) throw new Error('recorded replay requires a healthy raw RGB offline-simtime source');
const document = JSON.parse(await fs.readFile(scenarioFile, 'utf8'));
if (document.instances?.length !== 1 || !document.instances[0].input || typeof document.instances[0].input !== 'object') throw new Error('replay requires the exact single materialized scenario input');
const input = document.instances[0].input;
if (input.mapId !== original.mapId) throw new Error('replay map differs');
const map = await loadMap(input.mapId);
if (map.graph.digest !== original.graphDigest) throw new Error('replay lane graph differs');
const catalogs = await actorModelCatalogs(root);
for (const key of ['vehicleModels', 'pedestrianModels'] as const) if (catalogs[key].catalogSha256 !== original.actorModels?.[key]?.catalogSha256) throw new Error('replay actor catalog differs');
await fs.mkdir(out, { recursive: false });
await fs.mkdir(path.join(out, 'frames'));
const workspace = path.join(out, 'renderer');
await fs.mkdir(workspace);
const glbs = await nativeWorldPaths(input, map.graph, root, workspace, async (line) => console.log(line));
const conditions = input.operationalConditions;
const look = resolveNativeLighting({ weather: conditions.weather === 'rain' ? 'light_rain' : conditions.weather, timeOfDay: conditions.timeOfDay === 'day' ? 'noon' : conditions.timeOfDay, surfacePatches: [] });
const scenePath = path.join(workspace, 'scene.json');
await fs.writeFile(scenePath, JSON.stringify({ glbs, profile: 'cinematic', lighting: look.lighting, profileConfig: look.profileConfig, autoMeter: true, warmupFrames: 20, nearM: 0.5, farM: 900, vehicleModels: catalogs.vehicleModels.directory, pedestrianModels: catalogs.pedestrianModels.directory }));
const controller = new AbortController();
const interrupt = () => controller.abort(new Error('recorded replay interrupted'));
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
const service = await startNativeRenderService({ binary, workspace, jobId: 'recorded-action-replay', scenePath, signal: controller.signal });
await service.client.close();
const cameras = new Map();
for (const spec of [...getProfile('alpamayo-2cam'), ...getProfile(original.cameraProfile)]) cameras.set(spec.sensorId, spec);
const episodeSpec = { scenario: { ...input, clipSeconds: original.durationS + (original.warmupFrames - 1) / 10 }, seed: original.seed, decisionHz: 10, mode: { kind: 'offline-simtime' }, warmupDecisions: original.warmupFrames - 1, maxDecisions: Math.ceil(original.durationS * 10), observation: { channels: [ ...(original.model?.hello?.obsPreset === 'visible' ? [{ kind: 'visible' }] : [{ kind: 'state' }, { kind: 'objects' }, { kind: 'signals' }]), { kind: 'cameras', rig: { cameras: [...cameras.values()] }, passes: ['rgb'], backend: { kind: 'service', socket: service.socket } }] } };
const episode = new (native().Episode)(JSON.stringify(episodeSpec), map.graph);
const video = path.join(out, 'drive.mp4');
const encoder = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '512x384', '-r', '10', '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video], { stdio: ['pipe', 'ignore', 'pipe'] });
let encoderError = '';
encoder.stderr.on('data', (bytes) => { encoderError += bytes.toString(); });
const encoderExit = once(encoder, 'exit');
const frameDigests: string[] = [];
let frameIndex = 0;
const poseOf = (snapshot: any) => {
  const ego = snapshot.actors.find((actor: any) => actor.id === snapshot.egoId);
  return { tS: snapshot.tS, speedMps: ego.state.speedMps };
};
const mainPixels = (observation: any, refs: any[]) => {
  const index = observation.cameras.findIndex((camera: any) => camera.sensorId === 'camera_front_wide_120fov' && camera.pass === 'rgb');
  if (index < 0) throw new Error('replay main camera absent');
  const camera = observation.cameras[index];
  if (camera.width !== 512 || camera.height !== 384) throw new Error('replay HUD camera dimensions differ');
  return Buffer.from(stripRgbaPadding(refs[index].buffer(), 512, 384));
};
const encode = async (rgba: Buffer, pose: { tS: number; speedMps: number }) => {
  const png = await sharp(rgba, { raw: { width: 512, height: 384, channels: 4 } }).png().toBuffer();
  await fs.writeFile(path.join(out, 'frames', `${frameIndex}.png`), png);
  frameDigests.push(createHash('sha256').update(png).digest('hex'));
  const hud = await annotateFrame(rgba, { policy: 'recorded-action-replay', speedMps: pose.speedMps, latencyMs: 0, step: frameIndex, tS: pose.tS, reasoning: { kind: 'text', text: REPLAY_LABEL }, trajectory: null });
  if (!encoder.stdin.write(hud)) await once(encoder.stdin, 'drain');
  frameIndex++;
};
try {
  const warmup: { rgba: Buffer; pose: ReturnType<typeof poseOf> }[] = [];
  let observation = JSON.parse(episode.reset((payload: string, refs: any[]) => {
    try { const row = JSON.parse(payload); warmup.push({ rgba: mainPixels(row.observation, refs), pose: poseOf(row.snapshot) }); }
    finally { for (const ref of refs) ref.release(); }
  }));
  for (const frame of warmup) await encode(frame.rgba, frame.pose);
  warmup.length = 0;
  for (const [index, action] of actions.entries()) {
    if (episode.ended) throw new Error(`recorded world terminated before source action ${index}`);
    const refs = observation.cameras.map((camera: any) => episode.frame(camera.frame.id));
    let rgba: Buffer;
    try { rgba = mainPixels(observation, refs); }
    finally { for (const ref of refs) ref.release(); }
    await encode(rgba, poseOf(JSON.parse(episode.snapshot())));
    const result = JSON.parse(episode.step(JSON.stringify(action)));
    if (result.dl.miss || result.dl.ap !== 'policy') throw new Error('native replay applied a fallback');
    observation = result.obs;
  }
  if (!episode.ended) throw new Error('recorded action sequence did not reproduce native termination');
  const core = JSON.parse(episode.finish());
  const trace = episode.traceJson();
  await fs.writeFile(path.join(out, 'trace.jsonl'), trace);
  const proof = compareNativeEpisodeTraces(originalTrace, trace);
  if (!proof.match) throw new Error('recorded replay world/action/scene identity differs from original');
  encoder.stdin.end();
  const [code] = await encoderExit;
  if (code !== 0) throw new Error(`replay video encoding failed: ${encoderError}`);
  const receipt = { schema: 'simforge.recorded-action-replay/v1', label: REPLAY_LABEL, isModelReInference: false, promotable: false, sourceRun: source, sourceTraceSha256: createHash('sha256').update(originalTrace).digest('hex'), replayTraceSha256: createHash('sha256').update(trace).digest('hex'), worldActionChainDigest: proof.original.stateDigest, proof, nativeResult: core, sourceVerification, cameraProfile: original.cameraProfile, actorModels: catalogs, frames: frameIndex, frameDigests, video, videoSha256: createHash('sha256').update(await fs.readFile(video)).digest('hex') };
  await fs.writeFile(path.join(out, 'replay.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ out, label: REPLAY_LABEL, worldActionChainDigest: receipt.worldActionChainDigest, decisions: actions.length, frames: frameIndex, pixelIdentical: proof.pixelIdentical }));
} finally {
  episode.close();
  if (encoder.exitCode === null) encoder.kill('SIGTERM');
  await service.close();
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
}
