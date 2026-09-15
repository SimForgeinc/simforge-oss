#!/usr/bin/env node
/**
 * Dispatch two bounded, isolated optimization directions concurrently, then
 * serialize measurement and append an accepted or rejected row to the shared
 * scoreboard. The runner is explicit: `codex` and `claude` map to their
 * installed non-interactive CLIs; a custom executable may be supplied for a
 * site-local runner. Rejected rows are never discarded.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseArgs, run, sha256, writeJson } from './lib/common.mjs';

const ROOT = process.cwd();
const DEFAULT_SCOREBOARD = 'artifacts/benchmarks/scoreboard.jsonl';
const DIRECTIONS = [
  {
    id: 'unused-work-elimination', benchmark: 'cli',
    title: 'Eliminate unused render work',
    prompt: 'Inspect the render capture path. Make one small architectural change that avoids work whose output is not requested (redundant passes, copies, or archive preparation), preserving frame-major sensor semantics and all quality invariants. Do not tune compiler flags. Run the benchmark and leave a concise note in your branch describing the measured hypothesis. Do not edit benchmark harness files.',
  },
  {
    id: 'perceptual-encode-representation', benchmark: 'browser',
    title: 'Perceptually free representation/encode path',
    prompt: 'Inspect the browser app/render path. Make one small architectural change that chooses a representation matching access patterns or trades encoding fidelity only where the pinned perceptual gate permits it. Preserve geometry, poses, timing, and determinism. Do not tune compiler flags or redesign app flow. Run the benchmark and leave a concise note in your branch. Do not edit benchmark harness files.',
  },
];

function outputFor(root, direction) { return path.resolve(root, `artifacts/benchmarks/optimizers/${direction.id}`); }
async function branchExists(name) { return (await run(['git', 'show-ref', '--verify', '--quiet', `refs/heads/${name}`])).code === 0; }

async function prepareWorktree(root, direction, worktree) {
  if ((await run(['git', 'worktree', 'list', '--porcelain'], { cwd: root })).stdout.includes(`worktree ${worktree}\n`)) return;
  const branch = `bench/optimizer-${direction.id}`;
  if (await branchExists(branch)) await run(['git', 'worktree', 'remove', '--force', worktree], { cwd: root });
  const result = await run(['git', 'worktree', 'add', '-B', branch, worktree, 'HEAD'], { cwd: root });
  if (result.code !== 0) throw new Error(`cannot create optimizer worktree: ${result.stderr}`);
}

function durationMs(value) {
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!match) throw new Error(`--max-time must be a duration such as 15m or 0.25h, got ${value}`);
  const amount = Number(match[1]);
  return amount * ({ ms: 1, s: 1e3, m: 6e4, h: 3.6e6 }[(match[2] ?? 'm').toLowerCase()]);
}

function optimizerCommand(runner, model, direction, worktree) {
  if (runner === 'codex') return ['codex', 'exec', '--model', model, '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--cd', worktree, direction.prompt];
  if (runner === 'claude') return ['claude', '-p', direction.prompt, '--model', model, '--dangerously-skip-permissions'];
  return [runner, direction.prompt];
}

async function runOptimizer({ runner, model, direction, worktree, maxTime }) {
  const promptFile = path.join('/tmp', `simforge-${direction.id}.md`);
  await writeFile(promptFile, `${direction.prompt}\n`, 'utf8');
  let result;
  try {
    result = await run(optimizerCommand(runner, model, direction, worktree), { cwd: worktree, timeoutMs: durationMs(maxTime) });
  } catch (error) {
    result = { code: -1, signal: null, stdout: '', stderr: String(error?.stack ?? error) };
  }
  return { direction: direction.id, runner, model, maxTime, code: result.code, signal: result.signal, stdout: result.stdout.slice(-4000), stderr: result.stderr.slice(-4000), worktree, promptFile };
}

async function readReport(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}
function medianMetric(report, key) { return report?.aggregate?.[key]?.p50 ?? null; }
function gateAgainstNoise(baseline, candidate) {
  if (!baseline || !candidate) return { accepted: false, reason: 'missing baseline or candidate measurement' };
  const baselineMs = medianMetric(baseline, 'elapsedMs');
  const candidateMs = medianMetric(candidate, 'elapsedMs');
  if (!Number.isFinite(baselineMs) || !Number.isFinite(candidateMs)) return { accepted: false, reason: 'elapsed median unavailable' };
  const improvement = (baselineMs - candidateMs) / baselineMs;
  const baselineNoise = baseline.aggregate.elapsedMs.relativeMad ?? 0;
  const candidateNoise = candidate.aggregate.elapsedMs.relativeMad ?? 0;
  const minimumDetectableEffect = Math.max(0.05, 2 * Math.max(baselineNoise, candidateNoise));
  if (improvement <= minimumDetectableEffect) return { accepted: false, reason: 'inside noise floor', improvement, minimumDetectableEffect, baselineNoise, candidateNoise };
  return { accepted: true, reason: 'outside noise floor', improvement, minimumDetectableEffect, baselineNoise, candidateNoise };
}

async function appendScore(scoreboard, value) {
  await mkdir(path.dirname(scoreboard), { recursive: true });
  await appendFile(scoreboard, `${JSON.stringify(value)}\n`);
}

async function orxExperiment(project, direction, root) {
  if (!project) return { status: 'not-registered', command: `orx create-experiment <PROJECT_ID> --title '${direction.title}' --description '${direction.prompt}' --run-command 'node scripts/benchmarks/${direction.benchmark === 'cli' ? 'cli-render-benchmark' : 'browser-app-benchmark'}.mjs'` };
  const existing = await run(['orx', 'project', 'view', project], { cwd: root });
  const marker = `${direction.title}`;
  if (existing.stdout.includes(marker)) return { status: 'already-present', project };
  const result = await run(['orx', 'create-experiment', project, '--title', direction.title, '--description', direction.prompt, '--run-command', `node scripts/benchmarks/${direction.benchmark === 'cli' ? 'cli-render-benchmark' : 'browser-app-benchmark'}.mjs`], { cwd: root });
  return { status: result.code === 0 ? 'created' : 'failed', project, stdout: result.stdout.slice(-1000), stderr: result.stderr.slice(-1000) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runner = args.get('runner') ?? 'codex';
  const model = args.get('model') ?? 'opus-5';
  const maxTime = args.get('max-time') ?? '15m';
  const scoreboard = path.resolve(args.get('scoreboard') ?? DEFAULT_SCOREBOARD);
  const worktreeRoot = path.resolve(args.get('worktrees') ?? path.join(ROOT, '..'));
  const dataRoot = args.get('data-root');
  const scenario = args.get('scenario');
  const orxProject = args.get('orx-project') ?? process.env.ORX_PROJECT;
  const baseline = args.get('baseline') ? await readReport(path.resolve(args.get('baseline'))) : null;
  const prepared = await Promise.all(DIRECTIONS.map(async (direction) => {
    const worktree = path.join(worktreeRoot, `orx-${direction.id}`);
    await prepareWorktree(ROOT, direction, worktree);
    return { direction, worktree };
  }));
  const agentRuns = await Promise.all(prepared.map((value) => runOptimizer({ runner, model, direction: value.direction, worktree: value.worktree, maxTime })));
  const orx = await Promise.all(DIRECTIONS.map((direction) => orxExperiment(orxProject, direction, ROOT)));
  const entries = [];
  for (let index = 0; index < prepared.length; index += 1) {
    const { direction, worktree } = prepared[index];
    const agent = agentRuns[index];
    const runDir = outputFor(worktree, direction);
    let candidate = null;
    if (dataRoot && scenario) {
      const benchmarkScript = direction.benchmark === 'cli' ? 'cli-render-benchmark.mjs' : 'browser-app-benchmark.mjs';
      const command = direction.benchmark === 'cli'
        ? [process.execPath, path.join(worktree, 'scripts/benchmarks', benchmarkScript), '--data-root', dataRoot, '--scenario', scenario, '--repeats', '2', '--seconds', '1', '--out', runDir]
        : [process.execPath, path.join(worktree, 'scripts/benchmarks', benchmarkScript), '--data-root', dataRoot, '--base-url', args.get('base-url') ?? 'http://127.0.0.1:5430', '--out', path.join(runDir, 'report.json')];
      const measured = await run(command, { cwd: worktree });
      candidate = await readReport(path.join(runDir, 'report.json'));
      if (!candidate) candidate = { schema: 'simforge.optimizer-measurement/v1', command, exitCode: measured.code, stderr: measured.stderr.slice(-4000) };
    }
    const noiseGate = direction.benchmark === 'cli' ? gateAgainstNoise(baseline, candidate) : { accepted: false, reason: 'browser candidate requires a browser baseline and quality gate before acceptance' };
    const entry = {
      schema: 'simforge.benchmark-scoreboard-entry/v1', recordedAt: new Date().toISOString(), direction: direction.id,
      benchmark: direction.benchmark, runner, model, worktree, agent, orxExperiment: orx[index], measurement: candidate,
      gate: noiseGate, status: noiseGate.accepted ? 'accepted' : 'rejected', rejectionRecorded: !noiseGate.accepted,
    };
    entries.push(entry);
    await appendScore(scoreboard, { ...entry, entrySha256: sha256(entry) });
  }
  const summary = { schema: 'simforge.optimizer-dispatch/v1', runner, model, maxTime, concurrentAgents: agentRuns.length, entries: entries.map((entry) => ({ direction: entry.direction, status: entry.status, reason: entry.gate.reason })), scoreboard };
  await writeJson(path.join(path.dirname(scoreboard), 'dispatch-report.json'), summary);
  console.log(JSON.stringify(summary, null, 2));
}

await main();
