/**
 * The one way to execute a closed-loop episode: spawn the native gym episode
 * runner (`python -m simforge_oss_gym.tools.policy_runner`) in `adapters/gym`.
 *
 * Both callers use it — the desktop/CI campaign runner (`campaign.ts`,
 * sequential and synchronous) and the cloud worker CLI (`worker-cli.ts`, one
 * episode per job, cancellable) — so there is exactly one argv contract and
 * one interpretation of the runner's exit codes.
 *
 * Exit codes: `0` a final episode result (completed / terminated / truncated /
 * envelope_exceeded), `130` cancelled at a barrier, anything else a failure.
 * A non-zero exit is never thrown here: a refused model episode is evidence to
 * record, not a crash.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `packages/evaluation/src` → repo root (mirrors compiler/src/maps.ts). */
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
export const RUNNER_DIR = path.join(REPO_ROOT, 'adapters', 'gym');
export const RUNNER_MODULE = 'simforge_oss_gym.tools.policy_runner';

/** Runner statuses that are a final episode result. */
export const FINAL_EPISODE_STATUSES: Record<string, boolean> = {
  completed: true,
  terminated: true,
  truncated: true,
  envelope_exceeded: true,
};

export interface EpisodeRunnerOptions {
  readonly specPath: string;
  readonly session: number;
  readonly runnerPolicy: 'scripted' | 'trajectory' | 'torch' | 'endpoint' | 'recorded-path';
  readonly seed: number | string;
  readonly policySeed: number;
  readonly steps: number;
  readonly mode: 'offline-simtime' | 'realtime';
  readonly deadlineMs: number | null;
  readonly fallback: 'repeat-last' | 'zero-control' | 'scripted';
  readonly execution: 'pure-pursuit' | 'speed-setpoint';
  readonly decisionHz: number;
  readonly tracePath: string;
  readonly summaryPath?: string | null;
  readonly forceMissAt?: readonly number[];
  readonly replayContextDir?: string | null;
  readonly endpointSocket?: string | null;
  readonly cameraProfile?: string | null;
  readonly frameSource?: string | null;
  readonly replanHz?: number | null;
  readonly numTrajSamples?: number | null;
  readonly navText?: string | null;
  readonly model?: { family?: string | null; revision?: string | null; quant?: string | null } | null;
  readonly allowColdStart?: boolean;
  readonly warmupPolicy?: 'scripted' | 'trajectory' | 'torch' | null;
  readonly warmupSteps?: number | null;
  readonly mapsDir?: string | null;
  readonly python?: string;
}

export interface RunnerOutcome {
  readonly summary: Record<string, unknown>;
  readonly traceText: string;
  readonly traceSha256: string;
  readonly exitCode: number;
  readonly stderr: string;
}

export function episodeRunnerArgs(options: EpisodeRunnerOptions): string[] {
  const args = [
    '-m', RUNNER_MODULE,
    '--spec', options.specPath,
    '--session', String(options.session),
    '--policy', options.runnerPolicy,
    '--seed', String(options.seed),
    '--policy-seed', String(options.policySeed),
    '--steps', String(options.steps),
    '--mode', options.mode,
    '--fallback', options.fallback,
    '--execution', options.execution,
    '--decision-hz', String(options.decisionHz),
    '--out', options.tracePath,
  ];
  if (options.summaryPath) args.push('--summary-out', options.summaryPath);
  if (options.mode === 'realtime') {
    args.push('--deadline-ms', String(options.deadlineMs));
    for (const step of options.forceMissAt ?? []) args.push('--force-miss-at', String(step));
  }
  if (options.mapsDir) args.push('--maps-dir', options.mapsDir);
  if (options.replayContextDir) args.push('--replay-context', options.replayContextDir);
  if (options.runnerPolicy === 'endpoint') {
    args.push('--endpoint-socket', options.endpointSocket!);
    args.push('--camera-profile', options.cameraProfile ?? 'alpamayo-4cam');
    args.push('--frame-source', options.frameSource!);
    if (options.replanHz != null) args.push('--replan-hz', String(options.replanHz));
    if (options.numTrajSamples != null) args.push('--num-traj-samples', String(options.numTrajSamples));
    if (options.navText) args.push('--nav-text', options.navText);
    if (options.model?.family) args.push('--model-family', options.model.family);
    if (options.model?.revision) args.push('--model-revision', options.model.revision);
    if (options.model?.quant) args.push('--model-quant', options.model.quant);
    if (options.allowColdStart) args.push('--allow-cold-start');
  }
  if (options.warmupPolicy) args.push('--warmup-policy', options.warmupPolicy);
  if (options.warmupSteps != null) args.push('--warmup-steps', String(options.warmupSteps));
  return args;
}

function outcomeOf(
  exitCode: number,
  stdout: string,
  stderr: string,
  tracePath: string,
): RunnerOutcome {
  const lastLine = stdout
    .split('\n')
    .filter((line) => line.trim())
    .pop();
  let summary: Record<string, unknown> = {};
  try {
    summary = lastLine ? (JSON.parse(lastLine) as Record<string, unknown>) : {};
  } catch {
    summary = {};
  }
  if (Object.keys(summary).length === 0) {
    summary = {
      status: exitCode === 130 ? 'cancelled' : 'failed',
      error: { code: 'runner_no_summary', message: `runner exited ${String(exitCode)} without a summary document` },
    };
  }
  let traceText = '';
  try {
    traceText = readFileSync(tracePath, 'utf8');
  } catch {
    traceText = '';
  }
  return {
    summary,
    traceText,
    traceSha256: createHash('sha256').update(traceText).digest('hex'),
    exitCode,
    stderr: stderr.slice(-8_000),
  };
}

/** Synchronous execution, used by the sequential campaign runner. */
export function runEpisodeSync(options: EpisodeRunnerOptions): RunnerOutcome {
  const proc = spawnSync(options.python ?? 'python3', episodeRunnerArgs(options), {
    cwd: RUNNER_DIR,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return outcomeOf(proc.status ?? -1, proc.stdout ?? '', proc.stderr ?? '', options.tracePath);
}

/**
 * Cancellable execution, used by the cloud worker.
 *
 * On abort the child gets SIGTERM so it can stop at the next inference
 * barrier and flush its partial trace; a child that ignores it is SIGKILLed
 * after `killGraceMs`. The caller must not assume the graceful path ran — a
 * hard kill leaves no `result.json`, which is the control plane's failed
 * attempt path.
 */
export async function runEpisodeAsync(
  options: EpisodeRunnerOptions,
  signal: AbortSignal,
  killGraceMs = 30_000,
): Promise<RunnerOutcome> {
  const child = spawn(options.python ?? 'python3', episodeRunnerArgs(options), {
    cwd: RUNNER_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-16_000);
  });

  let killTimer: NodeJS.Timeout | undefined;
  const onAbort = () => {
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });

  const exitCode = await new Promise<number>((resolve) => {
    child.once('error', () => resolve(-1));
    child.once('close', (code, killSignal) => resolve(code ?? (killSignal ? 130 : -1)));
  });
  clearTimeout(killTimer);
  signal.removeEventListener('abort', onAbort);
  return outcomeOf(exitCode, stdout, stderr, options.tracePath);
}
