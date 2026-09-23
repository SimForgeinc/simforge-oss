import { createHash } from 'node:crypto';
import { native } from '@simforge-oss/native-runtime';
import { parseTrace, runSimulation } from '@simforge-oss/engine/node';
import type { SimScenarioInput } from '@simforge-oss/engine';
import type { CompiledTemplate, InstalledMapBundle, MatchedSite } from '@simforge-oss/compiler/node';
import { scriptedPolicy } from './drive/policies/scripted.js';
import { routeForActor } from './drive/scene.js';

export const SPLIT_ADMISSION_POLICY = 'native-authored-scripted/v2';
export const BENCH_ADMISSION_MIN_S = 9.3;

/** The explicit paired control intervention; keep ego, its route, map and initial conditions unchanged. */
export function removeSplitHazards(input: SimScenarioInput): SimScenarioInput {
  const ego = input.actors.find((actor) => actor.id === (input.metricSubject ?? 'ego'));
  if (!ego) throw new Error('hazard removal needs the declared metricSubject ego');
  return {
    ...input, actors: [ego], interactions: [], props: [], occluders: [], occlusionPairs: [], nearMissCriteria: [],
  };
}

export function splitInputHash(input: unknown): string {
  return createHash('sha256').update(native().canonicalJson(JSON.stringify(input))).digest('hex');
}

export function splitSiteKey(map: string, site: MatchedSite): string {
  // Site IDs include the template anchor; the underlying map-intel origin does not.
  return `${map}/${site.frame.origin.mapFeatureId}`;
}

export function splitGeometryFindings(site: MatchedSite, compiled: CompiledTemplate): string[] {
  const findings = site.clauses.filter((clause) => clause.essentiality === 'required' && (!clause.supported || clause.slack > 0)).map((clause) => `${clause.path}: ${clause.reason}`);
  findings.push(...site.degradation.failedRequiredClauses);
  findings.push(...site.degradation.repairs.filter((repair) => repair.touchesRequired).map((repair) => `required repair: ${repair.note ?? repair.kind}`));
  findings.push(...compiled.manifest.issues.filter((issue) => issue.severity === 'error').map((issue) => `${issue.code}: ${issue.reason}`));
  findings.push(...compiled.manifest.notes.filter((note) => note.impact !== 'informational').map((note) => `${note.path}: ${note.reason}`));
  if (!compiled.manifest.feasible && findings.length === 0) findings.push('native compiler reported infeasible');
  return findings;
}

/** Exercise the real bench reference policy after its 63 authored decisions. No renderer. */
async function benchWindowContinuation(input: SimScenarioInput, bundle: InstalledMapBundle, seed: number) {
  const episode = new (native().Episode)(JSON.stringify({
    scenario: { ...input, clipSeconds: Math.max(input.clipSeconds, BENCH_ADMISSION_MIN_S) },
    seed, decisionHz: 10, warmupDecisions: 63, maxDecisions: 30,
    observation: { channels: [{ kind: 'state' }] },
  }), bundle.graph);
  try {
    episode.reset();
    const egoSource = input.actors.find((actor) => actor.id === episode.ego)!;
    let step = 0;
    while (!episode.ended) {
      const snapshot = JSON.parse(episode.snapshot()) as {
        tS: number; actors: { id: string; kind: string; state: { x: number; y: number; headingRad: number; speedMps: number; present: boolean } }[];
      };
      const ego = snapshot.actors.find((actor) => actor.id === episode.ego)!;
      const pose = { x: ego.state.x, y: ego.state.y, yawRad: ego.state.headingRad, speedMps: ego.state.speedMps };
      const decision = await scriptedPolicy.act({
        step, tS: snapshot.tS, pose, egoHistory: [], frames: {}, frameSize: { width: 512, height: 384 },
        egoId: episode.ego, mapId: input.mapId, graph: bundle.graph,
        actors: snapshot.actors.map((actor) => ({ id: actor.id, kind: actor.kind, x: actor.state.x, y: actor.state.y, yawRad: actor.state.headingRad, speedMps: actor.state.speedMps, present: actor.state.present })),
        route: routeForActor(bundle.graph, egoSource, pose),
      }, seed + step);
      const action = decision.action;
      episode.step(JSON.stringify({
        k: 's', speedMps: action.targetSpeedMps, accelerationMps2: action.targetAccelerationMps2,
        motionDirection: action.motionDirection, previewPoint: action.previewPoint, previewHeadingRad: action.previewHeadingRad,
      }));
      step += 1;
    }
    return { result: JSON.parse(episode.finish()) as AdmissionEpisodeResult, trace: episode.traceJson() };
  } finally { episode.close(); }
}

interface AdmissionEpisodeResult {
  termReason: string | null; timing: { simulationS: number }; episodeDigest: string;
}

export interface BenchWindowAdmission {
  schema: 'simforge.bench-window-admission/v1';
  status: 'passed' | 'failed';
  minimumS: number; prologueS: number; reactionMarginS: number;
  hazardOnsets: { kind: string; subject: string; tS: number | null }[];
  authoredDefaultGoals: AdmissionEpisodeResult;
  benchContinuation: AdmissionEpisodeResult;
  findings: string[];
}

/** Native rehearsal and Episodes own all simulation and termination; the bench policy only supplies actions. */
export async function rehearseSplitInput(input: SimScenarioInput, bundle: InstalledMapBundle, seed: number) {
  const run = runSimulation(input, { graph: bundle.graph });
  const trace = run.trace;
  const metrics = trace.metrics;
  const occlusion = metrics.declaredOcclusion ?? [];
  const geometry = run.issues.filter((issue) => issue.severity === 'error').map((issue) => `${issue.code}: ${issue.reason}`);
  const occlusionFailures: string[] = [];
  if (occlusion.length !== (input.occlusionPairs ?? []).length) occlusionFailures.push('declared occlusion evidence is incomplete');
  for (const relation of occlusion) {
    if (relation.status !== 'revealed_before_conflict' || relation.firstBlockedT === null || relation.losOpenT === null || relation.conflictT === null ||
        !(relation.firstBlockedT < relation.losOpenT && relation.losOpenT < relation.conflictT) || !(relation.revealToConflictS! > 0) || relation.relevantOccluderIds.length === 0) {
      occlusionFailures.push(`${relation.observer}->${relation.target}/${relation.occluderId ?? 'any'}: ${relation.status}`);
    }
  }
  const episode = new (native().Episode)(JSON.stringify({
    scenario: input, seed, goal: null, decisionHz: 10, warmupDecisions: Math.ceil(input.clipSeconds * 10),
    observation: { channels: [{ kind: 'state' }] },
  }), bundle.graph);
  let result: AdmissionEpisodeResult;
  let episodeTrace: string;
  try {
    episode.reset();
    result = JSON.parse(episode.finish());
    episodeTrace = episode.traceJson();
  } finally { episode.close(); }
  const solvabilityFailures: string[] = [];
  if (metrics.collisions.length) solvabilityFailures.push(`scripted rehearsal collision: ${metrics.collisions.map((collision) => `${collision.a}/${collision.b}@${collision.t}`).join(', ')}`);
  if (result.termReason !== 'horizon' || result.timing.simulationS + 1e-6 < input.clipSeconds) solvabilityFailures.push(`kernel scripted completion: ${result.termReason ?? 'none'} at ${result.timing.simulationS}/${input.clipSeconds}s`);
  if ((trace.ticks.t.at(-1) ?? -1) + 1e-6 < input.clipSeconds) solvabilityFailures.push('native rehearsal did not reach the complete clip horizon');
  // The full-horizon witness above intentionally suppresses goals, not safety.
  // A separate default-goal Episode prevents that witness from concealing an
  // authored queue success or route end inside the comparison-policy prologue.
  const defaultGoalEpisode = new (native().Episode)(JSON.stringify({
    scenario: input, seed, decisionHz: 10, warmupDecisions: Math.ceil(input.clipSeconds * 10),
    observation: { channels: [{ kind: 'state' }] },
  }), bundle.graph);
  let defaultGoalResult: AdmissionEpisodeResult;
  let defaultGoalTrace: string;
  try {
    defaultGoalEpisode.reset();
    defaultGoalResult = JSON.parse(defaultGoalEpisode.finish());
    defaultGoalTrace = defaultGoalEpisode.traceJson();
  } finally { defaultGoalEpisode.close(); }
  const bench = await benchWindowContinuation(input, bundle, seed);
  const hazardOnsets: { kind: string; subject: string; tS: number | null }[] = occlusion.map((relation) => ({
    kind: 'occlusion-reveal', subject: `${relation.observer}->${relation.target}/${relation.occluderId ?? 'any'}`, tS: relation.losOpenT,
  }));
  for (const interaction of input.interactions ?? []) {
    if (interaction.verb !== 'changeLane' || interaction.actorId === (input.metricSubject ?? 'ego')) continue;
    const event = trace.events.find((event) => event.kind === 'lateral_maneuver_planned' && event.interactionId === interaction.id);
    hazardOnsets.push({ kind: 'lane-change', subject: interaction.id, tS: event?.t ?? null });
  }
  const benchFailures: string[] = [];
  for (const onset of hazardOnsets) {
    if (onset.tS === null || onset.tS + 1e-6 < BENCH_ADMISSION_MIN_S) benchFailures.push(`${onset.subject}: ${onset.kind} at ${onset.tS ?? 'never'}; requires >=${BENCH_ADMISSION_MIN_S}s`);
  }
  for (const [policy, completion] of [['native-authored/default-goals', defaultGoalResult], ['bench-scripted/prologue63+reaction30', bench.result]] as const) {
    if (completion.timing.simulationS + 1e-6 < BENCH_ADMISSION_MIN_S) benchFailures.push(`${policy}: ${completion.termReason ?? 'none'} at ${completion.timing.simulationS}s; requires >=${BENCH_ADMISSION_MIN_S}s`);
  }
  const benchWindow: BenchWindowAdmission = {
    schema: 'simforge.bench-window-admission/v1', status: benchFailures.length ? 'failed' : 'passed',
    minimumS: BENCH_ADMISSION_MIN_S, prologueS: 6.3, reactionMarginS: 3,
    hazardOnsets, authoredDefaultGoals: defaultGoalResult, benchContinuation: bench.result,
    findings: benchFailures,
  };
  return {
    receipt: {
      policy: SPLIT_ADMISSION_POLICY,
      geometry: { status: geometry.length ? 'failed' : 'passed', findings: geometry },
      occlusion: { status: occlusionFailures.length ? 'failed' : 'passed', required: occlusion.length > 0, findings: occlusionFailures, relations: occlusion },
      solvability: { status: solvabilityFailures.length ? 'failed' : 'passed', findings: solvabilityFailures, collisions: metrics.collisions, clipSeconds: input.clipSeconds, finalTS: trace.ticks.t.at(-1), ticksSimulated: metrics.ticksSimulated, kernel: result },
      benchWindow,
      rehearsalDigest: parseTrace(trace).digest(),
    },
    trace, episodeTrace, defaultGoalTrace, benchEpisodeTrace: bench.trace,
    failures: [...geometry, ...occlusionFailures, ...solvabilityFailures, ...benchFailures],
  };
}
