#!/usr/bin/env node
/**
 * Dump a CPU reference rollout of `EnvSession` for one document as JSONL, so
 * `simforge_oss_gpu.conformance` can compare the device batch decision by
 * decision against the semantic reference.
 *
 *   node adapters/gpu/tools/reference-rollout.mjs \
 *     --input scenario.json --topology topology-index.json.gz \
 *     --episode episode.json --actions actions.json --seed 7 --out rollout.jsonl
 *
 * `actions.json` is a JSON array of EnvAction objects (one per decision; the
 * rollout stops at the first terminated/truncated decision or when the actions
 * run out). `episode.json` is the EpisodeConfig object handed to EnvSession.
 *
 * Record layout per line (decision 0 is the reset observation):
 *   { "decision": k, "tS", "stateVector": [10], "objects": [[id, range, bearing, rangeRate, los]...],
 *     "reward", "rewardTerms": {progress, proximity, comfort, collision?, goal?},
 *     "terminated", "truncated",
 *     "actors": [{ id, x, y, headingRad, speedMps, accelMps2, lateralOffsetM, lateralRateMps, s, present }],
 *     "events": [{ t, kind, ... }] }
 *
 * The script needs the workspace's built engine + training-env packages on the
 * module path (run it from the repository root after `pnpm -r build`); it is
 * qualification tooling, not shipping runtime.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { buildLaneGraph } from '../../../packages/engine/dist/node.js';
import { sessions } from '../../../packages/training-env/dist/node.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing --${name}`);
  }
  return process.argv[i + 1];
}

const input = JSON.parse(readFileSync(arg('input'), 'utf8'));
const graph = buildLaneGraph(readFileSync(arg('topology')));
const episode = JSON.parse(readFileSync(arg('episode', '/dev/null'), 'utf8') || '{}');
const actions = JSON.parse(readFileSync(arg('actions'), 'utf8'));
const seedRaw = arg('seed', undefined);
const seed = seedRaw === undefined ? undefined : /^-?\d+$/.test(seedRaw) ? Number(seedRaw) : seedRaw;

const env = sessions().env({ input, graph, episode });

function record(decision, result) {
  const snap = env.egoPose();
  return {
    decision,
    tS: result.info.tS,
    stateVector: result.observation.stateVector ? Array.from(result.observation.stateVector) : null,
    objects: result.observation.objects.map((o) => [o.id, o.rangeM, o.bearingRad, o.rangeRateMps, o.lineOfSight ? 1 : 0]),
    reward: result.reward,
    rewardTerms: result.info.rewardTerms,
    terminated: result.terminated,
    truncated: result.truncated,
    egoPose: snap,
    events: result.info.events,
    // `minima` are pair metrics the device batch does not produce; kept for the record.
    minima: result.info.minima,
  };
}

const lines = [];
let result = env.reset(seed);
lines.push(JSON.stringify(record(0, result)));
for (let k = 0; k < actions.length && !result.terminated && !result.truncated; k++) {
  result = env.step(actions[k] ?? {});
  lines.push(JSON.stringify(record(k + 1, result)));
}
writeFileSync(arg('out'), lines.join('\n') + '\n');
process.stderr.write(`wrote ${lines.length} decisions for ego ${env.ego}\n`);
