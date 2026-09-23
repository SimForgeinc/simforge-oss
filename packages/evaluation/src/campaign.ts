/**
 * Closed-loop evaluation campaigns: scenario × seed × policy episode grids
 * run SEQUENTIALLY through the native gym episode runner
 * (`adapters/gym`, `python -m simforge_oss_gym.tools.policy_runner`), scored
 * by `scoring.ts`, persisted as immutable per-episode artifact directories
 * with an append-only ledger.
 *
 * A policy is either a reference policy (`scripted`, `trajectory`, `torch`) or
 * a real model endpoint (`endpoint`), which the runner drives over the
 * `simforge.policy-endpoint/v2` MessagePack socket with real rendered camera
 * frames. Each policy declares its timing mode: `offline-simtime` (the engine
 * pauses at every inference barrier — the default, and the only mode whose
 * numbers are hardware-independent) or `realtime` (explicit deadline, measured
 * latency, fallback accounting).
 *
 * Layout (under `<runsRoot>/<campaignId>/`):
 *
 *   campaign.json      frozen resolved spec (fixture digests pin immutability)
 *   ledger.jsonl       append-only; one line per completed episode
 *                      (readers take the LAST line per episodeId)
 *   report.json/.md    aggregation (written by `writeReport`)
 *   <episodeId>/       episodeId = <scenarioId>__<policyId>__seed<seed>
 *     trace.jsonl        episode-runner rich trace (digest-chained)
 *     runner-summary.json  runner stdout (status, episode digest, timing)
 *     events.json        per-event records (tick + position)
 *     score.json         route-completion × infraction-penalty score
 *     provenance.json    checkpoint digest, adapter version, seed, schedule
 *     COMPLETE           marker written last; dirs without it are rerun
 *     result.json        simforge.eval-result-manifest/v1, written LAST
 *
 * Kill/resume is idempotent: completed episodes are recognized by their
 * COMPLETE marker and skipped; anything else is wiped and rerun. Reruns of
 * a completed episode (`rerunEpisode`) go to a scratch dir and must
 * reproduce the stored `episode_digest` byte-for-byte for deterministic
 * policies.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';
import { canonicalJson } from '@simforge-oss/engine';

import {
  parseTraceJsonl,
  scoreEpisode,
  verifyEpisodeTrace,
  type EpisodeScore,
  type InfractionType,
  type ScenarioScoringContext,
  type ScoringConfig,
} from './scoring.js';
import {
  describeArtifact,
  writeResultManifest,
  type EvalArtifact,
  type ResultManifest,
  type ResultStatus,
} from './protocol/manifest.js';
import {
  loadReplayContext,
  replayContextInputRef,
  type ReplayContext,
} from './replay-context/index.js';
import { APPROXIMATED_EXTRINSICS_OOD, rigHasApproximatedExtrinsics } from './protocol/params.js';

import {
  FINAL_EPISODE_STATUSES as FINAL_STATUSES,
  RUNNER_DIR,
  REPO_ROOT,
  RUNNER_MODULE,
  runEpisodeSync,
  type RunnerOutcome,
} from './episode-runner.js';

export { REPO_ROOT } from './episode-runner.js';

/** Engine default when a lane names no limit (lane-graph DEFAULT_SPEED_LIMIT_MPS). */
const DEFAULT_SPEED_LIMIT_MPS = 13.4;

/* ------------------------------------------------------------------ config */

const scenarioSchema = z.object({
  scenarioId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** Episode spec file for the env-server, relative to the config file. */
  spec: z.string(),
  /** Env session (scenario instance) index inside the spec. */
  session: z.number().int().nonnegative().default(0),
  /** Decision budget per episode. */
  steps: z.number().int().positive(),
  /** Route-completion denominator; null derives cruiseSpeed × clipSeconds. */
  expectedRouteM: z.number().positive().nullable().default(null),
  /** Authored speed limit override; null derives it from the fixture topology. */
  speedLimitMps: z.number().positive().nullable().default(null),
  /** Per-scenario scoring overrides (thresholds, penalty factors). */
  scoring: z.record(z.string(), z.unknown()).default({}),
  /**
   * `simforge.replay-context/v1` bundle directory (relative to the config).
   * Enables off-trajectory envelope enforcement: an episode that leaves the
   * measured envelope is truncated with `envelope_exceeded` and scored up to
   * that point. A model episode on an unqualified bundle is refused.
   */
  replayContext: z.string().nullable().default(null),
  /**
   * Camera frames for model episodes: `bevy:<rig.json>` selects the kernel
   * Episode Cameras channel. Prerecorded images cannot reflect policy-diverged
   * state and are not a closed-loop source.
   */
  frameSource: z.string().nullable().default(null),
  alpasimStyle: z.object({ authoredRoute: z.array(z.tuple([z.number().finite(), z.number().finite()])).min(2), egoId: z.string().optional() }).optional(),
});

const policySchema = z
  .object({
    policyId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    /** Runner policy name (`--policy`). `endpoint` drives a real model. */
    runnerPolicy: z.enum(['scripted', 'trajectory', 'endpoint', 'recorded-path']),
    policySeed: z.number().int().nonnegative().default(0),
    /** Closed-loop timing mode; a run carries exactly one. */
    mode: z.enum(['offline-simtime', 'realtime']).default('offline-simtime'),
    /** Required in `realtime`, forbidden in `offline-simtime`. */
    deadlineMs: z.number().positive().nullable().default(null),
    fallback: z.enum(['repeat-last', 'zero-control', 'scripted']).default('zero-control'),
    /** `realtime` only: steps whose reported latency is forced over budget. */
    forceMissAt: z.array(z.number().int().nonnegative()).default([]),
    execution: z.enum(['pure-pursuit', 'speed-setpoint']).default('pure-pursuit'),
    /* --- model endpoint (runnerPolicy: 'endpoint') --- */
    endpointSocket: z.string().nullable().default(null),
    cameraProfile: z.string().default('alpamayo-4cam'),
    /** Model replan cadence; the executor holds the plan in between (ZOH). */
    replanHz: z.number().positive().nullable().default(null),
    numTrajSamples: z.number().int().min(1).max(64).nullable().default(null),
    navText: z.string().nullable().default(null),
    /** Refuse the episode unless the endpoint reports this identity. */
    model: z
      .object({
        family: z.string().nullable().default(null),
        revision: z.string().nullable().default(null),
        quant: z.string().nullable().default(null),
      })
      .nullable()
      .default(null),
    /** Decisions driven by a reference policy to build the model's history. */
    warmupPolicy: z.enum(['scripted', 'trajectory']).nullable().default(null),
    warmupSteps: z.number().int().nonnegative().nullable().default(null),
    /** Permit a replicated oldest frame (stamped in provenance). */
    allowColdStart: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'realtime' && !value.deadlineMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deadlineMs'],
        message: `policy ${value.policyId}: realtime mode requires an explicit deadlineMs`,
      });
    }
    if (value.mode === 'offline-simtime' && value.deadlineMs !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deadlineMs'],
        message: `policy ${value.policyId}: offline-simtime has no deadline (the barrier is the loop); use mode 'realtime' to enforce one`,
      });
    }
    if (value.mode === 'offline-simtime' && value.forceMissAt.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['forceMissAt'],
        message: `policy ${value.policyId}: forceMissAt is meaningless without a deadline`,
      });
    }
    if (value.runnerPolicy === 'endpoint' && !value.endpointSocket) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endpointSocket'],
        message: `policy ${value.policyId}: the endpoint policy needs endpointSocket`,
      });
    }
  });

export const campaignConfigSchema = z.object({
  campaignId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  runsRoot: z.string().default('~/simforge-assets/runs'),
  decisionHz: z.number().int().positive().default(10),
  suite: z.array(scenarioSchema).min(1),
  seeds: z.array(z.union([z.number().int(), z.string()])).min(1),
  policies: z.array(policySchema).min(1),
});

export type CampaignConfig = z.infer<typeof campaignConfigSchema>;
export type CampaignScenario = z.infer<typeof scenarioSchema>;
export type CampaignPolicy = z.infer<typeof policySchema>;

export interface EpisodePlan {
  readonly episodeId: string;
  readonly scenario: CampaignScenario;
  readonly policy: CampaignPolicy;
  readonly seed: number | string;
}

export interface ResolvedCampaign {
  readonly config: CampaignConfig;
  readonly configDir: string;
  readonly campaignDir: string;
  readonly episodes: readonly EpisodePlan[];
  /** scenarioId → derived scoring context + fixture digest. */
  readonly scenarios: ReadonlyMap<string, ResolvedScenario>;
}

export interface ResolvedScenario {
  readonly scenario: CampaignScenario;
  readonly specPath: string;
  readonly fixtureSha256: string;
  readonly context: ScenarioScoringContext;
  readonly scoring: Partial<ScoringConfig>;
  /** Resolved replay-context bundle (absolute) and its validity summary. */
  readonly replayContextDir: string | null;
  readonly replayContext: ReplayContext | null;
  /** Resolved frame-source spec with any relative `bevy:` path made absolute. */
  readonly frameSource: string | null;
}

/* ------------------------------------------------- fixture context derivation */

export interface FixtureFacts {
  readonly actorKinds: Record<string, string>;
  readonly egoId: string | null;
  readonly cruiseSpeedMps: number | null;
  readonly clipSeconds: number | null;
  readonly signalsPresent: boolean;
  readonly speedLimitMps: number;
  /** The ego's authored box, for footprint-based scoring; null when unauthored. */
  readonly egoDims: { readonly lengthM: number; readonly widthM: number } | null;
}

/**
 * Pull the authored facts scoring needs out of an episode spec (form A).
 * Mirrors the env-server's instance resolution for inline/path instances.
 *
 * Exported because a single cloud episode is scored without a campaign
 * config, and its scoring context must be derived identically.
 */
export async function fixtureFacts(specPath: string, session: number): Promise<FixtureFacts> {
  const specDir = path.dirname(specPath);
  const spec = JSON.parse(await readFile(specPath, 'utf8')) as Record<string, unknown>;
  const instances = spec['instances'];
  if (!Array.isArray(instances) || instances.length <= session) {
    throw new Error(`${specPath}: no instance ${session} (campaigns need form-A specs)`);
  }
  let entry: unknown = instances[session];
  if (typeof entry === 'string') {
    entry = { input: entry };
  }
  const entryObj = entry as { input: unknown; topology?: unknown };
  let input = entryObj.input;
  if (typeof input === 'string') {
    input = JSON.parse(await readFile(path.resolve(specDir, input), 'utf8'));
  }
  // Unwrap the CLI's scenario-instance envelope.
  const inputObj = input as Record<string, unknown>;
  const unwrapped = (
    inputObj['kind'] === 'scenario-instance' && inputObj['input'] !== undefined
      ? inputObj['input']
      : inputObj
  ) as Record<string, unknown>;

  const actors = Array.isArray(unwrapped['actors']) ? (unwrapped['actors'] as Array<Record<string, unknown>>) : [];
  const actorKinds: Record<string, string> = {};
  for (const actor of actors) {
    if (typeof actor['id'] === 'string' && typeof actor['kind'] === 'string') {
      actorKinds[actor['id']] = actor['kind'];
    }
  }
  const vehicleIds = actors
    .filter((a) => a['kind'] === 'vehicle' && typeof a['id'] === 'string')
    .map((a) => a['id'] as string)
    .sort();
  const egoId = typeof unwrapped['metricSubject'] === 'string' ? unwrapped['metricSubject'] : vehicleIds[0] ?? null;
  const ego = actors.find((a) => a['id'] === egoId);
  const behavior = (ego?.['behavior'] ?? {}) as Record<string, unknown>;
  const initial = (ego?.['initial'] ?? {}) as Record<string, unknown>;
  const cruiseSpeedMps =
    typeof behavior['cruiseSpeedMps'] === 'number'
      ? behavior['cruiseSpeedMps']
      : typeof initial['speedMps'] === 'number'
        ? initial['speedMps']
        : null;

  const conditions = (unwrapped['operationalConditions'] ?? {}) as Record<string, unknown>;
  const effects = (conditions['effects'] ?? {}) as Record<string, unknown>;
  const trafficSpeedFactor = typeof effects['trafficSpeedFactor'] === 'number' ? effects['trafficSpeedFactor'] : 1;

  // Authored limit: the ego route's start lane, else any lane, else default.
  let topology = entryObj.topology ?? spec['topology'];
  if (typeof topology === 'string') {
    topology = JSON.parse(await readFile(path.resolve(specDir, topology), 'utf8'));
  }
  const lanes = ((topology as Record<string, unknown> | undefined)?.['lanes'] ?? {}) as Record<
    string,
    { speedLimitKph?: number | null }
  >;
  const route = (behavior['route'] ?? {}) as Record<string, unknown>;
  const startRsl = typeof route['startRsl'] === 'string' ? route['startRsl'] : null;
  const laneLimits = Object.values(lanes)
    .map((l) => l.speedLimitKph)
    .filter((v): v is number => typeof v === 'number' && v > 0);
  const startLimit = startRsl ? lanes[startRsl]?.speedLimitKph : undefined;
  const limitKph = typeof startLimit === 'number' && startLimit > 0 ? startLimit : laneLimits[0];
  const speedLimitMps = (limitKph !== undefined ? limitKph / 3.6 : DEFAULT_SPEED_LIMIT_MPS) * trafficSpeedFactor;

  const dims = (ego?.['dims'] ?? {}) as Record<string, unknown>;
  const egoDims =
    typeof dims['l'] === 'number' && typeof dims['w'] === 'number'
      ? { lengthM: dims['l'], widthM: dims['w'] }
      : null;

  return {
    actorKinds,
    egoId,
    cruiseSpeedMps,
    clipSeconds: typeof unwrapped['clipSeconds'] === 'number' ? unwrapped['clipSeconds'] : null,
    signalsPresent: Array.isArray(unwrapped['signalPrograms']) && unwrapped['signalPrograms'].length > 0,
    speedLimitMps,
    egoDims,
  };
}

/* ---------------------------------------------------------------- resolution */

export async function resolveCampaign(configPath: string): Promise<ResolvedCampaign> {
  const absConfig = path.resolve(configPath);
  const configDir = path.dirname(absConfig);
  const config = campaignConfigSchema.parse(JSON.parse(await readFile(absConfig, 'utf8')));

  const runsRoot = config.runsRoot.startsWith('~')
    ? path.join(os.homedir(), config.runsRoot.slice(1))
    : path.resolve(configDir, config.runsRoot);
  const campaignDir = path.join(runsRoot, config.campaignId);

  const scenarios = new Map<string, ResolvedScenario>();
  for (const scenario of config.suite) {
    if (scenarios.has(scenario.scenarioId)) throw new Error(`duplicate scenarioId ${scenario.scenarioId}`);
    const specPath = path.resolve(configDir, scenario.spec);
    const fixtureSha256 = createHash('sha256').update(await readFile(specPath)).digest('hex');
    const facts = await fixtureFacts(specPath, scenario.session);
    const expectedRouteM =
      scenario.expectedRouteM ??
      (facts.cruiseSpeedMps !== null && facts.clipSeconds !== null
        ? facts.cruiseSpeedMps * facts.clipSeconds
        : null);
    const replayContextDir = scenario.replayContext ? path.resolve(configDir, scenario.replayContext) : null;
    const replayContext = replayContextDir ? await loadReplayContext(replayContextDir) : null;
    const frameSource = scenario.frameSource?.startsWith('bevy:')
      ? `bevy:${path.resolve(configDir, scenario.frameSource.slice('bevy:'.length))}`
      : scenario.frameSource ?? null;
    scenarios.set(scenario.scenarioId, {
      scenario,
      specPath,
      fixtureSha256,
      context: {
        decisionHz: config.decisionHz,
        actorKinds: facts.actorKinds,
        speedLimitMps: scenario.speedLimitMps ?? facts.speedLimitMps,
        expectedRouteM,
        ...(scenario.alpasimStyle ? { alpasimStyle: scenario.alpasimStyle } : {}),
      },
      scoring: scenario.scoring as Partial<ScoringConfig>,
      replayContextDir,
      replayContext,
      frameSource,
    });
  }

  // Sequential grid: scenario-major, then policy, then seed.
  const episodes: EpisodePlan[] = [];
  for (const scenario of config.suite) {
    for (const policy of config.policies) {
      for (const seed of config.seeds) {
        episodes.push({
          episodeId: `${scenario.scenarioId}__${policy.policyId}__seed${seed}`,
          scenario,
          policy,
          seed,
        });
      }
    }
  }

  // Admission: a model episode needs a real frame source, and a reconstructed
  // scene must have proven its validity gates before any policy runs on it.
  for (const plan of episodes) {
    if (plan.policy.runnerPolicy !== 'endpoint') continue;
    const resolved = scenarios.get(plan.scenario.scenarioId)!;
    if (!resolved.frameSource) {
      throw new Error(
        `scenario ${plan.scenario.scenarioId} runs model policy ${plan.policy.policyId} but declares no frameSource; ` +
          'camera observations are never synthesized',
      );
    }
    const bundle = resolved.replayContext;
    if (!bundle) continue;
    // `validity.qualified` is schema-enforced by the reconstruction module:
    // true only when all five gates are recorded and passing and the source
    // is not a synthetic fixture. A freshly imported or reconstructed bundle
    // is legitimately unqualified, and refusing a model episode on it is the
    // intended outcome, not a defect — an unvalidated reconstruction cannot
    // produce a meaningful policy score.
    if (!bundle.validity.qualified) {
      const failed = Object.entries(bundle.validity.gates)
        .filter(([, gate]) => !gate?.passed)
        .map(([id]) => id);
      throw new Error(
        `scene ${bundle.sceneId} is not qualified for model episodes (failing or missing gates: ${failed.join(', ') || 'unknown'})`,
      );
    }
  }
  return { config, configDir, campaignDir, episodes, scenarios };
}

/* ------------------------------------------------------------------ episodes */

export interface EpisodeRunResult {
  readonly episodeId: string;
  /** `complete` covers every final episode outcome, including truncation. */
  readonly status: 'complete' | 'skipped' | 'failed';
  /** Runner status: completed | terminated | truncated | envelope_exceeded | cancelled | failed. */
  readonly runnerStatus: string | null;
  readonly drivingScore: number | null;
  readonly episodeDigest: string | null;
  /** True only when the episode produced a scoreable, complete result. */
  readonly scored: boolean;
  readonly error: { code: string; message: string } | null;
}

/**
 * Run one episode through the native gym episode runner into `dir`.
 *
 * A non-zero exit is NOT thrown: a refused model episode, a cancellation or a
 * missing frame is evidence to retain and report, not a campaign crash. The
 * caller decides what is scoreable from `exitCode` and `summary.status`.
 */
function invokeRunner(campaign: ResolvedCampaign, plan: EpisodePlan, dir: string): RunnerOutcome {
  const resolved = campaign.scenarios.get(plan.scenario.scenarioId)!;
  const policy = plan.policy;
  return runEpisodeSync({
    specPath: resolved.specPath,
    session: plan.scenario.session,
    runnerPolicy: policy.runnerPolicy,
    seed: plan.seed,
    policySeed: policy.policySeed,
    steps: plan.scenario.steps,
    mode: policy.mode,
    deadlineMs: policy.deadlineMs,
    fallback: policy.fallback,
    execution: policy.execution,
    decisionHz: campaign.config.decisionHz,
    tracePath: path.join(dir, 'trace.jsonl'),
    forceMissAt: policy.forceMissAt,
    replayContextDir: resolved.replayContextDir,
    endpointSocket: policy.endpointSocket,
    cameraProfile: policy.cameraProfile,
    frameSource: resolved.frameSource,
    replanHz: policy.replanHz,
    numTrajSamples: policy.numTrajSamples,
    navText: policy.navText,
    model: policy.model,
    allowColdStart: policy.allowColdStart,
    warmupPolicy: policy.warmupPolicy,
    warmupSteps: policy.warmupSteps,
  });
}

/** Adapter identity for provenance: gym runner package version + git HEAD. */
function adapterVersion(): { version: string; gitSha: string | null } {
  let version = 'unknown';
  try {
    const pyproject = readFileSync(path.join(RUNNER_DIR, 'pyproject.toml'), 'utf8');
    version = /^version\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1] ?? 'unknown';
  } catch {
    /* provenance stays 'unknown' */
  }
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return { version, gitSha: git.status === 0 ? git.stdout.trim() : null };
}

interface EpisodeArtifacts {
  readonly score: EpisodeScore | null;
  readonly manifest: ResultManifest;
}

/**
 * Score the episode (when it produced a scoreable trace) and write every
 * artifact, finishing with `result.json` — the durable manifest both hosts and
 * the cloud read, written last so its presence is the completion marker.
 *
 * A truncated episode (`envelope_exceeded`) IS scored, up to the breach, but
 * is `status: 'partial'` and never promotable: it is not a successful model
 * result and it is not a model failure either. A failed or cancelled episode
 * is not scored at all; its trace is retained as evidence.
 */
async function writeEpisodeArtifacts(
  campaign: ResolvedCampaign,
  plan: EpisodePlan,
  dir: string,
  outcome: RunnerOutcome,
  startedAt: string,
): Promise<EpisodeArtifacts> {
  const resolved = campaign.scenarios.get(plan.scenario.scenarioId)!;
  const runnerStatus = String(outcome.summary['status'] ?? (outcome.exitCode === 0 ? 'completed' : 'failed'));
  const runnerError = (outcome.summary['error'] ?? null) as { code?: string; message?: string } | null;
  const truncatedByEnvelope = runnerStatus === 'envelope_exceeded';
  const scoreable = FINAL_STATUSES[runnerStatus] === true && outcome.traceText.trim().length > 0;

  const score = scoreable ? scoreEpisode(parseTraceJsonl(outcome.traceText), resolved.context, resolved.scoring) : null;
  const adapter = adapterVersion();
  const modelProvenance = (outcome.summary['model'] ?? null) as Record<string, unknown> | null;

  const artifacts: EvalArtifact[] = [];
  await writeFile(path.join(dir, 'runner-summary.json'), `${JSON.stringify(outcome.summary, null, 1)}\n`);
  if (outcome.stderr.trim()) await writeFile(path.join(dir, 'runner-stderr.log'), outcome.stderr);
  if (score) {
    await writeFile(
      path.join(dir, 'events.json'),
      `${JSON.stringify({ schema: 'simforge.eval-events/v1', episodeId: plan.episodeId, events: score.events }, null, 1)}\n`,
    );
    await writeFile(
      path.join(dir, 'score.json'),
      `${JSON.stringify(
        {
          schema: 'simforge.eval-score/v1',
          episodeId: plan.episodeId,
          scenarioId: plan.scenario.scenarioId,
          policyId: plan.policy.policyId,
          seed: plan.seed,
          mode: plan.policy.mode,
          truncation: truncatedByEnvelope ? 'envelope_exceeded' : null,
          scoredThroughStep: score.steps,
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
          deadlineMissRate:
            plan.policy.mode === 'realtime' && score.steps > 0 ? score.deadlineMisses / score.steps : null,
        },
        null,
        1,
      )}\n`,
    );
  }
  const provenance = {
    schema: 'simforge.eval-provenance/v1',
    campaignId: campaign.config.campaignId,
    episodeId: plan.episodeId,
    mode: plan.policy.mode,
    scenario: {
      scenarioId: plan.scenario.scenarioId,
      spec: path.relative(REPO_ROOT, resolved.specPath),
      fixtureSha256: resolved.fixtureSha256,
      session: plan.scenario.session,
    },
    policy: {
      policyId: plan.policy.policyId,
      kind: plan.policy.runnerPolicy,
      checkpointDigest: outcome.summary['policy_checkpoint'] ?? null,
      adapterVersion: adapter.version,
      gitSha: adapter.gitSha,
      cameraProfile: plan.policy.runnerPolicy === 'endpoint' ? plan.policy.cameraProfile : null,
      replanHz: plan.policy.replanHz,
      warmupPolicy: plan.policy.warmupPolicy,
      warmupSteps: outcome.summary['warmup_steps'] ?? plan.policy.warmupSteps,
    },
    model: modelProvenance,
    input: {
      kind: resolved.replayContext ? 'replay-context' : 'scenario',
      ref: path.relative(REPO_ROOT, resolved.replayContextDir ?? resolved.specPath),
      digest: resolved.replayContext ? replayContextInputRef(resolved.replayContext).digest : resolved.fixtureSha256,
      ood: modelProvenance && rigHasApproximatedExtrinsics(plan.policy.cameraProfile) ? [APPROXIMATED_EXTRINSICS_OOD] : [],
      replayContext: (outcome.summary['replay_context'] ?? null) as Record<string, unknown> | null,
    },
    controller: {
      execution: plan.policy.execution,
      engineHz: 50,
      engineDtMs: 20,
      decisionHz: campaign.config.decisionHz,
      fallback: plan.policy.fallback,
    },
    seed: plan.seed,
    policySeed: plan.policy.policySeed,
    decisionHz: campaign.config.decisionHz,
    schedule: {
      steps: plan.scenario.steps,
      mode: plan.policy.mode,
      deadlineMs: plan.policy.deadlineMs,
      fallback: plan.policy.fallback,
      forceMissAt: plan.policy.forceMissAt,
    },
    envelope: (outcome.summary['envelope'] ?? null) as Record<string, unknown> | null,
    episodeDigest: outcome.summary['episode_digest'] ?? null,
    sourceEpisodeDigest: outcome.summary['source_episode_digest'] ?? null,
    traceVersion: outcome.summary['source_schema'] ?? 'legacy-unversioned',
    traceSha256: outcome.traceSha256,
    createdAt: new Date().toISOString(),
  };
  await writeFile(path.join(dir, 'provenance.json'), `${JSON.stringify(provenance, null, 1)}\n`);

  for (const [role, file] of [
    ['trace', 'trace.jsonl'],
    ['evidence', 'trace.episode-v2.jsonl'],
    ['runner-summary', 'runner-summary.json'],
    ['events', 'events.json'],
    ['score', 'score.json'],
    ['provenance', 'provenance.json'],
    ['log', 'runner-stderr.log'],
  ] as const) {
    if (!existsSync(path.join(dir, file))) continue;
    artifacts.push(await describeArtifact(dir, file, score ? role : role === 'trace' ? 'evidence' : role));
  }

  const status: ResultStatus =
    runnerStatus === 'cancelled'
      ? 'cancelled'
      : runnerStatus === 'failed'
        ? 'failed'
        : truncatedByEnvelope || outcome.summary['result_status'] === 'partial'
          ? 'partial'
          : 'succeeded';
  const completedAt = new Date().toISOString();
  const manifest: ResultManifest = {
    schema: 'simforge.eval-result-manifest/v1',
    kind: 'closedloop-episode',
    runId: plan.episodeId,
    attemptId: null,
    jobId: null,
    workspaceId: null,
    status,
    scored: score !== null,
    // Truncated, unscored and cancelled episodes can never promote a model.
    promotable: score !== null && status === 'succeeded' && plan.policy.runnerPolicy === 'endpoint',
    exploratory: false,
    mode: plan.policy.mode,
    truncation: truncatedByEnvelope
      ? 'envelope_exceeded'
      : runnerStatus === 'cancelled'
        ? 'cancelled'
        : runnerStatus === 'terminated'
          ? 'terminated'
          : outcome.summary['result_status'] === 'partial'
            ? 'truncated'
            : null,
    metrics: score
      ? {
          drivingScore: score.drivingScore,
          routeCompletion: score.routeCompletion,
          penaltyProduct: score.penaltyProduct,
          infractions: score.infractions,
          steps: score.steps,
          deadlineMisses: score.deadlineMisses,
          crossTrackM: outcome.summary['cross_track_m'] ?? null,
          inferMs: outcome.summary['infer_ms'] ?? null,
        }
      : {},
    artifacts,
    provenance: {
      model: modelProvenance
        ? {
            family: (modelProvenance['family'] as string | null) ?? null,
            revision: (modelProvenance['revision'] as string | null) ?? null,
            checkpointDigest: (modelProvenance['checkpointDigest'] as string | null) ?? null,
            quant: (modelProvenance['quant'] as string | null) ?? null,
            attn: (modelProvenance['attn'] as string | null) ?? null,
            torch: (modelProvenance['torch'] as string | null) ?? null,
            cuda: (modelProvenance['cuda'] as string | null) ?? null,
            diffusionSteps: null,
            numTrajSamples: plan.policy.numTrajSamples,
            cameraProfile: (modelProvenance['cameraProfile'] as string | null) ?? plan.policy.cameraProfile,
            rngProvenance: (modelProvenance['rngProvenance'] ?? null) as Record<string, unknown> | null,
            // A seed reproduces on this host and device only; GPU kernels are
            // not guaranteed bit-identical across devices or driver versions.
            determinismScope: 'same-host-same-device',
          }
        : null,
      input: {
        kind: provenance.input.kind,
        ref: provenance.input.ref,
        digest: provenance.input.digest,
        ood: provenance.input.ood,
        replayContext: provenance.input.replayContext,
      },
      runtime: {
        adapterVersion: adapter.version,
        gitSha: adapter.gitSha,
        runnerModule: RUNNER_MODULE,
        metricVersionSource: 'packages/evaluation/src/scoring.ts',
        traceVersion: provenance.traceVersion,
        sourceEpisodeDigest: provenance.sourceEpisodeDigest,
      },
      controller: provenance.controller,
      compute: null,
      metricVersion: 'simforge.eval-metrics/v1',
      // The campaign runner always executes; it never re-reads a retained run.
      reprocessedFrom: null,
    },
    timing: {
      startedAt,
      completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      executionMs: null,
    },
    error:
      status === 'failed' || status === 'cancelled'
        ? {
            code: 'internal',
            retryable: status === 'cancelled',
            message: String(runnerError?.message ?? `runner exited ${String(outcome.exitCode)}`),
            fields: runnerError?.code ? [runnerError.code] : [],
          }
        : null,
  };
  await writeResultManifest(dir, manifest);
  return { score, manifest };
}

/**
 * Run (or resume) the whole campaign sequentially.
 *
 * Resume is idempotent: an episode with a COMPLETE marker is skipped, and an
 * incomplete directory is moved aside as retained evidence
 * (`<episodeId>.evidence-<timestamp>/`) before being rerun — a failed or
 * cancelled episode's trace is kept and is never presented as a result.
 */
export async function runCampaign(
  campaign: ResolvedCampaign,
  log: (line: string) => void = () => {},
): Promise<EpisodeRunResult[]> {
  await mkdir(campaign.campaignDir, { recursive: true });
  await freezeCampaignSpec(campaign);

  const results: EpisodeRunResult[] = [];
  for (const plan of campaign.episodes) {
    const dir = path.join(campaign.campaignDir, plan.episodeId);
    if (existsSync(path.join(dir, 'COMPLETE'))) {
      log(`skip ${plan.episodeId} (complete)`);
      results.push({
        episodeId: plan.episodeId,
        status: 'skipped',
        runnerStatus: null,
        drivingScore: null,
        episodeDigest: null,
        scored: false,
        error: null,
      });
      continue;
    }
    if (existsSync(dir)) {
      const evidence = `${dir}.evidence-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      log(`keep ${plan.episodeId} evidence at ${path.basename(evidence)} (incomplete)`);
      await rename(dir, evidence);
    }
    await mkdir(dir, { recursive: true });
    log(`run  ${plan.episodeId} [${plan.policy.mode}]`);
    const startedAt = new Date().toISOString();
    const outcome = invokeRunner(campaign, plan, dir);
    const { score, manifest } = await writeEpisodeArtifacts(campaign, plan, dir, outcome, startedAt);
    const runnerStatus = String(outcome.summary['status'] ?? (outcome.exitCode === 0 ? 'completed' : 'failed'));
    const episodeDigest = (outcome.summary['episode_digest'] as string | undefined) ?? null;

    const ledgerLine = {
      episodeId: plan.episodeId,
      scenarioId: plan.scenario.scenarioId,
      policyId: plan.policy.policyId,
      seed: plan.seed,
      mode: plan.policy.mode,
      status: manifest.status,
      runnerStatus,
      scored: manifest.scored,
      truncation: manifest.truncation,
      drivingScore: score?.drivingScore ?? null,
      routeCompletion: score?.routeCompletion ?? null,
      episodeDigest,
      traceSha256: outcome.traceSha256,
      error: manifest.error,
      completedAt: manifest.timing.completedAt,
    };
    await appendFile(path.join(campaign.campaignDir, 'ledger.jsonl'), `${JSON.stringify(ledgerLine)}\n`);

    const final = FINAL_STATUSES[runnerStatus] === true;
    if (final) {
      await writeFile(
        path.join(dir, 'COMPLETE'),
        `${JSON.stringify({
          traceSha256: outcome.traceSha256,
          status: manifest.status,
          scored: manifest.scored,
          completedAt: ledgerLine.completedAt,
        })}\n`,
      );
      log(
        `done ${plan.episodeId} status=${manifest.status} score=${score ? score.drivingScore.toFixed(4) : 'unscored'}` +
          (manifest.truncation ? ` truncation=${manifest.truncation}` : ''),
      );
    } else {
      log(`fail ${plan.episodeId} ${runnerStatus}: ${manifest.error?.message ?? 'no summary'}`);
    }
    results.push({
      episodeId: plan.episodeId,
      status: final ? 'complete' : 'failed',
      runnerStatus,
      drivingScore: score?.drivingScore ?? null,
      episodeDigest,
      scored: manifest.scored,
      error: manifest.error ? { code: manifest.error.code, message: manifest.error.message } : null,
    });
  }
  return results;
}

/** Pin the campaign spec; refuses to resume a campaign whose inputs changed. */
async function freezeCampaignSpec(campaign: ResolvedCampaign): Promise<void> {
  const frozen = {
    schema: 'simforge.eval-campaign/v1',
    campaignId: campaign.config.campaignId,
    decisionHz: campaign.config.decisionHz,
    seeds: campaign.config.seeds,
    policies: campaign.config.policies,
    suite: [...campaign.scenarios.values()].map((s) => ({
      ...s.scenario,
      spec: path.relative(REPO_ROOT, s.specPath),
      fixtureSha256: s.fixtureSha256,
      context: s.context,
    })),
    episodeOrder: campaign.episodes.map((e) => e.episodeId),
  };
  const file = path.join(campaign.campaignDir, 'campaign.json');
  const next = `${JSON.stringify(frozen, null, 1)}\n`;
  if (existsSync(file)) {
    const prior = await readFile(file, 'utf8');
    if (prior !== next) {
      throw new Error(`campaign.json mismatch in ${campaign.campaignDir}: inputs changed; use a new campaignId`);
    }
    return;
  }
  await writeFile(file, next);
}

/* --------------------------------------------------------------------- rerun */

export interface RerunVerdict {
  readonly episodeId: string;
  readonly match: boolean;
  readonly original: { episodeDigest: string | null; traceSha256Deterministic: string };
  readonly rerun: { episodeDigest: string | null; traceSha256Deterministic: string };
  readonly rendererNondeterminism?: {
    readonly reason: 'renderer nondeterminism';
    readonly originalSourceEpisodeDigest: string;
    readonly rerunSourceEpisodeDigest: string;
    /** All deterministic native evidence except pixel hashes, including scene docs. */
    readonly stateDigest: string;
  };
}

/** Deep canonical evidence hash. Only measured wall-clock/device telemetry is excluded. */
export function deterministicTraceSha256(traceText: string, ignoreSourceDigest = false): string {
  const hash = createHash('sha256');
  for (const line of traceText.split('\n')) {
    if (!line.trim()) continue;
    const doc = JSON.parse(line) as Record<string, unknown>;
    delete doc['timing'];
    const deadline = doc['dl'] as Record<string, unknown> | undefined;
    if (deadline) deadline['el'] = null;
    const summary = doc['summary'] as Record<string, unknown> | undefined;
    if (summary) {
      delete summary['infer_ms'];
      delete summary['roundtrip_ms'];
      delete summary['step_ms'];
      if (ignoreSourceDigest) delete summary['source_episode_digest'];
      const timing = summary['timing'] as Record<string, unknown> | undefined;
      if (timing) delete timing['wallMs'];
      const model = summary['model'] as Record<string, unknown> | null | undefined;
      if (model) {
        delete model['inferenceMs'];
        delete model['vram'];
      }
    }
    hash.update(canonicalJson(doc));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function nativeTraceIdentity(text: string): { sourceDigest: string; stateDigest: string; cameras: boolean } {
  const records = text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>);
  const sourceDigest = verifyEpisodeTrace(records);
  let cameras = false;
  for (const row of records) {
    delete row['digest'];
    delete row['episode_digest'];
    const reset = row['reset'] as Record<string, unknown> | undefined;
    const observation = reset?.['observation'] as Record<string, unknown> | undefined;
    const evidence = (observation?.['cameras'] ?? row['cameras']) as { frames?: Record<string, unknown>[] } | undefined;
    if (evidence?.frames) {
      cameras = true;
      for (const frame of evidence.frames) {
        delete frame['digest'];
        delete frame['sha256'];
      }
    }
    const summary = row['summary'] as Record<string, unknown> | undefined;
    if (summary) delete summary['episodeDigest'];
  }
  return { sourceDigest, stateDigest: deterministicTraceSha256(records.map((row) => JSON.stringify(row)).join('\n')), cameras };
}

/** Native bench traces need no legacy conversion; verify both chains before classifying RGB-only differences. */
export function compareNativeEpisodeTraces(originalTrace: string, rerunTrace: string) {
  const original = nativeTraceIdentity(originalTrace);
  const rerun = nativeTraceIdentity(rerunTrace);
  const pixelIdentical = original.sourceDigest === rerun.sourceDigest;
  const stateMatch = original.stateDigest === rerun.stateDigest;
  return {
    match: stateMatch, pixelIdentical, original, rerun,
    rendererNondeterminism: !pixelIdentical && stateMatch && original.cameras && rerun.cameras
      ? { reason: 'renderer nondeterminism', stateDigest: original.stateDigest }
      : null,
  };
}

/** Compare policy evidence and primary native identity without hiding pixel differences. */
export function compareRerunTraces(
  originalTrace: string, rerunTrace: string,
  originalNativeTrace: string | null = null, rerunNativeTrace: string | null = null,
): Omit<RerunVerdict, 'episodeId'> {
  const originalSummary = parseTraceJsonl(originalTrace).summary ?? {};
  const rerunSummary = parseTraceJsonl(rerunTrace).summary ?? {};
  const original = {
    episodeDigest: (originalSummary['episode_digest'] as string | undefined) ?? null,
    traceSha256Deterministic: deterministicTraceSha256(originalTrace),
  };
  const rerun = {
    episodeDigest: (rerunSummary['episode_digest'] as string | undefined) ?? null,
    traceSha256Deterministic: deterministicTraceSha256(rerunTrace),
  };
  const originalSource = (originalSummary['source_episode_digest'] as string | undefined) ?? null;
  const rerunSource = (rerunSummary['source_episode_digest'] as string | undefined) ?? null;
  const originalNative = originalNativeTrace === null ? null : nativeTraceIdentity(originalNativeTrace);
  const rerunNative = rerunNativeTrace === null ? null : nativeTraceIdentity(rerunNativeTrace);
  if ((originalNative && originalNative.sourceDigest !== originalSource) ||
      (rerunNative && rerunNative.sourceDigest !== rerunSource)) {
    throw new Error('converted trace source digest disagrees with retained native evidence');
  }
  const policyMatch = original.episodeDigest !== null && original.episodeDigest === rerun.episodeDigest;
  const nativeProofPresent = (originalSource === null || originalNative !== null) &&
    (rerunSource === null || rerunNative !== null);
  const match = policyMatch && nativeProofPresent && originalSource === rerunSource &&
    original.traceSha256Deterministic === rerun.traceSha256Deterministic;
  const rendererOnly = !match && policyMatch && originalSource !== rerunSource &&
    originalNative?.cameras && rerunNative?.cameras &&
    originalNative.stateDigest === rerunNative.stateDigest &&
    deterministicTraceSha256(originalTrace, true) === deterministicTraceSha256(rerunTrace, true);
  return {
    match: match || Boolean(rendererOnly), original, rerun,
    ...(rendererOnly ? { rendererNondeterminism: {
      reason: 'renderer nondeterminism' as const,
      originalSourceEpisodeDigest: originalNative.sourceDigest,
      rerunSourceEpisodeDigest: rerunNative.sourceDigest,
      stateDigest: originalNative.stateDigest,
    } } : {}),
  };
}

/**
 * Re-execute one completed episode into a scratch dir and compare digests.
 * Deterministic policies must reproduce the stored trace exactly.
 */
export async function rerunEpisode(campaign: ResolvedCampaign, episodeId: string): Promise<RerunVerdict> {
  const plan = campaign.episodes.find((e) => e.episodeId === episodeId);
  if (!plan) throw new Error(`episode ${episodeId} is not in this campaign`);
  const originalDir = path.join(campaign.campaignDir, episodeId);
  if (!existsSync(path.join(originalDir, 'COMPLETE'))) {
    throw new Error(`episode ${episodeId} has no COMPLETE artifact to compare against`);
  }
  const originalTrace = await readFile(path.join(originalDir, 'trace.jsonl'), 'utf8');

  const scratch = path.join(campaign.campaignDir, '.rerun', episodeId);
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  const outcome = invokeRunner(campaign, plan, scratch);
  await writeFile(path.join(scratch, 'runner-summary.json'), `${JSON.stringify(outcome.summary, null, 1)}\n`);
  if (outcome.exitCode !== 0) {
    throw new Error(
      `rerun of ${episodeId} did not produce a comparable episode (exit ${String(outcome.exitCode)}, ` +
        `status ${String(outcome.summary['status'] ?? 'unknown')}): ${outcome.stderr.slice(-500)}`,
    );
  }

  const originalNativePath = path.join(originalDir, 'trace.episode-v2.jsonl');
  const rerunNativePath = path.join(scratch, 'trace.episode-v2.jsonl');
  const [originalNative, rerunNative] = await Promise.all([
    existsSync(originalNativePath) ? readFile(originalNativePath, 'utf8') : null,
    existsSync(rerunNativePath) ? readFile(rerunNativePath, 'utf8') : null,
  ]);
  return { episodeId, ...compareRerunTraces(originalTrace, outcome.traceText, originalNative, rerunNative) };
}

/* -------------------------------------------------------------------- report */

export interface CampaignReport {
  readonly schema: 'simforge.eval-report/v1';
  readonly campaignId: string;
  readonly perScenario: ReadonlyArray<{
    scenarioId: string;
    policyId: string;
    /** Mode is part of the identity of a number; never mix modes in a mean. */
    mode: string;
    episodes: number;
    scoredEpisodes: number;
    truncatedEpisodes: number;
    meanDrivingScore: number;
    meanRouteCompletion: number;
    meanAlpasimStyleScore: number | null;
    alpasimStyleAssessed: number;
    infractions: Record<string, number>;
  }>;
  readonly aggregate: {
    drivingScore: number;
    episodes: number;
    scoredEpisodes: number;
    byPolicy: Record<string, number>;
  };
  readonly infractionHistogram: Record<string, number>;
  /** Episodes excluded from every mean, with why. */
  readonly excluded: ReadonlyArray<{ episodeId: string; status: string; reason: string }>;
}

export async function buildReport(campaign: ResolvedCampaign): Promise<CampaignReport> {
  interface Row {
    scenarioId: string;
    policyId: string;
    mode: string;
    truncated: boolean;
    score: {
      drivingScore: number;
      routeCompletion: number;
      infractions: Record<InfractionType, number>;
      'alpasim-style-score'?: EpisodeScore['alpasim-style-score'];
    };
  }
  const rows: Row[] = [];
  const excluded: { episodeId: string; status: string; reason: string }[] = [];
  for (const plan of campaign.episodes) {
    const dir = path.join(campaign.campaignDir, plan.episodeId);
    const manifestFile = path.join(dir, 'result.json');
    if (!existsSync(manifestFile)) {
      excluded.push({ episodeId: plan.episodeId, status: 'missing', reason: 'no result.json; episode never ran' });
      continue;
    }
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as ResultManifest;
    if (!manifest.scored) {
      excluded.push({
        episodeId: plan.episodeId,
        status: manifest.status,
        reason: manifest.error?.message ?? 'episode produced no scoreable trace',
      });
      continue;
    }
    const doc = JSON.parse(await readFile(path.join(dir, 'score.json'), 'utf8')) as {
      drivingScore: number;
      routeCompletion: number;
      infractions: Record<InfractionType, number>;
      'alpasim-style-score'?: EpisodeScore['alpasim-style-score'];
    };
    rows.push({
      scenarioId: plan.scenario.scenarioId,
      policyId: plan.policy.policyId,
      mode: manifest.mode,
      truncated: manifest.truncation !== null,
      score: doc,
    });
  }

  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.scenarioId}\u0000${row.policyId}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const perScenario = [...groups.entries()].map(([key, group]) => {
    const [scenarioId, policyId] = key.split('\u0000') as [string, string];
    const infractions: Record<string, number> = {};
    for (const row of group) {
      for (const [type, count] of Object.entries(row.score.infractions)) {
        if (count > 0) infractions[type] = (infractions[type] ?? 0) + count;
      }
    }
    const modes = [...new Set(group.map((row) => row.mode))].sort();
    return {
      scenarioId,
      policyId,
      mode: modes.join('+'),
      episodes: group.length,
      scoredEpisodes: group.length,
      truncatedEpisodes: group.filter((row) => row.truncated).length,
      meanDrivingScore: group.reduce((acc, r) => acc + r.score.drivingScore, 0) / group.length,
      meanRouteCompletion: group.reduce((acc, r) => acc + r.score.routeCompletion, 0) / group.length,
      meanAlpasimStyleScore: group.every((r) => r.score['alpasim-style-score']?.value != null)
        ? group.reduce((sum, r) => sum + r.score['alpasim-style-score']!.value!, 0) / group.length : null,
      alpasimStyleAssessed: group.filter((r) => r.score['alpasim-style-score']?.value != null).length,
      infractions,
    };
  });

  const histogram: Record<string, number> = {};
  for (const row of rows) {
    for (const [type, count] of Object.entries(row.score.infractions)) {
      if (count > 0) histogram[type] = (histogram[type] ?? 0) + count;
    }
  }
  const byPolicy: Record<string, number> = {};
  for (const policy of campaign.config.policies) {
    const own = rows.filter((r) => r.policyId === policy.policyId);
    byPolicy[policy.policyId] = own.reduce((acc, r) => acc + r.score.drivingScore, 0) / Math.max(own.length, 1);
  }
  return {
    schema: 'simforge.eval-report/v1',
    campaignId: campaign.config.campaignId,
    perScenario,
    aggregate: {
      drivingScore: rows.reduce((acc, r) => acc + r.score.drivingScore, 0) / Math.max(rows.length, 1),
      episodes: campaign.episodes.length,
      scoredEpisodes: rows.length,
      byPolicy,
    },
    infractionHistogram: histogram,
    excluded,
  };
}

export function reportMarkdown(report: CampaignReport): string {
  const lines: string[] = [];
  lines.push(`# Campaign ${report.campaignId}`);
  lines.push('');
  lines.push(
    `Aggregate driving score: **${(report.aggregate.drivingScore * 100).toFixed(1)}** / 100 over ` +
      `${report.aggregate.scoredEpisodes} scored of ${report.aggregate.episodes} episodes.`,
  );
  const policies = Object.entries(report.aggregate.byPolicy)
    .map(([policyId, score]) => `${policyId} ${(score * 100).toFixed(1)}`)
    .join(' · ');
  lines.push(`By policy: ${policies}`);
  lines.push('Optional `alpasim-style-score`: **not an AlpaSim result**. Missing authority stays unavailable.');
  lines.push('');
  lines.push('| scenario | policy | mode | scored | truncated | mean driving score | mean alpasim-style-score | mean route completion | infractions |');
  lines.push('|---|---|---|---:|---:|---:|---:|---:|---|');
  for (const row of report.perScenario) {
    const infractions =
      Object.entries(row.infractions)
        .map(([type, count]) => `${type}×${count}`)
        .join(', ') || '—';
    lines.push(
      `| ${row.scenarioId} | ${row.policyId} | ${row.mode} | ${row.scoredEpisodes} | ${row.truncatedEpisodes} | ` +
        `${(row.meanDrivingScore * 100).toFixed(1)} | ${row.meanAlpasimStyleScore == null ? 'unavailable' : row.meanAlpasimStyleScore.toFixed(4)} | ${(row.meanRouteCompletion * 100).toFixed(1)}% | ${infractions} |`,
    );
  }
  lines.push('');
  lines.push('## Infraction histogram');
  lines.push('');
  if (Object.keys(report.infractionHistogram).length === 0) {
    lines.push('No infractions.');
  } else {
    lines.push('| infraction | count |');
    lines.push('|---|---:|');
    for (const [type, count] of Object.entries(report.infractionHistogram).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${type} | ${count} |`);
    }
  }
  if (report.excluded.length > 0) {
    lines.push('');
    lines.push('## Excluded from every mean');
    lines.push('');
    lines.push('| episode | status | reason |');
    lines.push('|---|---|---|');
    for (const row of report.excluded) {
      lines.push(`| ${row.episodeId} | ${row.status} | ${row.reason} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export async function writeReport(campaign: ResolvedCampaign): Promise<CampaignReport> {
  const report = await buildReport(campaign);
  await writeFile(path.join(campaign.campaignDir, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
  await writeFile(path.join(campaign.campaignDir, 'report.md'), reportMarkdown(report));
  return report;
}
