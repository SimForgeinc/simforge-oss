/**
 * `@simforge-oss/engine/node` — the engine façade bound to the N-API addon.
 *
 * Synchronous: the addon is loaded on first use and every call executes in the
 * native runtime. There is no TypeScript simulator behind any export here.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { addonCandidates, native } from '@simforge-oss/native-runtime';

import type { TopologyIndex } from './map/topology.js';
import type { SceneState } from './scene-state/schema.js';
import type { EvaluateFilters, TraceEvaluation } from './trace/evaluate.js';
import type { SimIssue } from './errors.js';
import type { SimResult } from './result.js';
import type { ActorKind } from './schema/input.js';
import {
  EngineRuntime,
  type MotionLimits,
  type LaneGraph,
  type NativeMap,
  type RunSimulationOptions,
  type ScenarioSource,
  type TraceHandle,
  type TraceSource,
} from './runtime.js';

export * from './index.js';

let runtime: EngineRuntime | null = null;

/** The process-wide engine runtime over the loaded addon. */
export function engine(): EngineRuntime {
  if (!runtime) runtime = new EngineRuntime(native());
  return runtime;
}

export function buildLaneGraph(topology: TopologyIndex | Uint8Array): LaneGraph {
  return engine().laneGraph(topology);
}

/** The motion envelope the engine integrates for `kind`; native constants, not a JS copy. */
export function motionLimits(kind: ActorKind): MotionLimits {
  return engine().motionLimits(kind);
}

export function runSimulation(input: ScenarioSource, options: RunSimulationOptions): SimResult {
  return engine().runSimulation(input, options);
}

export function checkFeasibility(input: ScenarioSource, graph: LaneGraph): SimIssue[] {
  return engine().checkFeasibility(input, graph);
}

export function parseTrace(source: TraceSource): TraceHandle {
  return engine().trace(source);
}

export function traceDigest(source: TraceSource): string {
  return engine().traceDigest(source);
}

export function evaluateTrace(source: TraceSource, filters?: EvaluateFilters): TraceEvaluation {
  return engine().evaluateTrace(source, filters);
}

export function sceneState(source: TraceSource): SceneState {
  return engine().sceneState(source);
}

/** Load an installed map directory from the immutable map corpus. */
export function loadNativeMap(dir: string): NativeMap {
  return engine().module.MapBundle.load(dir);
}

export interface RuntimeIdentity {
  /** Absolute path of the addon file the runtime loaded. */
  readonly addonPath: string;
  /** SHA-256 of the addon bytes, for frozen receipts. */
  readonly addonSha256: string;
  readonly engineVersion: string;
  readonly abiVersion: number;
}

/** Identity of the native runtime executing in this process. */
export function runtimeIdentity(): RuntimeIdentity {
  const addonPath = addonCandidates().find((candidate) => existsSync(candidate));
  if (!addonPath) throw new Error('@simforge-oss/engine/node: no native addon is installed for this platform');
  const { engineVersion, abiVersion } = engine().version();
  return {
    addonPath,
    addonSha256: createHash('sha256').update(readFileSync(addonPath)).digest('hex'),
    engineVersion,
    abiVersion,
  };
}
