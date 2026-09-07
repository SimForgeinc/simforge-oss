/**
 * Closed-loop episode execution core: run one episode, score it if it
 * produced a scoreable trace, and write its artifacts.
 *
 * Shared by the cloud worker CLI and the desktop model-run worker so a
 * `policy_episode` behaves identically in both. The sequential campaign runner
 * keeps its own artifact writer because it also owns the campaign ledger,
 * resume markers and per-campaign provenance — but it spawns the runner
 * through the same `episode-runner.ts` boundary.
 *
 * What is scoreable, and what a score means:
 *
 * - `completed` / `terminated` / `truncated` / `envelope_exceeded` produce a
 *   trace that is scored. Everything else (failed, cancelled) is retained as
 *   evidence and carries no score.
 * - `envelope_exceeded` is scored up to the breach and reported as `partial`
 *   with `truncation: 'envelope_exceeded'`: the reconstruction stopped being
 *   trustworthy there. It is neither a successful result nor a model failure.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { fixtureFacts } from './campaign.js';
import { FINAL_EPISODE_STATUSES, runEpisodeAsync, type EpisodeRunnerOptions } from './episode-runner.js';
import { describeArtifact, type EvalArtifact, type ResultManifest, type ResultStatus } from './protocol/manifest.js';
import { parseTraceJsonl, scoreEpisode, type EpisodeScore, type ScoringConfig } from './scoring.js';

export interface EpisodeRunOptions {
  readonly runId: string;
  readonly runner: EpisodeRunnerOptions;
  readonly outDir: string;
  readonly signal: AbortSignal;
  /** Scoring overrides and denominators from the job/campaign spec. */
  readonly scoring?: Partial<ScoringConfig>;
  readonly expectedRouteM?: number | null;
  readonly speedLimitMps?: number | null;
}

export interface EpisodeRunOutcome {
  readonly status: ResultStatus;
  readonly runnerStatus: string;
  readonly scored: boolean;
  readonly truncation: ResultManifest['truncation'];
  readonly score: EpisodeScore | null;
  readonly metrics: Record<string, unknown>;
  readonly artifacts: EvalArtifact[];
  readonly model: Record<string, unknown> | null;
  readonly summary: Record<string, unknown>;
  readonly episodeDigest: string | null;
  readonly error: { code: string; message: string } | null;
}

export async function executeEpisode(options: EpisodeRunOptions): Promise<EpisodeRunOutcome> {
  const outcome = await runEpisodeAsync(options.runner, options.signal);
  const runnerStatus = String(outcome.summary['status'] ?? (outcome.exitCode === 0 ? 'completed' : 'failed'));
  const final = FINAL_EPISODE_STATUSES[runnerStatus] === true;
  const scoreable = final && outcome.traceText.trim().length > 0;

  if (outcome.stderr.trim()) {
    await writeFile(path.join(options.outDir, 'runner-stderr.log'), outcome.stderr, 'utf8');
  }
  await writeFile(
    path.join(options.outDir, 'runner-summary.json'),
    `${JSON.stringify(outcome.summary, null, 1)}\n`,
    'utf8',
  );

  let score: EpisodeScore | null = null;
  if (scoreable) {
    const facts = await fixtureFacts(options.runner.specPath, options.runner.session);
    score = scoreEpisode(
      parseTraceJsonl(outcome.traceText),
      {
        decisionHz: options.runner.decisionHz,
        actorKinds: facts.actorKinds,
        speedLimitMps: options.speedLimitMps ?? facts.speedLimitMps,
        expectedRouteM:
          options.expectedRouteM ??
          (facts.cruiseSpeedMps !== null && facts.clipSeconds !== null
            ? facts.cruiseSpeedMps * facts.clipSeconds
            : null),
      },
      options.scoring,
    );
    await writeFile(
      path.join(options.outDir, 'events.json'),
      `${JSON.stringify({ schema: 'simforge.eval-events/v1', runId: options.runId, events: score.events }, null, 1)}\n`,
      'utf8',
    );
    await writeFile(
      path.join(options.outDir, 'score.json'),
      `${JSON.stringify(
        {
          schema: 'simforge.eval-score/v1',
          runId: options.runId,
          mode: options.runner.mode,
          truncation: runnerStatus === 'envelope_exceeded' ? 'envelope_exceeded' : null,
          scoredThroughStep: score.steps,
          drivingScore: score.drivingScore,
          routeCompletion: score.routeCompletion,
          penaltyProduct: score.penaltyProduct,
          infractions: score.infractions,
          ttc: score.ttc,
          comfort: score.comfort,
          terminal: score.terminal,
          steps: score.steps,
          deadlineMisses: score.deadlineMisses,
          deadlineMissRate:
            options.runner.mode === 'realtime' && score.steps > 0 ? score.deadlineMisses / score.steps : null,
        },
        null,
        1,
      )}\n`,
      'utf8',
    );
  }

  const artifacts: EvalArtifact[] = [];
  for (const [role, file] of [
    ['trace', 'trace.jsonl'],
    ['runner-summary', 'runner-summary.json'],
    ['events', 'events.json'],
    ['score', 'score.json'],
    ['log', 'runner-stderr.log'],
  ] as const) {
    try {
      artifacts.push(await describeArtifact(options.outDir, file, scoreable ? role : role === 'trace' ? 'evidence' : role));
    } catch {
      /* this episode produced no such artifact */
    }
  }

  const runnerError = outcome.summary['error'];
  const errorCode =
    runnerError && typeof runnerError === 'object' && 'code' in runnerError ? String(runnerError.code) : null;
  const errorMessage =
    runnerError && typeof runnerError === 'object' && 'message' in runnerError ? String(runnerError.message) : null;

  return {
    status:
      runnerStatus === 'cancelled'
        ? 'cancelled'
        : !final
          ? 'failed'
          : runnerStatus === 'envelope_exceeded'
            ? 'partial'
            : 'succeeded',
    runnerStatus,
    scored: score !== null,
    truncation:
      runnerStatus === 'envelope_exceeded'
        ? 'envelope_exceeded'
        : runnerStatus === 'cancelled'
          ? 'cancelled'
          : runnerStatus === 'terminated'
            ? 'terminated'
            : runnerStatus === 'truncated'
              ? 'truncated'
              : null,
    score,
    metrics: score
      ? {
          drivingScore: score.drivingScore,
          routeCompletion: score.routeCompletion,
          infractions: score.infractions,
          steps: score.steps,
          deadlineMisses: score.deadlineMisses,
          crossTrackM: outcome.summary['cross_track_m'] ?? null,
          inferMs: outcome.summary['infer_ms'] ?? null,
          envelope: outcome.summary['envelope'] ?? null,
          modelDecisions: outcome.summary['model_decisions'] ?? null,
        }
      : {},
    artifacts,
    model: (outcome.summary['model'] ?? null) as Record<string, unknown> | null,
    summary: outcome.summary,
    episodeDigest: typeof outcome.summary['episode_digest'] === 'string' ? outcome.summary['episode_digest'] : null,
    error: final ? null : { code: errorCode ?? 'runner_failed', message: errorMessage ?? `runner exited ${String(outcome.exitCode)}` },
  };
}
