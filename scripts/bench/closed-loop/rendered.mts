import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { loadMap } from '../../../packages/compiler/src/node.js';
import { safeParseSimScenarioInput } from '../../../packages/engine/src/index.js';
import { addonCandidates, native } from '../../../packages/native-runtime/src/index.js';
import type { Episode as KernelEpisode, FrameRef } from '../../../packages/native-runtime/native/index.js';
import { resolveNativeLighting } from '../../../packages/render/src/native/lighting.js';
import { startNativeRenderService } from '../../../packages/render/src/native/service-process.js';
import { stripRgbaPadding } from '../../../packages/render/src/native/service-client.js';
import { crc32 } from '../../../packages/render/src/native/shm-bundles.js';
import { getProfile } from '../../../packages/cli/src/commands/drive/profiles.js';
import { nativeWorldPaths } from '../../../packages/cli/src/commands/drive/scene.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const addon = native();
const addonSha = createHash('sha256').update(await fs.readFile(addonCandidates()[0]!)).digest('hex');
const { values } = parseArgs({ options: {
  out: { type: 'string', default: path.join(root, 'docs/engineering/benchmarks/rendered-throughput.json') },
  'runner-class': { type: 'string', default: 'local' },
  binary: { type: 'string', default: process.env.SIMFORGE_NATIVE_RENDER_BINARY ?? path.join(root, 'renderer/target/release/native-render-service') },
} });
const out = path.resolve(values.out);
if (!out.endsWith('.json')) throw new Error('--out must end in .json; its .md sibling is emitted too');
const rendererSha = createHash('sha256').update(await fs.readFile(values.binary)).digest('hex');
const suiteBytes = await fs.readFile(path.join(here, 'suite.json'));
const suite = JSON.parse(suiteBytes.toString());
const scenario = suite.scenarios.find((entry: { id: string }) => entry.id === 'corridor');
const specBytes = await fs.readFile(path.join(here, scenario.spec));
if (createHash('sha256').update(specBytes).digest('hex') !== scenario.sha256) throw new Error('frozen corridor digest mismatch');
const parsed = safeParseSimScenarioInput(JSON.parse(specBytes.toString()).instances[0].input);
if (!parsed.ok) throw new Error('frozen corridor is not a valid scenario input');
const input = parsed.value;
const map = await loadMap(input.mapId);
const cache = process.env.SIMFORGE_MAPS_CACHE_ROOT ?? path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local/share'), 'simforge/maps');
const topology = path.join(process.env.SCEN_DEV_ASSETS ?? path.join(cache, 'dev-assets'), input.mapId, 'topology-index.json.gz');
if (createHash('sha256').update(await fs.readFile(topology)).digest('hex') !== suite.topologySha256) throw new Error('map topology differs from the pinned benchmark suite');
const gitSha = process.env.BENCH_GIT_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
// This gate requires the provisioned NVIDIA host; record its GPU and driver inventory.
const gpu = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total,driver_version,pci.bus_id', '--format=csv,noheader'], { encoding: 'utf8' }).trim();
const hardware = { host: os.hostname(), cpu: os.cpus()[0]?.model, logical_cpus: os.cpus().length,
  os: `${os.type()} ${os.release()}`, architecture: os.arch(), gpu, runner_class: values['runner-class'],
  load_average_at_start: os.loadavg() };
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'simforge-render-bench-'));
const controller = new AbortController();
const interrupt = (): void => controller.abort(new Error('benchmark interrupted'));
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
interface CameraRow {
  sensorId: string;
  pass: string;
  width: number;
  height: number;
  frame: { id: number; tick: number; format: string; rowStride: number; digest: string; sha256: string; len: number };
}
interface CameraObservation {
  cameras: CameraRow[];
}
interface LeasedFrame {
  ref: FrameRef;
  row: CameraRow;
  bytes: Buffer;
  rgba: Buffer;
}
interface Sample {
  ticks: number;
  seconds: number;
  ticks_per_s: number;
  rgb_bytes: number;
  last_frames: { sensor_id: string; width: number; height: number; sha256: string; crc32: string }[];
}
interface ProfileResult {
  profile: string;
  cameras: { sensor_id: string; width: number; height: number }[];
  median_ticks_per_s: number;
  samples: Sample[];
  renderer_hello: unknown;
}
const rows: ProfileResult[] = [];
try {
  const world = await nativeWorldPaths(input, map.graph, root, scratch, async (line) => { console.error(line); });
  const meshes = [];
  for (const file of world) meshes.push({ name: path.basename(file), sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') });
  const conditions = input.operationalConditions;
  const look = resolveNativeLighting({ weather: conditions.weather === 'rain' ? 'light_rain' : conditions.weather, timeOfDay: conditions.timeOfDay === 'day' ? 'noon' : conditions.timeOfDay, surfacePatches: [] });
  // BENCH_RENDER_PRESET (gpu-deep comparison): a simforge-render build renders the named preset (it
  // refuses the retired profile fields); older builds render their rc.73 look.
  const preset = process.env.BENCH_RENDER_PRESET;
  const scene = preset
    ? { glbs: world, lighting: look.lighting, render: { preset, set: { 'textures.tier': 'bc7-512' } }, textureTier: 'bc7-512',
      // The bench scene names no actor catalogs: older builds drew cuboids
      // silently; this build must be told to.
      allowPrimitiveActors: true, autoMeter: true, warmupFrames: 20, nearM: 0.5, farM: 900 }
    : { glbs: world, profile: 'cinematic', lighting: look.lighting, profileConfig: look.profileConfig,
      autoMeter: true, warmupFrames: 20, nearM: 0.5, farM: 900 };
  const scenePath = path.join(scratch, 'scene.json');
  await fs.writeFile(scenePath, JSON.stringify(scene));
  for (const profileName of suite.renderProfiles as string[]) {
    const profile = getProfile(profileName);
    const service = await startNativeRenderService({ binary: values.binary, workspace: path.join(scratch, profileName),
      jobId: `throughput-${profileName}`, scenePath, signal: controller.signal });
    let episode: KernelEpisode | undefined;
    let leased: LeasedFrame[] = [];
    const releaseFrames = (): void => {
      for (const frame of leased) frame.ref.release();
      leased = [];
    };
    try {
      const hello = await service.client.rpc({ op: 'hello' }, 30_000);
      // The service handles one client at a time. Hand its socket to Episode,
      // retaining only the process/shm lifecycle in the shared startup helper.
      await service.client.close();
      episode = new addon.Episode(JSON.stringify({
        scenario: input, seed: 42, decisionHz: 10, mode: { kind: 'offline-simtime' },
        warmupDecisions: suite.renderWarmupTicks,
        observation: { channels: [{ kind: 'cameras', rig: { cameras: profile }, passes: ['rgb'],
          backend: { kind: 'service', socket: service.socket } }] },
      }), map.graph);
      episode.reset();
      console.error(`renderer ready profile=${profileName} protocol=${service.protocol} owner=Episode`);
      const action = JSON.stringify({ k: 's', speedMps: 6, accelerationMps2: 0 });
      const renderTick = (): number => {
        releaseFrames();
        const observation = (episode!.ended
          ? JSON.parse(episode!.reset())
          : JSON.parse(episode!.step(action)).obs) as CameraObservation;
        if (observation.cameras?.length !== profile.length) throw new Error('Episode returned an incomplete camera bundle');
        const tick = observation.cameras[0]!.frame.tick;
        let byteCount = 0;
        for (const spec of profile) {
          const row = observation.cameras.find((row) => row.sensorId === spec.sensorId && row.pass === 'rgb');
          if (!row || row.width !== spec.width || row.height !== spec.height || row.frame.tick !== tick
            || row.frame.format !== 'rgba8') throw new Error(`missing aligned native-resolution RGB for ${spec.sensorId}`);
          const ref = episode!.frame(row.frame.id);
          try {
            const bytes = ref.buffer();
            if (bytes.byteLength !== row.frame.len || bytes.byteLength !== row.frame.rowStride * row.height) throw new Error('invalid camera payload extent');
            const rgba = stripRgbaPadding(bytes, row.width, row.height);
            leased.push({ ref, row, bytes, rgba });
            byteCount += rgba.byteLength;
          } catch (error) {
            ref.release();
            throw error;
          }
        }
        return byteCount;
      };
      const samples: Sample[] = [];
      for (let repeat = 0; repeat < suite.repeats; repeat += 1) {
        releaseFrames();
        if (repeat > 0) episode.reset();
        let ticks = 0;
        let rgbBytes = 0;
        const started = performance.now();
        while (performance.now() - started < suite.seconds * 1000) {
          rgbBytes += renderTick();
          ticks += 1;
        }
        const seconds = (performance.now() - started) / 1000;
        const last = leased.map(({ row, bytes, rgba }) => {
          const checksum = crc32(bytes).toString(16).padStart(8, '0');
          if (checksum !== row.frame.digest || createHash('sha256').update(bytes).digest('hex') !== row.frame.sha256) {
            throw new Error(`camera payload digest mismatch for ${row.sensorId}`);
          }
          return { sensor_id: row.sensorId, width: row.width, height: row.height,
            sha256: createHash('sha256').update(rgba).digest('hex'), crc32: checksum };
        });
        releaseFrames();
        samples.push({ ticks, seconds, ticks_per_s: ticks / seconds, rgb_bytes: rgbBytes, last_frames: last });
      }
      const rates = samples.map((sample) => sample.ticks_per_s).sort((a, b) => a - b);
      const row = { profile: profileName, cameras: profile.map((camera) => ({ sensor_id: camera.sensorId, width: camera.width, height: camera.height })),
        median_ticks_per_s: rates[Math.floor(rates.length / 2)]!, samples, renderer_hello: hello };
      rows.push(row);
      console.error(JSON.stringify(row));
    } finally {
      try {
        releaseFrames();
        episode?.close();
      } finally {
        await service.close();
      }
    }
  }
  const floor = suite.floors.alpamayo2camTicksPerSecond;
  const baseline = rows.find((row) => row.profile === 'alpamayo-2cam');
  const passed = baseline !== undefined && baseline.median_ticks_per_s >= floor;
  const result = { schema: 'simforge.rendered-throughput/v2', measured_at: new Date().toISOString(), git_sha: gitSha,
    hardware, suite_sha256: createHash('sha256').update(suiteBytes).digest('hex'), map_id: input.mapId,
    topology_sha256: suite.topologySha256, scenario_sha256: scenario.sha256, meshes,
    native_binding: { abi: addon.abiVersion(), engine_version: addon.engineVersion(), sha256: addonSha },
    renderer_binary_sha256: rendererSha,
    benchmark_source_sha256: createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex'),
    method: { seconds: suite.seconds, repeats: suite.repeats, warmup_ticks_per_window: suite.renderWarmupTicks,
      decision_hz: 10, seed: 42, model: null, lighting_profile: 'cinematic', texture_tier: 'textures-512-bc7',
      action: { k: 's', speedMps: 6, accelerationMps2: 0 }, loop_owner: 'native Episode',
      includes: ['native Episode step/reset and trace', 'kernel camera service RPC', 'GPU RGB readback', 'zero-copy FrameRef access', 'RGBA padding removal'],
      excludes: ['service/asset startup', 'warm-up', 'PNG/video/HUD encoding', 'model inference', 'post-window frame hashing'],
      exact_profile_only: true }, rows,
    gate: { profile: 'alpamayo-2cam', minimum_ticks_per_s: floor, passed } };
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
  const lines = ['# Native camera-profile throughput', '',
    `Measured ${result.measured_at}; git \`${gitSha}\`; runner \`${values['runner-class']}\`.`, '',
    `Hardware: ${hardware.cpu}; ${hardware.logical_cpus} logical CPUs; ${hardware.os}. GPU: ${gpu}.`, '',
    'One tick is a complete bundle of every camera in the named rig at the registry resolution, not one image. '
      + 'The kernel Episode camera channel drives the same native service as the bench, without a model or the bench’s extra HUD camera. '
      + 'Episode stepping, trace, camera RPC, GPU readback and zero-copy FrameRef access are timed; PNG/HUD/video encoding and startup are not.', '',
    `Median of ${suite.repeats} windows ≥${suite.seconds} s, each after ${suite.renderWarmupTicks} rendered warm-up ticks.`, '',
    '| Profile | Native resolutions | Median ticks/s | Window rates |', '|---|---|---:|---|'];
  for (const row of rows) lines.push(`| ${row.profile} | ${row.cameras.map((camera) => `${camera.width}×${camera.height}`).join(', ')} | ${row.median_ticks_per_s.toFixed(2)} | ${row.samples.map((sample) => sample.ticks_per_s.toFixed(2)).join(', ')} |`);
  lines.push('', `Gate: **${passed ? 'PASS' : 'FAIL'}**; alpamayo-2cam must sustain ≥${floor} ticks/s.`, '',
    `Raw counts, timings, frame hashes, renderer identity and mesh digests: [${path.basename(out)}](${path.basename(out)}).`, '');
  await fs.writeFile(out.replace(/\.json$/, '.md'), lines.join('\n'));
  console.log(JSON.stringify({ json: out, markdown: out.replace(/\.json$/, '.md'), gate: result.gate }));
  if (!passed) process.exitCode = 1;
} finally {
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
  await fs.rm(scratch, { recursive: true, force: true });
}
