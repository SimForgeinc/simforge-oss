import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CliError, EXIT } from '../../errors.js';
import { emit } from '../../output.js';
import { compose } from './compose.js';
import { repositoryRoot } from './model-socket.js';
import { isPolicyId, policyGpuClass, policyIds } from './policies/index.js';

const DEFAULT_OUT = path.join(os.homedir(), 'simforge-assets', 'runs', 'drive');

export interface HeatOptions {
  readonly policies: string | readonly string[];
  readonly scenario: string;
  readonly seed: number;
  readonly duration: number;
  readonly out?: string;
  readonly workers?: string;
  readonly live?: boolean;
  readonly realtime?: boolean;
  readonly deadlineMs?: number | null;
  readonly modelSocket?: string;
  readonly noStartModel?: boolean;
  readonly noStartRenderer?: boolean;
  readonly renderBinary?: string;
  readonly nativeWorld?: string;
  readonly vehicleModels?: string;
  readonly pedestrianModels?: string;
  readonly quant?: string;
  readonly enhance?: string;
  readonly policyInput?: 'raw' | 'enhanced';
  readonly recordControls?: boolean;
  readonly replanHz?: number;
  readonly warmupFrames?: number;
  readonly alpasimStyleScore?: boolean;
  readonly compose?: boolean;
  readonly pretty?: boolean;
}

type RunPhase = 'low-vram-concurrent' | 'vla-exclusive' | 'appearance-ablation';

type RunResult = {
  readonly policy: string;
  readonly phase: RunPhase;
  readonly policyInput?: 'raw' | 'enhanced';
  readonly runDir: string | null;
  readonly status: 'succeeded' | 'failed';
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly wallTimeMs: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly error?: string;
};

export interface HeatSummary {
  readonly schema: 'simforge.drive-heat/v1';
  readonly scenario: string;
  readonly seed: number;
  readonly durationS: number;
  readonly out: string;
  readonly workers: string;
  readonly vramRule: string;
  readonly wallTimeMs: number;
  readonly schedule: readonly RunResult[];
  readonly compose: { readonly video: string; readonly report: string; readonly reportMarkdown: string } | null;
}

function policyList(value: string | readonly string[]): string[] {
  const values = typeof value === 'string' ? value.split(',') : [...value];
  const policies = values.map((policy) => policy.trim()).filter((policy) => policy.length > 0);
  if (policies.length === 0) throw new CliError('missing_argument', '--policies requires at least one policy', { path: '--policies' });
  const duplicate = policies.find((policy, index) => policies.indexOf(policy) !== index);
  if (duplicate) throw new CliError('bad_value', `--policies contains duplicate ${duplicate}`, { path: '--policies' });
  const unknown = policies.find((policy) => !isPolicyId(policy));
  if (unknown) throw new CliError('bad_value', `unknown policy ${unknown}`, { path: '--policies', detail: { known: policyIds() } });
  return policies;
}

type CliInvocation = { readonly command: string; readonly args: readonly string[] };

/** Re-launch this CLI the way it was launched (`node --import tsx main.ts`, `tsx main.ts`, or the built bin). */
function cliInvocation(root: string): CliInvocation {
  const script = process.argv[1] ?? path.join(root, 'packages', 'cli', 'bin', 'simforge.js');
  return { command: process.execPath, args: [...process.execArgv, script] };
}

function appendArg(args: string[], flag: string, value: string | number | undefined): void {
  if (value !== undefined) args.push(flag, String(value));
}

function tail(value: string, limit = 12_000): string {
  return value.length <= limit ? value : value.slice(-limit);
}

async function runPolicy(invocation: CliInvocation, root: string, options: HeatOptions, policy: string, phase: RunPhase): Promise<RunResult> {
  const started = Date.now();
  const args = [...invocation.args, 'drive', 'run', '--policy', policy, '--scenario', options.scenario, '--seed', String(options.seed), '--duration', String(options.duration), '--out', root];
  if (options.live) args.push('--live');
  if (options.realtime) {
    args.push('--realtime');
    appendArg(args, '--deadline-ms', options.deadlineMs ?? undefined);
  }
  appendArg(args, '--model-socket', options.modelSocket);
  appendArg(args, '--render-binary', options.renderBinary);
  appendArg(args, '--native-world', options.nativeWorld);
  appendArg(args, '--vehicle-models', options.vehicleModels);
  appendArg(args, '--pedestrian-models', options.pedestrianModels);
  appendArg(args, '--quant', options.quant);
  appendArg(args, '--enhance', options.enhance);
  appendArg(args, '--policy-input', options.policyInput);
  appendArg(args, '--replan-hz', options.replanHz);
  appendArg(args, '--warmup-frames', options.warmupFrames);
  if (options.recordControls) args.push('--record-controls');
  if (options.alpasimStyleScore) args.push('--alpasim-style-score');
  if (options.noStartModel) args.push('--no-start-model');
  if (options.noStartRenderer) args.push('--no-start-renderer');
  const child = spawn(invocation.command, args, {
    cwd: repositoryRoot(),
    env: { ...process.env, SIMFORGE_HEAT_POLICY: policy, SIMFORGE_HEAT_PHASE: phase },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout = tail(stdout + String(chunk)); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr = tail(stderr + String(chunk)); });
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let error: string | undefined;
  try {
    [exitCode, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const childStatus = exitCode === 0 && signal === null && error === undefined ? 'succeeded' : 'failed';
  let runDir: string | null = null;
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    if (!line.startsWith('{')) continue;
    try {
      const receipt = JSON.parse(line) as { ok?: unknown; runDir?: unknown };
      if (receipt?.ok === true && typeof receipt.runDir === 'string' && (await fs.stat(receipt.runDir)).isDirectory()) {
        runDir = path.resolve(receipt.runDir);
        break;
      }
    } catch {
      // Lifecycle logs are not receipts; only the successful run's own path is authoritative.
    }
  }
  const runStatus = childStatus === 'succeeded' && runDir !== null ? 'succeeded' : 'failed';
  const runError = error ?? (childStatus === 'succeeded' && runDir === null ? 'drive run exited successfully but reported no existing run directory' : undefined);
  return {
    policy,
    phase,
    ...(options.policyInput ? { policyInput: options.policyInput } : {}),
    runDir,
    status: runStatus,
    exitCode,
    signal,
    wallTimeMs: Date.now() - started,
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
    ...(runError === undefined ? {} : { error: runError }),
  };
}

async function writeAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.partial-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, file);
}

export async function heat(options: HeatOptions): Promise<number> {
  const policies = policyList(options.policies);
  if (!(options.duration > 0) || !Number.isFinite(options.duration)) throw new CliError('bad_value', '--duration must be finite and positive', { path: '--duration' });
  if (!Number.isInteger(options.seed) || !Number.isFinite(options.seed)) throw new CliError('bad_value', '--seed must be an integer', { path: '--seed' });
  if (options.realtime && (!(options.deadlineMs !== undefined && options.deadlineMs !== null) || !(options.deadlineMs > 0))) throw new CliError('bad_value', '--realtime requires a positive --deadline-ms', { path: '--deadline-ms' });
  if (!options.realtime && options.deadlineMs !== undefined && options.deadlineMs !== null) throw new CliError('bad_value', '--deadline-ms is only valid with --realtime', { path: '--deadline-ms' });
  const workers = options.workers ?? 'local';
  if (workers !== 'local') throw new CliError('unsupported', `remote heat workers are not implemented; --workers must be local`, { path: '--workers', detail: { requested: workers, supported: ['local'], hint: 'run heat locally or launch separate drive commands on the remote host' } });
  const root = path.resolve(options.out ?? DEFAULT_OUT);
  await fs.mkdir(root, { recursive: true });
  const invocation = cliInvocation(repositoryRoot());
  const started = Date.now();
  const low = policies.filter((policy) => policyGpuClass(policy) === 'shared');
  const vla = policies.filter((policy) => policyGpuClass(policy) === 'exclusive');
  const results: RunResult[] = [];
  if (options.enhance) {
    // Each arm gets an independent policy session and output root; never overwrite
    // the raw arm or co-reside duplicate appearance/VLA models on the local GPU.
    for (const policy of policies) {
      for (const policyInput of ['raw', 'enhanced'] as const) {
        results.push(await runPolicy(invocation, path.join(root, policyInput), { ...options, policyInput }, policy, 'appearance-ablation'));
      }
    }
  } else {
    // Renderer-only/cloud policies may overlap; VLAs remain one at a time.
    results.push(...await Promise.all(low.map((policy) => runPolicy(invocation, root, options, policy, 'low-vram-concurrent'))));
    for (const policy of vla) results.push(await runPolicy(invocation, root, options, policy, 'vla-exclusive'));
  }
  results.sort((a, b) => policies.indexOf(a.policy) - policies.indexOf(b.policy));
  const outputVideo = path.join(root, 'heat.mp4');
  const outputReport = path.join(root, 'report.json');
  const outputReportMarkdown = path.join(root, 'report.md');
  let composed: HeatSummary['compose'] = null;
  if (options.compose !== false && results.every((result) => result.status === 'succeeded' && result.runDir !== null)) {
    const runDirs = results.map((result) => result.runDir!) as string[];
    await compose({ runDirs, out: outputVideo, pretty: false, emitResult: false });
    composed = { video: outputVideo, report: outputReport, reportMarkdown: outputReportMarkdown };
  }
  const summary: HeatSummary = {
    schema: 'simforge.drive-heat/v1',
    scenario: path.resolve(options.scenario),
    seed: options.seed,
    durationS: options.duration,
    out: root,
    workers,
    vramRule: 'local: at most one alpamayo-1.5 or qwen-drive VLA; low/zero-VRAM policies may overlap',
    wallTimeMs: Date.now() - started,
    schedule: results,
    compose: composed,
  };
  await writeAtomic(path.join(root, 'heat-schedule.json'), summary);
  emit({ ok: results.every((result) => result.status === 'succeeded'), ...summary } as unknown as Record<string, unknown>, { pretty: options.pretty ?? false });
  if (results.some((result) => result.status !== 'succeeded')) {
    throw new CliError('heat_failed', 'one or more drive runs failed; see heat-schedule.json and each run log', { path: root, detail: { ...summary } });
  }
  return EXIT.ok;
}
