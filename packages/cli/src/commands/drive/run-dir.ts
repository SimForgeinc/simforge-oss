import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';
import {
  describeArtifact,
  parseTraceJsonl,
  scoreEpisode,
  writeResultManifest,
  type EpisodeScore,
  type ResultManifest,
  type ScenarioScoringContext,
} from '@simforge-oss/evaluation';
import { assessDriveModelHealth } from '@simforge-oss/evaluation/drive-evidence';
import type { ActorModelCatalogs } from './scene.js';


export interface RunDirectoryConfig {
  readonly root: string;
  readonly scenarioId: string;
  readonly mapId: string;
  readonly seed: number;
  readonly policyId: string;
  readonly cameraProfile: string;
  readonly decisionHz: number;
  readonly mode: 'offline-simtime' | 'realtime';
  readonly deadlineMs: number | null;
  readonly durationS: number;
  readonly warmupFrames: number;
  readonly gitSha: string;
  readonly replanHz?: number;
  readonly scenarioInputSha256?: string;
  readonly graphDigest?: string;
  readonly appearance?: { readonly identity: string; readonly model: string; readonly policyInput: 'raw' | 'enhanced' };
  /** Catalog packs the render service loaded actor GLBs from, with sidecar digests. */
  readonly actorModels?: ActorModelCatalogs;
  readonly recordControls?: boolean;
}

/** Kernel completion is the authority for episode status, timing and counts. */
export interface EpisodeResultCore {
  readonly schema: 'simforge.episode-result-core/v1';
  readonly status: 'succeeded' | 'partial';
  readonly truncation: string | null;
  readonly termReason: string | null;
  readonly mode: 'offline-simtime' | 'realtime';
  readonly timing: { wallMs: number; simulationS: number; policySimulationS: number };
  readonly decisions: number;
  readonly warmupDecisions: number;
  readonly deadlineMisses: number;
  readonly episodeDigest: string;
}

export interface FinalizeRunOptions {
  readonly actorKinds: Readonly<Record<string, string>>;
  readonly expectedRouteM: number;
  /** Model identity taken from the endpoint's `hello`; unreported fields stay null. */
  readonly model: Record<string, unknown>;
  readonly modelHealth: Record<string, unknown>;
  readonly episode: EpisodeResultCore;
  readonly scoringContext?: Partial<ScenarioScoringContext>;
  readonly authoredRouteLengthM?: number;
}

export interface RunFinalization {
  readonly score: EpisodeScore;
  readonly scorePath: string;
  readonly resultPath: string;
  readonly runDir: string;
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Run directory name; `verify` recomputes it from `run.json`. */
export function safeRunId(scenarioId: string, policyId: string, seed: number): string {
  return `${scenarioId}__${policyId}__seed${seed}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
}


/** Persistent evidence writer. `result.json` is deliberately written last. */
export class RunDirectory {
  readonly runId: string;
  readonly dir: string;
  readonly config: RunDirectoryConfig;
  private readonly frameDigests: Record<string, string[]> = {};
  private readonly passFrameDigests: Record<string, Record<string, string[]>> = {};
  private frameCount = 0;
  private stepCount = 0;
  private startedAt = new Date().toISOString();
  private traceText = '';

  private constructor(config: RunDirectoryConfig) {
    this.config = config;
    this.runId = safeRunId(config.scenarioId, config.policyId, config.seed);
    this.dir = path.join(path.resolve(config.root), this.runId);
  }

  static async create(config: RunDirectoryConfig): Promise<RunDirectory> {
    const run = new RunDirectory(config);
    // A rerun cannot retain an old completion marker or leftover frame indices.
    await rm(path.join(run.dir, 'result.json'), { force: true });
    await rm(path.join(run.dir, 'frames'), { recursive: true, force: true });
    for (const name of ['frames-enhanced', 'frames-depth', 'frames-seg']) await rm(path.join(run.dir, name), { recursive: true, force: true });
    for (const name of ['appearance.jsonl', 'appearance-runtime.json']) await rm(path.join(run.dir, name), { force: true });
    await mkdir(path.join(run.dir, 'frames'), { recursive: true });
    await writeFile(path.join(run.dir, 'steps.jsonl'), '', 'utf8');
    await writeFile(path.join(run.dir, 'trace.jsonl'), '', 'utf8');
    await writeFile(path.join(run.dir, 'log.txt'), '', 'utf8');
    await run.writeConfig();
    return run;
  }

  async log(message: string): Promise<void> {
    await appendFile(path.join(this.dir, 'log.txt'), `${new Date().toISOString()} ${message}\n`, 'utf8');
  }

  async writeFrame(sensorId: string, frameIndex: number, rgba: Buffer, width: number, height: number, pass = 'rgb'): Promise<void> {
    const dir = path.join(this.dir, pass === 'rgb' ? 'frames' : `frames-${pass}`, sensorId);
    await mkdir(dir, { recursive: true });
    const png = pass === 'depth' ? rgba : await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
    await writeFile(path.join(dir, `${frameIndex}.${pass === 'depth' ? 'f32' : 'png'}`), png);
    const digests = pass === 'rgb' ? this.frameDigests : (this.passFrameDigests[pass] ??= {});
    (digests[sensorId] ??= []).push(createHash('sha256').update(png).digest('hex'));
    this.frameCount += 1;
  }

  async writeStep(row: Record<string, unknown>): Promise<void> {
    await appendFile(path.join(this.dir, 'steps.jsonl'), line(row), 'utf8');
    this.stepCount += 1;
  }

  async writeTrace(text: string): Promise<void> {
    this.traceText = text;
    await writeFile(path.join(this.dir, 'trace.jsonl'), text, 'utf8');
  }

  async finish(options: FinalizeRunOptions): Promise<RunFinalization> {
    if (this.stepCount <= 0) throw new Error('cannot finalize a drive with no decision steps');
    const core = options.episode;
    if (core.decisions !== this.stepCount || core.deadlineMisses !== options.modelHealth['deadlineMisses']) throw new Error('kernel result and drive evidence counts disagree');
    const truncation = core.termReason === 'collision' || core.termReason === 'goal' ? 'terminated'
      : core.truncation === 'envelope_exceeded' ? 'envelope_exceeded' : core.truncation ? 'truncated' : null;
    const parsed = parseTraceJsonl(this.traceText);
    const score = scoreEpisode(parsed, {
      decisionHz: this.config.decisionHz,
      actorKinds: options.actorKinds,
      expectedRouteM: options.authoredRouteLengthM === undefined ? options.expectedRouteM
        : Math.max(0.001, options.authoredRouteLengthM - (parsed.reset?.sv?.[8] ?? 0)),
      speedLimitMps: null,
      metricVersion: 'v1',
      ...options.scoringContext,
    } satisfies ScenarioScoringContext);
    const scoreDocument = {
      schema: 'simforge.eval-score/v1',
      runId: this.runId,
      mode: core.mode,
      truncation,
      scoredThroughStep: score.steps,
      metricVersion: score.metricVersion,
      unavailable: score.unavailable,
      worstOffRoadM: score.worstOffRoadM,
      offRoad: score.offRoad,
      drivingScore: score.drivingScore,
      ...(score['alpasim-style-score'] ? { 'alpasim-style-score': score['alpasim-style-score'] } : {}),
      routeCompletion: score.routeCompletion,
      penaltyProduct: score.penaltyProduct,
      infractions: score.infractions,
      ttc: score.ttc,
      comfort: score.comfort,
      terminal: score.terminal,
      steps: score.steps,
      deadlineMisses: score.deadlineMisses,
      deadlineMissRate: this.config.mode === 'realtime' && score.steps > 0 ? score.deadlineMisses / score.steps : null,
    };
    const scorePath = path.join(this.dir, 'score.json');
    await writeFile(scorePath, `${JSON.stringify(scoreDocument, null, 2)}\n`, 'utf8');
    const completedAt = new Date().toISOString();
    await this.writeConfig({ finishedAt: completedAt, steps: this.stepCount, frames: this.frameCount, frameDigests: this.frameDigests,
      ...(Object.keys(this.passFrameDigests).length ? { passFrameDigests: this.passFrameDigests } : {}), model: options.model });

    const artifacts = [];
    const artifactSpecs: readonly [string, Parameters<typeof describeArtifact>[2], string | undefined][] = [
      ['score.json', 'score', 'application/json'],
      ['trace.jsonl', 'trace', 'application/jsonl'],
      ['steps.jsonl', 'runner-summary', 'application/jsonl'],
      ['run.json', 'provenance', 'application/json'],
      ['log.txt', 'log', 'text/plain'],
    ];
    for (const [file, role, mediaType] of artifactSpecs) {
      artifacts.push(await describeArtifact(this.dir, file, role, mediaType));
    }
    artifacts.push(await describeArtifact(this.dir, 'drive.mp4', 'video', 'video/mp4'));
    if (this.config.appearance) {
      artifacts.push(await describeArtifact(this.dir, 'appearance.jsonl', 'runner-summary', 'application/jsonl'));
      artifacts.push(await describeArtifact(this.dir, 'appearance-runtime.json', 'provenance', 'application/json'));
    }
    const firstFrame = Object.values(this.frameDigests)[0]?.length ? Object.keys(this.frameDigests)[0] : undefined;
    if (firstFrame) {
      const framePath = path.join('frames', firstFrame!, '0.png');
      try { artifacts.push(await describeArtifact(this.dir, framePath, 'frames', 'image/png')); } catch { /* optional */ }
    }
    const model = options.model;
    const modelHealth = assessDriveModelHealth(options.modelHealth);
    const manifest: ResultManifest = {
      schema: 'simforge.eval-result-manifest/v1',
      kind: 'closedloop-episode',
      runId: this.runId,
      attemptId: null,
      jobId: null,
      workspaceId: null,
      status: core.status,
      scored: true,
      promotable: core.status === 'succeeded' && modelHealth.healthy,
      exploratory: core.status !== 'succeeded' || !modelHealth.healthy,
      mode: core.mode,
      truncation,
      metrics: {
        drivingScore: score.drivingScore,
        ...(score['alpasim-style-score'] ? { 'alpasim-style-score': score['alpasim-style-score'] } : {}),
        routeCompletion: score.routeCompletion,
        infractions: score.infractions,
        steps: score.steps,
        deadlineMisses: score.deadlineMisses,
        modelHealth: options.modelHealth,
      },
      artifacts,
      provenance: {
        model: {
          family: typeof model['family'] === 'string' ? model['family'] : this.config.policyId,
          revision: typeof model['revision'] === 'string' ? model['revision'] : null,
          checkpointDigest: typeof model['checkpointDigest'] === 'string' ? model['checkpointDigest'] : null,
          quant: typeof model['quant'] === 'string' ? model['quant'] : null,
          attn: null,
          torch: null,
          cuda: null,
          diffusionSteps: null,
          numTrajSamples: null,
          cameraProfile: this.config.cameraProfile,
          rngProvenance: { seed: this.config.seed },
          determinismScope: 'same-host-same-device',
        },
        input: { kind: 'scenario', ref: this.config.scenarioId, digest: this.config.scenarioInputSha256 ?? null, ood: [], replayContext: null },
        runtime: { gitSha: this.config.gitSha },
        controller: { policyId: this.config.policyId, decisionHz: this.config.decisionHz },
        compute: null,
        metricVersion: score.metricVersion,
        reprocessedFrom: null,
      },
      timing: {
        startedAt: this.startedAt,
        completedAt,
        durationMs: Math.max(0, Math.round(Date.parse(completedAt) - Date.parse(this.startedAt))),
        executionMs: Math.round(core.timing.wallMs),
      },
      error: null,
    };
    const resultPath = await writeResultManifest(this.dir, manifest);
    return { score, scorePath, resultPath, runDir: this.dir };
  }

  private async writeConfig(extra: Record<string, unknown> = {}): Promise<void> {
    const config = {
      schema: 'simforge.drive-run/v1',
      scenarioId: this.config.scenarioId,
      mapId: this.config.mapId,
      seed: this.config.seed,
      policy: this.config.policyId,
      policyId: this.config.policyId,
      model: null,
      cameraProfile: this.config.cameraProfile,
      decisionHz: this.config.decisionHz,
      mode: this.config.mode,
      deadlineMs: this.config.deadlineMs,
      durationS: this.config.durationS,
      warmupFrames: this.config.warmupFrames,
      gitSha: this.config.gitSha,
      ...(this.config.replanHz === undefined ? {} : { replanHz: this.config.replanHz }),
      ...(this.config.scenarioInputSha256 ? { scenarioInputSha256: this.config.scenarioInputSha256 } : {}),
      ...(this.config.graphDigest ? { graphDigest: this.config.graphDigest } : {}),
      ...(this.config.appearance ? { appearance: this.config.appearance } : {}),
      ...(this.config.actorModels ? { actorModels: this.config.actorModels } : {}),
      ...(this.config.recordControls ? { controls: { passes: ['rgb', 'depth', 'seg'], depthFormat: 'reverse-z-f32-le',
        segFormat: 'carla-class-id-blue', cameras: 'trace.jsonl reset.options.observation.channels' } } : {}),
      ...extra,
    };
    const target = path.join(this.dir, 'run.json');
    const scratch = `${target}.partial`;
    await writeFile(scratch, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await rename(scratch, target);
  }
}

export async function readRunJson(runDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(runDir, 'run.json'), 'utf8')) as Record<string, unknown>;
}
