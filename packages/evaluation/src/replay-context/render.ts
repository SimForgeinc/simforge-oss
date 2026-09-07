/**
 * Measuring a reconstruction by rendering it.
 *
 * G1 and G2 are the only gates that need pixels, and they are measured with the renderer the
 * product actually ships: the `simforge-oss-splat` durable job workload
 * (`simforge.render-bundle-nurec/v1`, `renderer/splat/python/simforge_splat/job.py`). Nothing
 * here reimplements rendering — it builds the scene-state stream that positions the rig,
 * runs the job, and hands the resulting frames to the Python measurement tool.
 *
 * The scene-state contract is the renderer's, reproduced exactly:
 *
 *   - one `simforge.scene-state.v1` document per tick, `tick`/`tickHz` at the top level;
 *   - `t_us = episode.startTimestampUs + tick / tickHz * 1e6` — the tick index *is* the clock,
 *     which is why the stream is generated on the recorded timebase rather than resampled;
 *   - actor poses are in the SimForge scene frame (y-up, `position = [x, y, z]`, `y = -y_source`);
 *   - the ego actor's position is the *vehicle* origin, so placing the rig at a chosen pose
 *     means inverting `LoadedScene.rig_pose_from_ego`'s centroid offset. Getting this wrong
 *     would move the camera by the rig-to-centroid distance and quietly ruin every fidelity
 *     number, so the inverse is written once, here.
 *
 * Off-trajectory probes displace only the ego. Recorded actors keep their recorded poses —
 * that is precisely the assumption the envelope bounds, and pretending they would react is
 * the fiction the whole gate exists to prevent.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CapabilityError } from './capability.js';
import { deferred } from './deferred.js';
import { poseAt } from './envelope.js';
import { RawBackgroundSchema } from './importers/raw-schema.js';
import {
  DEFAULT_GATE_THRESHOLDS,
  DEFAULT_HEADINGS_RAD,
  DEFAULT_OFFSETS_M,
  gateG1,
  gateG2,
  type FrameFidelity,
  type G2Result,
  type GateThresholds,
  type OffsetCoverage,
} from './gates.js';
import type { GateVerdict, ReplayContext } from './schema.js';

/** Decision rate the closed loop runs at, and therefore the rate probes are rendered at. */
export const PROBE_TICK_HZ = 10;


export interface RenderTier {
  /** `simforge-oss-splat` console script, or an interpreter invocation of it. */
  readonly splatCommand?: readonly string[];
  /** Python interpreter used for the measurement tool. */
  readonly pythonCommand?: string;
  /** GLB catalog roots the job requires (absolute). */
  readonly catalog: readonly string[];
  /** Ego-hood overlay directory, or the literal `none`. Required by the renderer, never defaulted silently. */
  readonly hoodDir: string;
  /** 3DGRUT checkout, exported as `THREEDGRUT_ROOT` for the child process. */
  readonly threedgrutRoot?: string;
}

interface SceneActorDoc {
  readonly id: string;
  readonly kind: 'spawn' | 'update' | 'despawn';
  readonly transform: { readonly position: readonly [number, number, number] };
  readonly yawRad: number;
  readonly velocity: readonly [number, number, number];
}

export interface SceneStateDoc {
  readonly version: 'simforge.scene-state.v1';
  readonly mapId: string;
  readonly frame: 'scene-yup';
  readonly tick: number;
  readonly tickHz: number;
  readonly dt: number;
  readonly actors: readonly SceneActorDoc[];
}

export interface ProbeOffset {
  /** Lateral displacement, metres, positive left of the recorded heading. */
  readonly lateralM: number;
  /** Heading displacement, radians. */
  readonly headingRad: number;
}

export interface SceneDirFacts {
  readonly mapId: string;
  readonly episodeStartUs: number;
  readonly rigCentroidXy: readonly [number, number];
  readonly actorTracks: Record<string, string>;
}

/**
 * Read the renderer-facing facts out of a scene bundle directory.
 *
 * These live in `background.json` because that is the document the splat backend itself
 * loads; reading them from anywhere else would let the two disagree.
 */
export async function readSceneDirFacts(sceneDir: string): Promise<SceneDirFacts> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(sceneDir, 'background.json'), 'utf8'));
  } catch (error) {
    throw new CapabilityError(
      `${sceneDir} is not a renderable scene bundle directory (background.json unreadable: ${(error as Error).message}). `
      + 'Rendering a NuRec package requires the imported scene directory the splat backend loads.',
    );
  }
  const parsed = RawBackgroundSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CapabilityError(
      `${sceneDir}/background.json is malformed: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  const centroid = parsed.data.rigCentroid;
  if (centroid === undefined || centroid.length < 2) {
    throw new CapabilityError(`${sceneDir}/background.json has no usable rigCentroid; cannot place the rig without it`);
  }
  return {
    mapId: path.basename(path.resolve(sceneDir)),
    episodeStartUs: Math.round(parsed.data.episode?.startTimestampUs ?? 0),
    rigCentroidXy: [centroid[0]!, centroid[1]!],
    actorTracks: parsed.data.actorTracks ?? {},
  };
}

/**
 * Ego actor position for a desired rig pose, inverting the importer's centroid convention:
 * the backend reconstructs the rig as `rig = ego − Rz(yaw)·centroid`, so placing the rig at
 * `(x, y)` in the source frame means putting the ego actor at `ego = rig + Rz(yaw)·centroid`.
 */
function egoActorPosition(
  x: number,
  y: number,
  yawRad: number,
  centroid: readonly [number, number],
): [number, number, number] {
  const c = Math.cos(yawRad);
  const s = Math.sin(yawRad);
  const egoX = x + (c * centroid[0] - s * centroid[1]);
  const egoY = y + (s * centroid[0] + c * centroid[1]);
  // Scene frame is y-up with z = −y_source; the vertical channel is resolved by the
  // renderer's ground model, so it is emitted as zero rather than invented here.
  return [egoX, 0, -egoY];
}

/**
 * Build the per-tick scene-state stream that drives one probe.
 *
 * `offset` displaces the ego perpendicular to its recorded heading and rotates it; the
 * recorded actors are placed at their recorded poses for the same instant.
 */
export function buildSceneStateStream(
  bundle: ReplayContext,
  facts: SceneDirFacts,
  offset: ProbeOffset,
  ticks: number,
  tickHz: number = PROBE_TICK_HZ,
): readonly SceneStateDoc[] {
  const docs: SceneStateDoc[] = [];
  const trackByActor = new Map(Object.entries(facts.actorTracks).map(([actorId, trackId]) => [trackId, actorId]));
  for (let tick = 0; tick < ticks; tick += 1) {
    const tUs = Math.round(facts.episodeStartUs + (tick / tickHz) * 1e6);
    const recorded = poseAt(bundle.ego.recordedPath, tUs);
    if (recorded === undefined) break;
    const heading = recorded.headingRad + offset.headingRad;
    // Positive lateral is to the left of the recorded heading.
    const x = recorded.x - Math.sin(recorded.headingRad) * offset.lateralM;
    const y = recorded.y + Math.cos(recorded.headingRad) * offset.lateralM;

    const previous = poseAt(bundle.ego.recordedPath, tUs - Math.round(1e6 / tickHz));
    const velocity: [number, number, number] = previous === undefined
      ? [0, 0, 0]
      : [(recorded.x - previous.x) * tickHz, 0, -(recorded.y - previous.y) * tickHz];

    const actors: SceneActorDoc[] = [
      {
        id: 'ego',
        kind: tick === 0 ? 'spawn' : 'update',
        transform: { position: egoActorPosition(x, y, heading, facts.rigCentroidXy) },
        yawRad: heading,
        velocity,
      },
    ];
    for (const track of bundle.dynamics.tracks) {
      const actorId = trackByActor.get(track.trackId);
      if (actorId === undefined) continue;
      const first = track.samples[0]!;
      const last = track.samples[track.samples.length - 1]!;
      if (tUs < first.tUs || tUs > last.tUs) continue;
      const sample = poseAt(
        track.samples.map((entry) => ({ tUs: entry.tUs, x: entry.x, y: entry.y, headingRad: entry.headingRad })),
        tUs,
      );
      if (sample === undefined) continue;
      actors.push({
        id: actorId,
        kind: 'update',
        transform: { position: [sample.x, 0, -sample.y] },
        yawRad: sample.headingRad,
        velocity: [0, 0, 0],
      });
    }
    docs.push({
      version: 'simforge.scene-state.v1',
      mapId: facts.mapId,
      frame: 'scene-yup',
      tick,
      tickHz,
      dt: 1 / tickHz,
      actors,
    });
  }
  return docs;
}

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
  const { promise, resolve, reject } = deferred<CommandResult>();
  const child = spawn(command, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  child.on('error', reject);
  child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  return promise;
}

/**
 * Render one probe with the splat job runner.
 *
 * The job's exit codes are its contract (`job.py`): 1 is bad params, 2 is a prerequisite or
 * backend failure — a missing 3DGRUT checkout, no CUDA, an unreachable package. Both surface
 * as `CapabilityError` so the compute worker reports a non-retryable `capability_error`
 * instead of burning attempts on a machine that will never satisfy the request.
 */
export async function renderProbe(
  bundle: ReplayContext,
  sceneDir: string,
  facts: SceneDirFacts,
  offset: ProbeOffset,
  ticks: number,
  outDir: string,
  tier: RenderTier,
): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const stream = buildSceneStateStream(bundle, facts, offset, ticks);
  if (stream.length === 0) {
    throw new CapabilityError(
      `scene ${bundle.sceneId}: the recorded ego path does not cover the episode window, so no probe tick could be built`,
    );
  }
  const statePath = path.join(outDir, 'scene-state.json');
  await writeFile(statePath, JSON.stringify(stream), 'utf8');

  const params = {
    scenesRoot: path.dirname(path.resolve(sceneDir)),
    catalog: [...tier.catalog],
    hoodDir: tier.hoodDir,
    sourcePackages: [{ sha256: bundle.geometry.sourcePackageSha256, path: path.resolve(bundle.geometry.sourcePackage) }],
    scene: facts.mapId,
    rig: bundle.cameras.map((camera) => ({ sensorId: camera.sensorId })),
    passes: ['rgb', 'depth'],
    sceneStatePath: statePath,
    ticks: stream.length,
    checkpointEveryTicks: 0,
  };
  const paramsPath = path.join(outDir, 'params.json');
  await writeFile(paramsPath, JSON.stringify(params, null, 2), 'utf8');

  const command = tier.splatCommand ?? ['simforge-oss-splat'];
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (tier.threedgrutRoot !== undefined) env['THREEDGRUT_ROOT'] = tier.threedgrutRoot;
  const result = await run(command[0]!, [...command.slice(1), 'job', '--params', paramsPath, '--out-dir', outDir], env);
  if (result.code === 0) return outDir;
  const detail = result.stderr.trim() || result.stdout.trim();
  if (result.code === 2) {
    throw new CapabilityError(
      `the NuRec render tier is not available on this host: ${detail}. `
      + 'It needs a CUDA GPU, a 3DGRUT checkout (THREEDGRUT_ROOT) with its compiled tracer, Kaolin, and the source package.',
    );
  }
  throw new CapabilityError(`simforge-oss-splat job failed (exit ${result.code}): ${detail}`);
}

/**
 * The Python measurement tool that owns all pixel comparison.
 *
 * Resolved next to this module by default, which works from source and from a packaged build:
 * the package build copies `src/replay-context/python` into `dist/replay-context/python`, so
 * the relative path holds in both. `SIMFORGE_REPLAY_MEASURE` is an override for a worker image
 * that places the tool elsewhere, not a requirement.
 */
function measureToolPath(): string {
  return process.env['SIMFORGE_REPLAY_MEASURE'] ?? fileURLToPath(new URL('./python/replay_measure.py', import.meta.url));
}

export interface ProbeMeasurement {
  readonly perCamera: readonly FrameFidelity[];
  readonly holeFraction: number;
  readonly worstCamera: string;
}

/**
 * Compare a probe's renders against the package's recorded frames.
 *
 * Both the recorded JPEGs (inside the `.usdz`) and the rendered PNG/NPY outputs are read by
 * the Python tool, which is where the imaging stack lives. For an off-trajectory probe the
 * on-trajectory render is passed as the baseline so the reported hole fraction is *newly*
 * unsupported pixels rather than the scene's standing sky fraction.
 */
export async function measureProbe(
  bundle: ReplayContext,
  facts: SceneDirFacts,
  probeDir: string,
  baselineDir: string | undefined,
  tier: RenderTier,
): Promise<ProbeMeasurement> {
  const args = [
    measureToolPath(),
    '--package', path.resolve(bundle.geometry.sourcePackage),
    '--render-dir', probeDir,
    '--cameras', bundle.cameras.map((camera) => `${camera.cameraId}:${camera.sensorId}`).join(','),
    // The renderer's own clock, so a rendered tick is compared with the frame it depicts.
    '--episode-start-us', String(facts.episodeStartUs),
    '--tick-hz', String(PROBE_TICK_HZ),
  ];
  if (baselineDir !== undefined) args.push('--baseline-dir', baselineDir);
  const result = await run(tier.pythonCommand ?? 'python3', args, { ...process.env });
  if (result.code !== 0) {
    throw new CapabilityError(
      `replay_measure.py failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}. `
      + 'It requires numpy and Pillow.',
    );
  }
  const parsed = JSON.parse(result.stdout) as {
    perCamera: FrameFidelity[];
    holeFraction: number;
    worstCamera: string;
  };
  return parsed;
}

export interface QualifyOptions {
  readonly bundle: ReplayContext;
  /** Scene bundle directory the splat backend loads (contains background.json). */
  readonly sceneDir: string;
  /** Where probe renders are written. */
  readonly workDir: string;
  readonly tier: RenderTier;
  readonly offsetsM?: readonly number[];
  readonly headingsRad?: readonly number[];
  /** Ticks rendered per probe. Ten seconds at 10 Hz by default. */
  readonly ticks?: number;
  readonly thresholds?: GateThresholds;
  /**
   * Longitudinal freedom, seconds. Bounded by how far the ego may drift in time before the
   * replayed actors are meaningfully desynchronised; defaults to one decision period.
   */
  readonly longitudinalS?: number;
}

export interface QualifyResult {
  readonly G1: GateVerdict;
  readonly G2: G2Result;
  readonly probes: readonly { readonly offset: ProbeOffset; readonly measurement: ProbeMeasurement; readonly dir: string }[];
}

/**
 * Run the pixel gates: one on-trajectory probe for G1, then the off-trajectory probes whose
 * largest passing offset becomes the envelope.
 *
 * Probes are rendered smallest-offset-first and the sweep stops at the first failure: once
 * 0.5 m has failed there is no honest reading of a 1.5 m pass, and rendering it anyway would
 * cost GPU minutes to produce a number we would then have to discard.
 */
export async function qualifyRenders(options: QualifyOptions): Promise<QualifyResult> {
  const { bundle, sceneDir, workDir, tier } = options;
  const facts = await readSceneDirFacts(sceneDir);
  const ticks = options.ticks ?? PROBE_TICK_HZ * 10;
  const thresholds = options.thresholds ?? DEFAULT_GATE_THRESHOLDS;

  const baselineDir = path.join(workDir, 'probe-on-trajectory');
  await renderProbe(bundle, sceneDir, facts, { lateralM: 0, headingRad: 0 }, ticks, baselineDir, tier);
  const baseline = await measureProbe(bundle, facts, baselineDir, undefined, tier);
  const G1 = gateG1(baseline.perCamera, thresholds);

  const probes: { offset: ProbeOffset; measurement: ProbeMeasurement; dir: string }[] = [
    { offset: { lateralM: 0, headingRad: 0 }, measurement: baseline, dir: baselineDir },
  ];
  const coverage: OffsetCoverage[] = [];

  for (const lateralM of options.offsetsM ?? DEFAULT_OFFSETS_M) {
    const dir = path.join(workDir, `probe-lateral-${String(lateralM).replace('.', 'p')}`);
    await renderProbe(bundle, sceneDir, facts, { lateralM, headingRad: 0 }, ticks, dir, tier);
    const measurement = await measureProbe(bundle, facts, dir, baselineDir, tier);
    probes.push({ offset: { lateralM, headingRad: 0 }, measurement, dir });
    coverage.push({ lateralM, headingRad: 0, holeFraction: measurement.holeFraction, worstCamera: measurement.worstCamera });
    if (measurement.holeFraction > thresholds.offTrajectoryHoleFraction) break;
  }
  for (const headingRad of options.headingsRad ?? DEFAULT_HEADINGS_RAD) {
    const dir = path.join(workDir, `probe-heading-${headingRad.toFixed(3).replace('.', 'p')}`);
    await renderProbe(bundle, sceneDir, facts, { lateralM: 0, headingRad }, ticks, dir, tier);
    const measurement = await measureProbe(bundle, facts, dir, baselineDir, tier);
    probes.push({ offset: { lateralM: 0, headingRad }, measurement, dir });
    coverage.push({ lateralM: 0, headingRad, holeFraction: measurement.holeFraction, worstCamera: measurement.worstCamera });
    if (measurement.holeFraction > thresholds.offTrajectoryHoleFraction) break;
  }

  return { G1, G2: gateG2(coverage, options.longitudinalS ?? 1 / PROBE_TICK_HZ, thresholds), probes };
}
