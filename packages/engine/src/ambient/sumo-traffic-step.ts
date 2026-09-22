/**
 * The SUMO traffic step as the authoritative simulate job calls it.
 *
 *   simulate(authored, ambient off) → trafficStep → merged trace → persist
 *
 * `simulateAuthoritative` (packages/compiler) is synchronous. SUMO module
 * instantiation is not, so the host prepares a fresh module first and receives
 * a synchronous, single-use step bound to it:
 *
 *   const trafficStep = await createSumoTrafficStep(runtime, context);
 *   simulateAuthoritative({ ..., trafficStep });
 */

import { canonicalJson, sha256 } from '../core/hash.js';
import type { SimScenarioInput } from '../schema/input.js';
import type { SimTrace } from '../trace/trace.js';
import type { MaterializedTrafficArtifactEnvelope } from './materialized-traffic.js';
import type { ResolvedAmbientTrafficProfile } from './profile.js';
import type { SumoRuntime } from './sumo-runtime.js';
import {
  prepareSumoTraffic,
  type SumoTrafficDiagnostics,
  type SumoTrafficNetwork,
} from './sumo-traffic.js';
import { mergeSumoTrafficIntoTrace } from './sumo-trace-merge.js';

export interface SumoTrafficStepContext {
  readonly profile: ResolvedAmbientTrafficProfile;
  /** The map version's `derived/sumo` member bytes and sidecar. */
  readonly network: SumoTrafficNetwork;
  /** The simulate job's trace identity (e.g. `engine().traceDigest`). */
  readonly traceDigest: (trace: SimTrace) => string;
  /** Receives the run diagnostics (signal agreement, SUMO warnings, …). */
  readonly onDiagnostics?: (diagnostics: SumoTrafficDiagnostics) => void;
}

export interface SumoTrafficStepInput {
  readonly authoredTrace: SimTrace;
  readonly resolvedInput: Pick<SimScenarioInput, 'signalPrograms' | 'roadControls'>;
  readonly sourceInputDigest: string;
  readonly closure: { readonly mapAssetId: string; readonly mapVersionId: string };
}

export interface SumoAmbientProvenance {
  readonly mode: 'sumo';
  readonly sumoVersion: string;
  readonly networkSha256: string;
  readonly seed: string | number;
  readonly ambientConfig: Readonly<Record<string, unknown>>;
  readonly configSha256: string;
  readonly resultSha256: string;
}

export interface SumoTrafficStepResult {
  readonly trace: SimTrace;
  readonly stepKey: string;
  readonly envelope: MaterializedTrafficArtifactEnvelope;
  readonly ambient: SumoAmbientProvenance;
}

export type SumoTrafficStep = (input: SumoTrafficStepInput) => SumoTrafficStepResult;

export async function createSumoTrafficStep(
  runtime: SumoRuntime,
  context: SumoTrafficStepContext,
): Promise<SumoTrafficStep> {
  const prepared = await prepareSumoTraffic(runtime);
  return (input) => {
    const result = prepared.run({
      authoredTrace: input.authoredTrace,
      authoredTraceSha256: context.traceDigest(input.authoredTrace),
      sourceInputDigest: input.sourceInputDigest,
      signalPrograms: input.resolvedInput.signalPrograms ?? [],
      roadControls: input.resolvedInput.roadControls ?? [],
      profile: context.profile,
      network: context.network,
      map: { assetId: input.closure.mapAssetId, versionId: input.closure.mapVersionId },
    });
    context.onDiagnostics?.(result.diagnostics);
    return {
      trace: mergeSumoTrafficIntoTrace(input.authoredTrace, result.artifact),
      stepKey: result.key,
      envelope: result.artifact,
      ambient: {
        mode: 'sumo',
        sumoVersion: runtime.version,
        networkSha256: context.network.manifest.sha256,
        seed: context.profile.seed,
        ambientConfig: context.profile,
        configSha256: sha256(canonicalJson(context.profile)),
        resultSha256: result.artifact.sha256,
      },
    };
  };
}
