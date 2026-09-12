import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runSimulation, traceDigest, type ActionHook } from '../../packages/engine/src/index.ts';
import { LANE_LEFT, scenario, syntheticGraph, vehicle } from '../../packages/engine/src/__tests__/fixtures/scenarios.js';

const graph = syntheticGraph();
const outDir = resolve(process.argv[2] ?? 'run/evidence/closed-loop');

function input(seed: string) {
  const ego = vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 30, speedMps: 0, cruiseSpeedMps: 0 });
  const ambient = { ...vehicle(graph, { id: 'ambient-lead', rsl: LANE_LEFT, s: 48, speedMps: 10, cruiseSpeedMps: 10 }), tags: ['ambient'] };
  return scenario(graph, {
    seed,
    physics: { mode: 'dynamic-v1' },
    warmupSeconds: 0,
    clipSeconds: 4,
    actors: [ego, ambient],
  });
}

const egoStop: ActionHook = ({ actorId }) => actorId === 'ego' ? { targetSpeedMps: 0 } : undefined;

function run(seed: string) {
  const result = runSimulation(input(seed), {
    graph,
    guards: 'skip',
    ambientReactivity: 'reactive',
    actionHook: egoStop,
  });
  const trace = result.trace;
  const lead = trace.ticks.actors['ambient-lead'];
  const ego = trace.ticks.actors.ego;
  if (!lead || !ego) throw new Error('closed-loop evidence actors missing');
  const gaps = lead.x.map((x, i) => Math.abs(x - ego.x[i]!));
  return {
    seed,
    digest: traceDigest(trace),
    ticks: trace.ticks.t.length,
    initialGapM: gaps[0],
    minimumGapM: Math.min(...gaps),
    leadFinalSpeedMps: lead.speedMps.at(-1),
    egoFinalSpeedMps: ego.speedMps.at(-1),
    trace,
  };
}

await mkdir(outDir, { recursive: true });
const deterministicA = run('closed-loop-seed-1');
const deterministicB = run('closed-loop-seed-1');
const stochastic = ['seed-a', 'seed-b', 'seed-c', 'seed-d', 'seed-e'].map(run);
const report = {
  schema: 'simforge.closed-loop-evidence.v1',
  trafficMode: 'reactive',
  policy: 'ego-target-speed-zero',
  deterministic: {
    equalDigest: deterministicA.digest === deterministicB.digest,
    digest: deterministicA.digest,
  },
  stochastic: {
    seeds: stochastic.map(({ seed, digest, minimumGapM }) => ({ seed, digest, minimumGapM })),
    distinctDigestCount: new Set(stochastic.map(({ digest }) => digest)).size,
  },
  rollout: {
    ticks: deterministicA.ticks,
    initialGapM: deterministicA.initialGapM,
    minimumGapM: deterministicA.minimumGapM,
    leadFinalSpeedMps: deterministicA.leadFinalSpeedMps,
    egoFinalSpeedMps: deterministicA.egoFinalSpeedMps,
  },
  pass: deterministicA.digest === deterministicB.digest && deterministicA.minimumGapM > 0,
};
await writeFile(resolve(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await writeFile(resolve(outDir, 'deterministic.trace.json'), JSON.stringify(deterministicA.trace) + '\n');
await writeFile(resolve(outDir, 'episode.json'), JSON.stringify({
  schema: 'simforge.training-episode.v1',
  scenarioSeed: deterministicA.seed,
  observationSource: 'deterministic.trace.json',
  policyAction: 'ego-target-speed-zero',
  sensors: [],
  privilegedTruth: deterministicA.trace.ticks,
}, null, 2) + '\n');
await writeFile(resolve(outDir, 'manifest.json'), JSON.stringify({
  schema: 'simforge.closed-loop-evidence-manifest.v1',
  report: 'report.json',
  trace: 'deterministic.trace.json',
  command: 'pnpm exec tsx scripts/rl/closed-loop-evidence.mts',
}, null, 2) + '\n');
console.log(JSON.stringify(report));
