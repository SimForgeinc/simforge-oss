#!/usr/bin/env node
/**
 * Native render golden harness — WSB6 (DeterminismCI).
 *
 * Drives `simforge-render job --job job.json` (schema
 * `simforge.render-job/v2`: the render service's own request path, pinned
 * capture clock) to record and verify golden pass hashes per adapter
 * fingerprint. The adapter of record is Mesa lavapipe (the CPU Vulkan
 * driver), not a GPU: NVIDIA drivers are not run-to-run byte-stable for this
 * renderer (1 LSB in a few pixels between identical runs), lavapipe is, and
 * hashes are compared exactly, never with a tolerance. The frame-time budget
 * gate runs only when GOLDEN_FRAME_BUDGET is set (a CPU rasterizer's times
 * measure the host, not the renderer; GPU performance is gated by
 * scripts/bench). Evidence manifests extend
 * `simforge-oss.render-determinism-manifest.v1`; the additions are documented in
 * docs/engineering/native-golden-ci.md.
 *
 * Commands:
 *   node qualification/golden-harness/golden.mjs record  <scene>   run twice, require byte-stable, write golden
 *   node qualification/golden-harness/golden.mjs verify  <scene>   one run, compare hashes (+ frame time with GOLDEN_FRAME_BUDGET)
 *   node qualification/golden-harness/golden.mjs verify  all       verify every scene in scenes/
 *   node qualification/golden-harness/golden.mjs plan    <scene|all> [--allow-missing-corpus]
 *        write each scene's job file and print the invocation; no GPU, no render
 *
 * Scene overrides for red-path demos: --set job.scene.lighting.sun_elev_deg=20
 * Renderer binary: --bin <path>, else GOLDEN_RENDER_BIN, else
 * target/release/simforge-render.
 *
 * Exit codes: 0 ok · 2 pass-hash drift · 3 frame-time budget exceeded ·
 * 4 nondeterministic on record (two runs differ) · 5 no golden for this GPU ·
 * 7 vacuous ID pass (it
 * encodes too few instances: a golden of a blank pass proves nothing) ·
 * 8 observed actor transforms fail parity with the render timeline ·
 * 9 non-finite (NaN/inf) pixels in a frame before tone mapping (a shading
 * bug that prints as black; a golden of it would enshrine it) ·
 * 10 the scene declares `recording: "unrecorded"` (it has no hashes on any
 * adapter yet; verifying it is a failure, never a pass) ·
 * 1 usage/environment error.
 *
 * Scene definition (scenes/<sceneId>.json):
 * - `job: {scene, rig, ticks, passes}` — the render job minus what the
 *   harness owns: `schema`, `scene.glbs` (the resolved `corpusFiles`),
 *   `sceneState`, `outDir`, and `observe` (set for `parity` scenes). String
 *   values may use `{repo}` (repository root), `{corpus}` (corpus root) and
 *   `{pack:<name>}`: the directory of a content-addressed closure pinned in
 *   catalog/closures.lock.json (the CARLA model packs, whose bytes are not in
 *   git), fetched by digest and verified before any render
 *   (scripts/actor-assets/closures.mjs). An unavailable pack fails the run.
 * - `corpusRootEnv` / `corpusFiles` — the map GLBs (a `tiles/` subdirectory
 *   of the corpus root is used when present).
 * - `sceneState` — `{gz}`: a gzipped `simforge.scene-state.v1` document
 *   (header, actor descriptors, frames; `simforge render scene-state`),
 *   lowered here into the per-tick stream the service loads, with `groundY: 0`
 *   so the document's baked heights are authoritative; or `{stream}`: a
 *   committed per-tick stream (JSON array of scene-state.v1 tick documents),
 *   passed through unchanged.
 * - `actorCatalogSubstitutions: {actorId: catalogId}` — explicit, recorded
 *   catalog-id replacements applied while lowering `{gz}` (the service
 *   never substitutes a model on its own).
 * - `expectedPasses` + `passPaths` — logical pass key -> artifact path under
 *   the job's outDir (`<sensor>/<tick:08>.<pass>.png|.f32.bin`, lidar
 *   `<sensor>/<tick:08>.ply`).
 * - `idPass: {keys?, minInstances?, minCoverage?}` — every ID pass (keys
 *   default to expectedPasses ending in `.id`) must encode at least
 *   `minInstances` distinct non-background ids (default 2) covering at least
 *   `minCoverage` of the frame (default 0.05), on record and on verify.
 * - `recording: "unrecorded"` — an explicit state for a scene added before
 *   its first record (e.g. the release smoke scene): `verify` fails with
 *   exit 10 and says so; `record` writes the golden and removes the field.
 * - `parity: {timeline, observed, profile}` — grade the renderer's observed
 *   transforms (`<outDir>/observed-frames.jsonl`, written by the job when
 *   `observe` is set) against the render timeline's shared sampler
 *   (`simforge render parity`; override with GOLDEN_PARITY_CMD).
 *
 * Timings come from the job's `results.json` (per tick, first tick excluded
 * as settle); a one-tick job has none and skips the frame-time gate.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { pullPinned } from '../../scripts/actor-assets/closures.mjs';
import { collectNativeHardware, lavapipeEnv } from './lib/fingerprint.mjs';
import { idPassStats } from './lib/png.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HARNESS = path.join(repoRoot, 'qualification/golden-harness');
const SCENES_DIR = process.env.GOLDEN_SCENES_DIR ?? path.join(HARNESS, 'scenes');
const GOLDENS_DIR = process.env.GOLDEN_STORE_DIR ?? path.join(HARNESS, 'goldens');
const ARTIFACTS_DIR = process.env.GOLDEN_ARTIFACTS_DIR ?? path.join(repoRoot, 'artifacts/golden-harness');

// ---------------------------------------------------------------------------
// helpers

const sha256File = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--allow-missing-corpus') {
      args.allowMissingCorpus = true;
    } else if (a === '--set') {
      const [k, v] = argv[++i].split('=');
      args.overrides ??= [];
      args.overrides.push([k, v]);
    } else if (a.startsWith('--')) {
      args[a.slice(2)] = argv[++i];
    } else {
      args._.push(a);
    }
  }
  return args;
}

function applyOverrides(scene, overrides) {
  const clone = structuredClone(scene);
  for (const [dotPath, raw] of overrides ?? []) {
    const keys = dotPath.split('.');
    let node = clone;
    while (keys.length > 1) {
      node ??= {};
      node = node[keys.shift()];
    }
    const leaf = keys[0];
    const prev = node?.[leaf];
    node[leaf] =
      typeof prev === 'number' && !Number.isNaN(Number(raw)) ? Number(raw)
      : prev === true || prev === false ? raw === 'true'
      : Array.isArray(prev) ? String(raw).split(',').map(Number)
      : raw;
  }
  return clone;
}

function resolvePaths(scene, { allowMissing = false } = {}) {
  const corpusRoot = (scene.corpusRootEnv && process.env[scene.corpusRootEnv])
    ?? scene.corpusRoot
    ?? process.env.SCEN_SENSOR_CORPUS
    ?? path.join(repoRoot, 'scripts/renderer-spike/corpus');
  const tilesDir = fs.existsSync(path.join(corpusRoot, 'tiles'))
    ? 'tiles'
    : '';
  const glbs = scene.corpusFiles.map((f) => path.join(corpusRoot, tilesDir, f));
  const missing = glbs.filter((g) => !fs.existsSync(g));
  if (missing.length > 0 && !allowMissing) {
    fail(1, `corpus file missing: ${missing[0]} (set ${scene.corpusRootEnv ?? 'SCEN_SENSOR_CORPUS'} to the decoded corpus root)`);
  }
  return { corpusRoot, glbs, missing };
}

function loadScene(id) {
  const p = path.join(SCENES_DIR, `${id}.json`);
  if (!fs.existsSync(p)) fail(1, `unknown scene: ${id} (${p})`);
  const scene = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const key of ['job', 'expectedPasses', 'passPaths', 'corpusFiles']) {
    if (!scene[key]) fail(1, `scene ${id}: missing ${key}`);
  }
  const unmapped = scene.expectedPasses.filter((k) => !scene.passPaths[k]);
  if (unmapped.length > 0) fail(1, `scene ${id}: expectedPasses without passPaths: ${unmapped.join(', ')}`);
  return scene;
}

/** Map logical pass key -> artifact file under the job's outDir. */
function passFiles(outDir, scene) {
  return Object.fromEntries(Object.entries(scene.passPaths).map(([k, rel]) => [k, path.join(outDir, rel)]));
}

function hashPasses(outDir, passes, scene) {
  const map = passFiles(outDir, scene);
  const out = {};
  for (const key of passes) {
    const f = map[key];
    if (!f || !fs.existsSync(f)) fail(1, `expected pass output missing: ${f ?? key}`);
    out[key] = { file: path.relative(outDir, f), sha256: sha256File(f), bytes: fs.statSync(f).size };
  }
  return out;
}

const PACK_TOKEN = /\{pack:([a-z0-9][a-z0-9-]*)\}/gu;
/** `{pack:<name>}` -> materialized closure directory; filled by resolvePacks before any job is built. */
const packDirs = new Map();

/** Fetch (by digest, verified) every pinned closure the scenes name, before any job is built. */
async function resolvePacks(sceneArg) {
  const ids = sceneArg === undefined || sceneArg === 'all'
    ? fs.readdirSync(SCENES_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
    : [sceneArg];
  const names = new Set();
  for (const id of ids) {
    const file = path.join(SCENES_DIR, `${id}.json`);
    if (!fs.existsSync(file)) continue;
    for (const [, name] of fs.readFileSync(file, 'utf8').matchAll(PACK_TOKEN)) names.add(name);
  }
  for (const name of [...names].sort()) {
    if (packDirs.has(name)) continue;
    try {
      packDirs.set(name, await pullPinned(name));
    } catch (e) {
      fail(1, `model pack ${name} is unavailable: ${e.message}`);
    }
    console.log(`[golden-harness] pack ${name}: ${packDirs.get(name)}`);
  }
}

/** `{repo}` / `{corpus}` / `{pack:<name>}` in every string of a JSON value. */
function substitute(value, vars) {
  if (typeof value === 'string') {
    return value.replaceAll('{repo}', vars.repo).replaceAll('{corpus}', vars.corpus).replace(PACK_TOKEN, (_, name) => {
      const dir = packDirs.get(name);
      if (!dir) fail(1, `{pack:${name}} was not resolved before the job was built`);
      return dir;
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
  }
  return value;
}

/**
 * Timeline actor kinds -> render-service actor classes. The same table as
 * packages/render/src/native/lowering.ts `NATIVE_ACTOR_CLASSES`; an unknown
 * class is refused, never guessed.
 */
const SERVICE_ACTOR_CLASSES = {
  vehicle: 'car', car: 'car', van: 'van', truck: 'truck', bus: 'bus', motorcycle: 'motorcycle',
  bicycle: 'cyclist', scooter: 'cyclist', cyclist: 'cyclist', pedestrian: 'pedestrian',
  sidewalk_robot: 'prop', drone: 'prop', animal: 'prop', static_object: 'prop', prop: 'prop',
};

/**
 * Lower a `simforge.scene-state.v1` document (header + actor descriptors +
 * frames) into the per-tick stream `load_scene_state` takes: every tick
 * carries the header, every actor record its descriptor (catalogId,
 * actorClass, dims, color) and its pose as `transform`. `groundY: 0` makes
 * the baked heights authoritative even where they are exactly 0 (the retired
 * playback binary's `--authored-height`). `t` is the frame's clip time, for the
 * job's observed-frames record.
 */
function lowerSceneStateDocument(doc, substitutions, sceneId) {
  if (doc.version !== 'simforge.scene-state.v1') fail(1, `scene ${sceneId}: scene-state version ${doc.version}`);
  if (!Array.isArray(doc.frames) || !Array.isArray(doc.actors)) fail(1, `scene ${sceneId}: scene-state document needs actors and frames`);
  const descriptors = new Map(doc.actors.map((a) => [a.id, a]));
  for (const id of Object.keys(substitutions)) {
    if (!descriptors.has(id)) fail(1, `scene ${sceneId}: actorCatalogSubstitutions names unknown actor ${id}`);
  }
  const applied = [];
  for (const [id, catalogId] of Object.entries(substitutions)) {
    applied.push({ actorId: id, kind: 'catalog-id', requested: descriptors.get(id).catalogId, rendered: catalogId });
  }
  const stream = doc.frames.map((frame) => ({
    version: doc.version,
    mapId: doc.mapId,
    tick: frame.tick,
    tickHz: doc.tickHz,
    t: frame.t,
    ...(doc.weather ? { weather: doc.weather } : {}),
    ...(doc.timeOfDay !== undefined ? { timeOfDay: doc.timeOfDay } : {}),
    groundY: 0,
    actors: frame.actors.map((a) => {
      const d = descriptors.get(a.id);
      if (!d) fail(1, `scene ${sceneId}: frame ${frame.tick} actor ${a.id} has no descriptor`);
      const actorClass = SERVICE_ACTOR_CLASSES[d.actorClass];
      if (!actorClass) fail(1, `scene ${sceneId}: actor ${a.id} class ${d.actorClass} has no render-service class`);
      return {
        id: a.id,
        kind: a.kind,
        catalogId: substitutions[a.id] ?? d.catalogId,
        actorClass,
        dims: d.dims,
        ...(d.color ? { color: d.color } : {}),
        transform: { position: a.position, rotation: a.rotation },
        velocity: a.velocity ?? [0, 0, 0],
        ...(a.wheelSpinRad !== undefined ? { wheelSpinRad: a.wheelSpinRad } : {}),
        ...(a.bodyAttitude ? { bodyAttitude: a.bodyAttitude } : {}),
        ...(a.wheelDropM ? { wheelDropM: a.wheelDropM } : {}),
      };
    }),
  }));
  return { stream, applied };
}

/**
 * Build the `simforge.render-job/v2` job for one run into `<outDir>.job.json`
 * and return the renderer argv plus what the manifest records about it.
 */
function buildInvocation(scene, glbs, corpusRoot, outDir) {
  if (scene.rendererArgs || scene.invocationTemplate || scene.profile) {
    fail(1, `scene ${scene.sceneId}: rendererArgs/invocationTemplate/profile are retired; describe the render as \`job\``);
  }
  // A fresh directory per run: a stale artifact (or observed-frames file)
  // from an earlier run must never be hashed as this run's output.
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  const job = {
    schema: 'simforge.render-job/v2',
    ...substitute(scene.job, { repo: repoRoot, corpus: corpusRoot }),
    outDir,
  };
  job.scene = { ...job.scene, glbs };
  const substitutions = [];
  if (scene.sceneState?.gz) {
    const doc = JSON.parse(gunzipSync(fs.readFileSync(path.join(repoRoot, scene.sceneState.gz))).toString('utf8'));
    const { stream, applied } = lowerSceneStateDocument(doc, scene.actorCatalogSubstitutions ?? {}, scene.sceneId);
    substitutions.push(...applied);
    job.sceneState = `${outDir}.scene-state.json`;
    fs.writeFileSync(job.sceneState, JSON.stringify(stream));
  } else if (scene.sceneState?.stream) {
    job.sceneState = path.join(repoRoot, scene.sceneState.stream);
  } else if (scene.sceneState) {
    fail(1, `scene ${scene.sceneId}: sceneState needs gz or stream`);
  }
  if (scene.actorCatalogSubstitutions && !scene.sceneState?.gz) {
    fail(1, `scene ${scene.sceneId}: actorCatalogSubstitutions apply only to a lowered {gz} scene state`);
  }
  for (const [actorId, glb] of Object.entries(job.scene.actorModelRefs ?? {})) {
    substitutions.push({ actorId, kind: 'actor-model-ref', rendered: path.relative(repoRoot, glb) });
  }
  if (job.scene.allowPrimitiveActors) substitutions.push({ kind: 'allow-primitive-actors' });
  if (scene.parity) job.observe = true;
  const jobPath = `${outDir}.job.json`;
  fs.writeFileSync(jobPath, JSON.stringify(job, null, 2));
  return { args: ['job', '--job', jobPath], job, substitutions };
}

/** Exit 7 unless every ID pass encodes real instances (see `idPass`). */
function checkIdPasses(outDir, scene) {
  const keys = scene.idPass?.keys ?? scene.expectedPasses.filter((k) => /\.id$/.test(k));
  const minInstances = scene.idPass?.minInstances ?? 2;
  const minCoverage = scene.idPass?.minCoverage ?? 0.05;
  const files = passFiles(outDir, scene);
  const stats = {};
  for (const key of keys) {
    const file = files[key];
    if (!file || !fs.existsSync(file)) throw new GateFailure(1, `ID pass ${key} missing: ${file}`);
    const s = idPassStats(fs.readFileSync(file));
    stats[key] = { distinctIds: s.distinctIds, coveredFraction: Number(s.coveredFraction.toFixed(4)) };
    if (s.distinctIds < minInstances || s.coveredFraction < minCoverage) {
      throw new GateFailure(7, `vacuous ID pass ${key}: ${s.distinctIds} ids covering ${(s.coveredFraction * 100).toFixed(2)}% (need >= ${minInstances} ids and >= ${(minCoverage * 100).toFixed(1)}%)`);
    }
  }
  return stats;
}

/** Exit 8 unless the renderer's observed transforms match the timeline sampler. */
function checkParity(outDir, scene) {
  if (!scene.parity) return undefined;
  // The Rust sampler's parity grader (simforge-core example `render-parity`;
  // ci-local.sh builds it). Stopgap until the `simforge` CLI drives the goldens.
  const built = path.join(repoRoot, 'target/release/examples/render-parity');
  const cmd = (process.env.GOLDEN_PARITY_CMD ?? (fs.existsSync(built) ? built
    : `cargo run --quiet --release --manifest-path ${path.join(repoRoot, 'Cargo.toml')} -p simforge-core --example render-parity --`)).split(' ');
  const observed = path.join(outDir, scene.parity.observed ?? 'observed-frames.jsonl');
  if (!fs.existsSync(observed)) {
    throw new GateFailure(1, `parity: the job wrote no ${path.basename(observed)} (job \`observe\` must write the observed actor transforms of every tick)`);
  }
  const r = spawnSync(cmd[0], [...cmd.slice(1), path.join(repoRoot, scene.parity.timeline), observed, '--profile', scene.parity.profile ?? 'bevy'], { encoding: 'utf8', cwd: repoRoot });
  let report;
  try { report = JSON.parse(r.stdout); } catch { throw new GateFailure(1, `parity command failed (${r.status}): ${r.stderr?.slice(-800)}`); }
  const summary = {
    schema: report.schema, pass: report.pass, profile: report.profile.name, comparedPoses: report.comparedPoses,
    maxPositionErrorM: report.maxPositionErrorM, maxHeadingErrorDeg: report.maxHeadingErrorDeg,
    maxPitchErrorDeg: report.maxPitchErrorDeg, maxRollErrorDeg: report.maxRollErrorDeg,
    presenceMismatches: report.presenceMismatches, timelineSha256: report.timelineSha256,
  };
  if (!report.pass) throw new GateFailure(8, `parity failed: ${JSON.stringify(summary)}`);
  return summary;
}

/**
 * Run the job; timings come from its `results.json` (`tickMs` excludes the
 * first, settling tick). A one-tick job has no timed ticks: null, and its
 * scene skips the frame-time gate.
 */
function runRenderer(binPath, invocation, label) {
  console.log(`[golden-harness] render ${label}: ${path.basename(binPath)} ${invocation.args.join(' ')}`);
  // Lavapipe renders on the CPU: a 120-tick scene takes minutes, not seconds.
  const timeoutMs = Number(process.env.GOLDEN_RENDER_TIMEOUT_S ?? 3600) * 1000;
  const r = spawnSync(binPath, invocation.args, {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...lavapipeEnv() },
  });
  if (r.status !== 0) {
    fail(1, `renderer exited ${r.status}\nstdout tail:\n${(r.stdout ?? '').slice(-2000)}\nstderr tail:\n${(r.stderr ?? '').slice(-2000)}`);
  }
  const resultsPath = path.join(invocation.job.outDir, 'results.json');
  if (!fs.existsSync(resultsPath)) fail(1, `renderer wrote no ${resultsPath}`);
  const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  if (results.schema !== 'simforge.render-job-results/v2') fail(1, `${resultsPath}: schema ${results.schema}`);
  // Every frame's HDR image must be finite (the camera model counts NaN/inf
  // pixels per camera; results.exposure has them per tick).
  if (!Number.isInteger(results.nonFinitePixels)) fail(1, `${resultsPath}: no nonFinitePixels (renderer predates the frame-integrity count)`);
  if (results.nonFinitePixels > 0) {
    const where = Object.entries(results.exposure ?? {}).flatMap(([tick, cams]) => Object.entries(cams).filter(([, c]) => c.nonFinitePixels > 0).map(([sensor, c]) => `tick ${Number(tick)} ${sensor}: ${c.nonFinitePixels}`));
    throw new GateFailure(9, `${label}: ${results.nonFinitePixels} non-finite pixels before tone mapping (${where.slice(0, 5).join('; ')})`);
  }
  const ticks = results.tickMs ?? [];
  if (ticks.length === 0) return null;
  const sorted = [...ticks].sort((a, b) => a - b);
  return {
    avg_frame_ms: results.meanMsPerTick,
    p50_frame_ms: results.medianMsPerTick,
    p99_frame_ms: sorted[Math.min(sorted.length - 1, Math.ceil(0.99 * sorted.length) - 1)],
    fps: 1000 / results.meanMsPerTick,
    measured_frames: ticks.length,
    gpu_busy_ms_per_tick: results.gpuBusyMsPerTick,
  };
}

function cargoVersions() {
  // wgpu + bevy versions from the built crate's Cargo.lock.
  let lock = '';
  for (const cand of [
    path.join(repoRoot, 'Cargo.lock'),
  ]) {
    if (fs.existsSync(cand)) { lock = fs.readFileSync(cand, 'utf8'); break; }
  }
  const ver = (name) => lock.match(new RegExp(`\\[\\[package\\]\\]\\nname = "${name}"\\nversion = "([^"]+)"`))?.[1] ?? null;
  return { bevy: ver('bevy'), wgpu: ver('wgpu') };
}

function rustcVersion() {
  try {
    return spawnSync('rustc', ['--version'], { encoding: 'utf8' }).stdout.trim();
  } catch { return null; }
}

function resolveBinary(args) {
  const candidates = [
    args.bin,
    process.env.GOLDEN_RENDER_BIN,
    path.join(repoRoot, 'target/release/simforge-render'),
  ].filter(Boolean);
  const bin = candidates.find((p) => fs.existsSync(p));
  if (!bin) fail(1, `no renderer binary found (tried: ${candidates.join(', ')}) — build it first (cargo build --release -p simforge-render)`);
  return bin;
}

function manifestBase({ mode, scene, hardware, binPath, invocation, versions }) {
  return {
    schema: 'simforge-oss.render-determinism-manifest.v1',
    generatedAt: new Date().toISOString(),
    claim: 'byte-exactness of the native (Bevy/wgpu) render-job pass hashes across renders of one fixed scene state on pinned hardware',
    mode,
    renderConfig: invocation.job.scene.render ?? null,
    scenario: {
      instanceId: null,
      mapId: scene.mapId,
      sceneId: scene.sceneId,
      inputs: { sceneDefinition: `qualification/golden-harness/scenes/${scene.sceneId}.json` },
    },
    rendererPath: {
      engine: 'native-bevy',
      file: path.relative(repoRoot, binPath),
      sha256: sha256File(binPath),
      invocation: { args: invocation.args, job: invocation.job, passesRenderedSequentially: false },
      versions: { ...versions, rustc: rustcVersion(), backend: 'vulkan' },
    },
    ...(invocation.substitutions.length > 0 ? { actorSubstitutions: invocation.substitutions } : {}),
    hardware,
  };
}

function writeManifest(obj, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  console.log(`[golden-harness] wrote ${path.relative(repoRoot, file)}`);
}

function goldenPath(hardware, sceneId) {
  return path.join(GOLDENS_DIR, hardware.gpuFingerprint, `${sceneId}.json`);
}

/** A first record ends a scene's explicit `unrecorded` state (the scene file is rewritten without it). */
function clearUnrecorded(sceneId) {
  const p = path.join(SCENES_DIR, `${sceneId}.json`);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (raw.recording === undefined) return;
  delete raw.recording;
  fs.writeFileSync(p, `${JSON.stringify(raw, null, 2)}\n`);
  console.log(`[golden-harness] ${sceneId}: recording state cleared in ${path.relative(repoRoot, p)} (commit it with the golden)`);
}

function fail(code, msg) {
  console.error(`[golden-harness] ERROR: ${msg}`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// commands

async function cmdRecord(args) {
  const sceneId = args._[1];
  if (!sceneId) fail(1, 'usage: golden.mjs record <scene>');
  const scene = applyOverrides(loadScene(sceneId), args.overrides);
  const { glbs, corpusRoot } = resolvePaths(scene);
  const binPath = resolveBinary(args);

  console.log('[golden-harness] collecting hardware fingerprint...');
  const hardware = await collectNativeHardware();
  console.log(`[golden-harness] gpuFingerprint=${hardware.gpuFingerprint} adapter=${hardware.host.adapter.deviceName} driver=${hardware.host.adapter.driverInfo} cpu=${hardware.host.cpuModel}`);

  const corpusChecksums = glbs.map((g) => ({
    path: path.basename(g),
    sha256: sha256File(g),
    bytes: fs.statSync(g).size,
  }));
  const artifacts = path.join(ARTIFACTS_DIR, 'record', sceneId);
  fs.mkdirSync(artifacts, { recursive: true });

  const versions = cargoVersions();
  const base = { scene, hardware, binPath, versions };

  // Two independent process runs — the determinism evidence itself.
  const runs = [];
  for (const label of ['runA', 'runB']) {
    const outDir = path.join(artifacts, label, sceneId);
    const invocation = buildInvocation(scene, glbs, corpusRoot, outDir);
    const timings = runRenderer(binPath, invocation, label);
    runs.push({
      timings,
      passHashes: hashPasses(outDir, scene.expectedPasses, scene),
      idPasses: checkIdPasses(outDir, scene),
      parity: checkParity(outDir, scene),
      invocation,
    });
  }

  const drift = Object.keys(runs[0].passHashes)
    .filter((k) => !runs[0].passHashes[k].diagnostic)
    .filter((k) => runs[0].passHashes[k].sha256 !== runs[1].passHashes[k].sha256);
  if (drift.length > 0) {
    fail(4, `two record runs disagree on passes: ${drift.join(',')} — this GPU/render path is NOT byte-stable; refusing to write a golden`);
  }

  const t = runs[0].timings;
  const golden = {
    ...manifestBase({ mode: 'golden-record', ...base, invocation: runs[0].invocation }),
    passHashes: runs[0].passHashes,
    idPasses: runs[0].idPasses,
    ...(runs[0].parity ? { parity: runs[0].parity } : {}),
    ...(scene.sceneState ? { sceneStateSha256: sha256File(path.join(repoRoot, scene.sceneState.gz ?? scene.sceneState.stream)) } : {}),
    corpusChecksums,
    ...(t ? {
      timings: {
        avgFrameMs: t.avg_frame_ms,
        p50FrameMs: t.p50_frame_ms,
        p99FrameMs: t.p99_frame_ms,
        fps: t.fps,
        measuredFrames: t.measured_frames,
      },
    } : {}),
    twoRunEvidence: {
      runsCompared: 2,
      byteStable: true,
      ...(runs[1].timings ? { runBTimingsAvgFrameMs: runs[1].timings.avg_frame_ms } : {}),
    },
    verdict: {
      byteStable: true,
      driftedPasses: [],
      scope: 'render-job pass hashes (pinned capture clock), one lavapipe build on one CPU model (the adapter of record) — cross-adapter reproducibility NOT claimed (docs/determinism-claim.md)',
    },
  };
  const gp = goldenPath(hardware, sceneId);
  fs.mkdirSync(path.dirname(gp), { recursive: true });
  // Per-pass golden versioning: superseded goldens are archived append-only,
  // so an rgb0 re-record (e.g. WSB4 realism stack landing) preserves prior
  // id0/depth0 history for audit.
  if (fs.existsSync(gp)) {
    const prev = JSON.parse(fs.readFileSync(gp, 'utf8'));
    delete prev.previousVersions;
    golden.previousVersions ??= [];
    golden.previousVersions.push(prev);
  }
  fs.writeFileSync(gp, JSON.stringify(golden, null, 2));
  writeManifest(golden, path.join(artifacts, 'manifest.json'));
  console.log(`[golden-harness] RECORDED golden for ${sceneId} @ ${hardware.gpuFingerprint}`);
  clearUnrecorded(sceneId);
  if (golden.timings) console.log(`  baseline avg_frame_ms=${golden.timings.avgFrameMs.toFixed(3)} p50=${golden.timings.p50FrameMs.toFixed(3)} (lavapipe; informational unless GOLDEN_FRAME_BUDGET is set)`);
  else console.log('  (no timing instrumentation — frame-time gate disabled for this scene)');
  for (const [k, v] of Object.entries(golden.passHashes)) console.log(`  ${k.padEnd(7)} ${v.sha256.slice(0, 16)}…  ${v.bytes}B`);
}

async function cmdVerify(args) {
  const all = args._[1] === undefined || args._[1] === 'all';
  const sceneIds = all
    ? fs.readdirSync(SCENES_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
    : [args._[1]];
  let failed = 0;
  for (const id of sceneIds) {
    try {
      await verifyOne(args, id);
    } catch (e) {
      if (!e.exitCode) throw e;
      console.error(`[golden-harness] ERROR: ${e.message}`);
      failed = Math.max(failed, e.exitCode);
    }
  }
  if (failed) process.exit(failed);
}

class GateFailure extends Error {
  constructor(exitCode, msg) { super(msg); this.exitCode = exitCode; }
}

async function verifyOne(args, sceneId) {
  const scene = applyOverrides(loadScene(sceneId), args.overrides);
  if (scene.recording === 'unrecorded') {
    throw new GateFailure(10, `UNRECORDED: scene ${sceneId} has no recorded pass hashes on any adapter (scene declares recording: "unrecorded"). This is a failure, not a pass: record it with \`node qualification/golden-harness/golden.mjs record ${sceneId}\` on the adapter of record.`);
  }
  const { glbs, corpusRoot } = resolvePaths(scene);
  const binPath = resolveBinary(args);

  const hardware = await collectNativeHardware();
  const gp = goldenPath(hardware, sceneId);
  if (!fs.existsSync(gp)) {
    throw new GateFailure(5, `no golden for gpuFingerprint=${hardware.gpuFingerprint} scene=${sceneId} — record first on this GPU (policy: goldens are per-GPU, never universal)`);
  }
  const golden = JSON.parse(fs.readFileSync(gp, 'utf8'));

  const artifacts = path.join(ARTIFACTS_DIR, 'verify', sceneId);
  fs.mkdirSync(artifacts, { recursive: true });
  const outDir = path.join(artifacts, 'verify-run', sceneId);
  const invocation = buildInvocation(scene, glbs, corpusRoot, outDir);
  const timings = runRenderer(binPath, invocation, 'verify');
  const observed = hashPasses(outDir, scene.expectedPasses, scene);
  const idPasses = checkIdPasses(outDir, scene);
  const parity = checkParity(outDir, scene);

  // Gate 1: pass-hash drift.
  const drifted = Object.entries(golden.passHashes)
    .filter(([k, v]) => !v.diagnostic)
    .filter(([k, v]) => !(observed[k]?.sha256 === v.sha256))
    .map(([k]) => k);

  // Gate 2 (opt-in): frame-time budget vs the recorded baseline, only when
  // GOLDEN_FRAME_BUDGET is set (e.g. 1.10). On lavapipe the times measure
  // the CPU host; one-tick jobs have no timed ticks.
  const budgetFactor = process.env.GOLDEN_FRAME_BUDGET ? Number(process.env.GOLDEN_FRAME_BUDGET) : null;
  const baseline = golden.timings?.avgFrameMs;
  const regressionPct = timings && baseline ? ((timings.avg_frame_ms - baseline) / baseline) * 100 : null;

  const manifest = {
    ...manifestBase({ mode: 'golden-verify', scene, hardware, binPath, invocation, versions: cargoVersions() }),
    passHashes: observed,
    idPasses,
    ...(parity ? { parity } : {}),
    corpusChecksums: golden.corpusChecksums,
    timings: {
      ...(timings ? {
        avgFrameMs: timings.avg_frame_ms, p50FrameMs: timings.p50_frame_ms,
        p99FrameMs: timings.p99_frame_ms, fps: timings.fps, measuredFrames: timings.measured_frames,
      } : {}),
      baselineAvgFrameMs: baseline ?? null,
      regressionPct: regressionPct === null ? null : Number(regressionPct.toFixed(2)),
      budgetFactor,
    },
    verdict: {
      byteStable: drifted.length === 0,
      driftedPasses: drifted,
      frameTimeBudgetExceeded: budgetFactor !== null && regressionPct !== null && regressionPct > (budgetFactor - 1) * 100,
      scope: golden.verdict.scope,
    },
  };
  writeManifest(manifest, path.join(artifacts, 'manifest.json'));

  console.log(`[golden-harness] verify ${sceneId} @ fp=${hardware.gpuFingerprint}:`);
  for (const [k, v] of Object.entries(observed)) {
    const exp = golden.passHashes[k];
    const ok = exp && (exp.sha256 === v.sha256);
    console.log(`  ${ok ? 'MATCH' : 'DRIFT'}  ${k.padEnd(7)} ${v.sha256.slice(0, 16)}…${exp && !ok ? ` (golden ${exp.sha256.slice(0, 16)}…)` : ''}`);
  }
  if (regressionPct !== null) {
    const budget = budgetFactor === null ? 'not gated' : `budget +${((budgetFactor - 1) * 100).toFixed(0)}%`;
    console.log(`  frame-time: ${timings.avg_frame_ms.toFixed(3)} ms vs baseline ${baseline.toFixed(3)} ms → ${regressionPct >= 0 ? '+' : ''}${regressionPct.toFixed(1)}% (${budget})`);
  } else {
    console.log('  frame-time: no timed ticks');
  }

  if (drifted.length > 0) {
    console.error(`[golden-harness] FAIL(${sceneId}): pass-hash drift in: ${drifted.join(', ')}`);
    throw new GateFailure(2, 'pass-hash drift');
  }
  if (manifest.verdict.frameTimeBudgetExceeded) {
    console.error(`[golden-harness] FAIL(${sceneId}): frame-time regression ${regressionPct.toFixed(1)}% exceeds budget`);
    throw new GateFailure(3, 'frame-time budget exceeded');
  }
  console.log(`[golden-harness] PASS ${sceneId}`);
}

// ---------------------------------------------------------------------------

/**
 * Build every job without rendering: proves the scene definitions parse,
 * the corpus resolves (unless --allow-missing-corpus), the scene state
 * lowers, and prints the exact invocation. Jobs land in
 * `<artifacts>/plan/<scene>/<scene>.job.json`.
 */
function cmdPlan(args) {
  const all = args._[1] === undefined || args._[1] === 'all';
  const sceneIds = all
    ? fs.readdirSync(SCENES_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
    : [args._[1]];
  const binPath = [args.bin, process.env.GOLDEN_RENDER_BIN, path.join(repoRoot, 'target/release/simforge-render')]
    .filter(Boolean).find((p) => fs.existsSync(p)) ?? path.join(repoRoot, 'target/release/simforge-render');
  let missingCorpus = 0;
  for (const id of sceneIds) {
    const scene = applyOverrides(loadScene(id), args.overrides);
    const { glbs, corpusRoot, missing } = resolvePaths(scene, { allowMissing: args.allowMissingCorpus });
    missingCorpus += missing.length;
    const outDir = path.join(ARTIFACTS_DIR, 'plan', id, id);
    const invocation = buildInvocation(scene, glbs, corpusRoot, outDir);
    const rig = invocation.job.rig;
    const sensors = new Set([
      ...(rig.cameras ?? []).map((c) => c.sensorId), ...(rig.lidars ?? []).map((l) => l.sensorId),
      ...(rig.radars ?? []).map((r) => r.sensorId),
    ]);
    const unknown = rig.pronto ? [] : Object.values(scene.passPaths).map((p) => p.split('/')[0]).filter((s) => !sensors.has(s));
    if (unknown.length > 0) fail(1, `scene ${id}: passPaths name sensors the rig does not have: ${[...new Set(unknown)].join(', ')}`);
    let ticks = '';
    if (invocation.job.sceneState) {
      const frames = JSON.parse(fs.readFileSync(invocation.job.sceneState, 'utf8'));
      ticks = ` sceneState ${Array.isArray(frames) ? frames.length : frames.frames.length} ticks,`;
    }
    console.log(`[golden-harness] plan ${id}:${scene.recording === 'unrecorded' ? ' UNRECORDED (verify fails, exit 10),' : ''}${ticks} ${invocation.job.ticks ? `ticks ${JSON.stringify(invocation.job.ticks)}, ` : ''}passes ${invocation.job.passes.join(',')}${missing.length ? `, MISSING corpus ${missing.join(', ')}` : ''}`);
    console.log(`  ${binPath} ${invocation.args.join(' ')}`);
    for (const sub of invocation.substitutions) console.log(`  substitution: ${JSON.stringify(sub)}`);
  }
  if (missingCorpus > 0) console.log(`[golden-harness] plan: ${missingCorpus} corpus file(s) missing (--allow-missing-corpus)`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
try {
  if (cmd === 'record' || cmd === 'verify' || cmd === 'plan') await resolvePacks(args._[1]);
  if (cmd === 'record') await cmdRecord(args);
  else if (cmd === 'verify') await cmdVerify(args);
  else if (cmd === 'plan') cmdPlan(args);
  else fail(1, 'usage: golden.mjs <record|verify|plan> <scene|all> [--set dotted.path=value] [--bin path] [--allow-missing-corpus]');
} catch (e) {
  if (e instanceof GateFailure) { console.error(`[golden-harness] ERROR: ${e.message}`); process.exit(e.exitCode); }
  throw e;
}
