/**
 * The worker -> control plane output contract.
 *
 * Every document a render worker sends to (or uploads for) a control plane is
 * listed here with the zod schema the worker produces it through. The frozen
 * snapshot `packages/render/contract/worker-output-contract.json` records, per
 * document, the BASELINE key paths an older control plane already accepts.
 *
 * The rule (enforced by `worker-output-contract.test.ts`):
 *   - A baseline never grows. A new output key on an existing document must be
 *     gated behind a `CONTROL_FEATURE_*` constant (worker-control.ts), listed in
 *     `CONTROL_FEATURE_OUTPUTS`, offered by the control plane that parses it
 *     (`CONTROL_FEATURES_V1`), and written by the worker only when the lease's
 *     `controlFeatures` lists it.
 *   - A new document (a new route) must be optional for the worker: it treats a
 *     404/405 from an older control plane as "unsupported" (`isUnsupportedControlRoute`).
 *
 * Deploy order is free because of this: server N accepts worker N-1 (baseline
 * keys only), worker N works against server N-1 (it only writes what N-1 offered).
 */
import type { z } from 'zod';

import { RenderArtifactManifestSchema } from '../artifacts.js';
import {
  NativeRenderManifestSchema,
  NativeRunDiagnosticsSchema,
} from '../native/evidence.js';
import {
  ArtifactReserveRequestSchema,
  BlobUrlsRequestSchema,
  CONTROL_FEATURE_OUTPUTS,
  CONTROL_FEATURES_V1,
  WORKER_PREWARM_FEATURES,
  WORKER_INTENT_FEATURES,
  InputUrlsRequestSchema,
  JobClaimRequestSchema,
  JobCompleteRequestSchema,
  JobFailRequestSchema,
  LeaseHeartbeatRequestSchema,
  LeaseProgressRequestSchema,
  PrewarmManifestRequestSchema,
  PrewarmMembersRequestSchema,
  WorkerCacheReportRequestSchema,
  WorkerDrainRequestSchema,
  WorkerRegisterRequestSchema,
} from '../worker-control.js';

export const WORKER_OUTPUT_CONTRACT_SCHEMA = 'simforge.worker-output-contract/v1' as const;

export interface WorkerOutputDocument {
  /** Zod schema the worker builds or validates the document through. */
  readonly schema: z.ZodType;
  /** Route under `api/simforge/internal/` (`*` = a path segment), or the artifact role for uploaded evidence. */
  readonly route: string;
  /** The worker keeps working when a control plane answers 404/405 for this route. */
  readonly optionalRoute: boolean;
}

/** Every worker output a control plane parses. Add a document here when you add a route or evidence file. */
export const WORKER_OUTPUT_DOCUMENTS = {
  'worker.register': { schema: WorkerRegisterRequestSchema, route: 'workers/register', optionalRoute: false },
  'job.claim': { schema: JobClaimRequestSchema, route: 'render-jobs/lease', optionalRoute: false },
  'lease.heartbeat': { schema: LeaseHeartbeatRequestSchema, route: 'render-jobs/*/heartbeat', optionalRoute: false },
  'lease.progress': { schema: LeaseProgressRequestSchema, route: 'render-jobs/*/events', optionalRoute: false },
  'artifact.reserve': { schema: ArtifactReserveRequestSchema, route: 'render-jobs/*/artifacts', optionalRoute: false },
  'job.complete': { schema: JobCompleteRequestSchema, route: 'render-jobs/*/complete', optionalRoute: false },
  'job.fail': { schema: JobFailRequestSchema, route: 'render-jobs/*/fail', optionalRoute: false },
  'worker.drain': { schema: WorkerDrainRequestSchema, route: 'workers/*/state', optionalRoute: false },
  'lease.input-urls': { schema: InputUrlsRequestSchema, route: 'render-jobs/*/input-urls', optionalRoute: true },
  'worker.prewarm-manifest': { schema: PrewarmManifestRequestSchema, route: 'workers/prewarm', optionalRoute: true },
  'worker.prewarm-members': { schema: PrewarmMembersRequestSchema, route: 'workers/prewarm/members', optionalRoute: true },
  'worker.blob-urls': { schema: BlobUrlsRequestSchema, route: 'workers/blob-urls', optionalRoute: true },
  'worker.cache-status': { schema: WorkerCacheReportRequestSchema, route: 'workers/*/cache', optionalRoute: true },
  'native.manifest': { schema: NativeRenderManifestSchema, route: 'artifact:manifest', optionalRoute: false },
  'native.diagnostics': { schema: NativeRunDiagnosticsSchema, route: 'artifact:diagnostics', optionalRoute: false },
  'render.artifact-manifest': { schema: RenderArtifactManifestSchema, route: 'artifact:manifest', optionalRoute: false },
} as const satisfies Record<string, WorkerOutputDocument>;

export type WorkerOutputDocumentName = keyof typeof WORKER_OUTPUT_DOCUMENTS;

type ZodDef = { type: string; [key: string]: unknown };
const defOf = (schema: unknown): ZodDef => (schema as { _zod: { def: ZodDef } })._zod.def;

/**
 * Every key path a schema can produce, as `a.b[].c`; `[]` marks array
 * elements, `{}` the values of a record (whose keys are data, not contract).
 * Union members contribute the union of their keys.
 */
export function schemaKeyPaths(schema: z.ZodType): string[] {
  const out = new Set<string>();
  const walk = (node: unknown, prefix: string, depth: number): void => {
    if (depth > 24) return;
    const def = defOf(node);
    switch (def.type) {
      case 'object': {
        for (const [key, child] of Object.entries(def.shape as Record<string, unknown>)) {
          const path = prefix ? `${prefix}.${key}` : key;
          out.add(path);
          walk(child, path, depth + 1);
        }
        return;
      }
      case 'optional': case 'nullable': case 'default': case 'prefault': case 'readonly':
      case 'catch': case 'nonoptional': case 'success':
        walk(def.innerType, prefix, depth + 1);
        return;
      case 'array':
        walk(def.element, `${prefix}[]`, depth + 1);
        return;
      case 'union':
        for (const option of def.options as unknown[]) walk(option, prefix, depth + 1);
        return;
      case 'intersection':
        walk(def.left, prefix, depth + 1);
        walk(def.right, prefix, depth + 1);
        return;
      case 'record':
        walk(def.valueType, `${prefix}{}`, depth + 1);
        return;
      case 'pipe':
        walk(def.in, prefix, depth + 1);
        return;
      case 'tuple':
        for (const item of def.items as unknown[]) walk(item, `${prefix}[]`, depth + 1);
        return;
      default:
        // Leaves, and `lazy` (recursive JSON values such as `failure.details`) whose keys are data.
        return;
    }
  };
  walk(schema, '', 0);
  return [...out].sort();
}

export interface WorkerOutputContractSnapshot {
  schema: typeof WORKER_OUTPUT_CONTRACT_SCHEMA;
  comment: string[];
  /** Features the control plane at this revision offers, with the output keys each one unlocks. */
  features: Record<string, { constant: string; keys: string[] }>;
  documents: Record<string, { route: string; optionalRoute: boolean; baseline: string[] }>;
}

export const CONTRACT_SNAPSHOT_COMMENT = [
  'Frozen worker -> control plane output contract. GENERATED: pnpm --filter @simforge-oss/render contract:write.',
  'A document baseline never grows: a new key must be gated by a CONTROL_FEATURE_* (worker-control.ts),',
  'listed in CONTROL_FEATURE_OUTPUTS and CONTROL_FEATURES_V1, and written only when the lease offers it.',
];

/** The feature gating `document:path`, directly or through an ancestor key (`parity` gates `parity.pass`). */
export function gatingFeature(gated: ReadonlyMap<string, string>, document: string, path: string): string | undefined {
  let candidate = path;
  while (candidate) {
    const feature = gated.get(`${document}:${candidate}`);
    if (feature) return feature;
    const cut = Math.max(candidate.lastIndexOf('.'), candidate.lastIndexOf('['), candidate.lastIndexOf('{'));
    candidate = cut > 0 ? candidate.slice(0, cut) : '';
  }
  return undefined;
}

/** `document:path` for every key a control feature gates. */
export function gatedOutputKeys(): Map<string, string> {
  const gated = new Map<string, string>();
  for (const [feature, keys] of Object.entries(CONTROL_FEATURE_OUTPUTS as Record<string, readonly string[]>)) {
    for (const key of keys) gated.set(key, feature);
  }
  return gated;
}

export interface ContractViolation {
  readonly rule: 'ungated-key' | 'baseline-key-removed' | 'new-required-route' | 'feature-not-offered'
    | 'feature-without-outputs' | 'feature-output-unknown' | 'feature-output-unmapped-constant';
  readonly message: string;
}

/**
 * Compare the code against the frozen snapshot. `featureConstants` maps each
 * exported `CONTROL_FEATURE_*` constant name to its value (the test passes the
 * real module namespace so a constant cannot hide from the check).
 */
export function workerOutputContractViolations(
  snapshot: WorkerOutputContractSnapshot | null,
  featureConstants: Readonly<Record<string, string>>,
): ContractViolation[] {
  const violations: ContractViolation[] = [];
  const gated = gatedOutputKeys();
  const offered = new Set<string>(CONTROL_FEATURES_V1);
  const outputs = CONTROL_FEATURE_OUTPUTS as Record<string, readonly string[]>;
  const constantByValue = new Map(Object.entries(featureConstants).map(([name, value]) => [value, name]));

  for (const [name, value] of Object.entries(featureConstants)) {
    if (!offered.has(value)) {
      violations.push({ rule: 'feature-not-offered', message: `${name} ('${value}') is not in CONTROL_FEATURES_V1, so no control plane offers it and no worker will ever write its outputs. Add it to CONTROL_FEATURES_V1 in packages/render/src/worker-control.ts once the control plane parses its keys.` });
    }
    if (!outputs[value]?.length) {
      violations.push({ rule: 'feature-without-outputs', message: `${name} ('${value}') gates no output key. List its keys ('document:key.path') in CONTROL_FEATURE_OUTPUTS in packages/render/src/worker-control.ts.` });
    }
  }
  for (const feature of Object.keys(outputs)) {
    if (!constantByValue.has(feature)) {
      violations.push({ rule: 'feature-output-unmapped-constant', message: `CONTROL_FEATURE_OUTPUTS lists '${feature}' but no exported CONTROL_FEATURE_* constant has that value. Export one from packages/render/src/worker-control.ts.` });
    }
  }

  const current = new Map<string, Set<string>>();
  for (const [document, entry] of Object.entries(WORKER_OUTPUT_DOCUMENTS)) current.set(document, new Set(schemaKeyPaths(entry.schema)));
  for (const [key, feature] of gated) {
    const [document, path] = splitGatedKey(key);
    if (!current.get(document)?.has(path)) {
      violations.push({ rule: 'feature-output-unknown', message: `CONTROL_FEATURE_OUTPUTS['${feature}'] names '${key}', which is not a key of document '${document}'. Use 'document:key.path' with a document from WORKER_OUTPUT_DOCUMENTS (packages/render/src/contract/worker-output-contract.ts).` });
    }
  }
  if (!snapshot) return violations;

  for (const [document, entry] of Object.entries(WORKER_OUTPUT_DOCUMENTS)) {
    const keys = current.get(document)!;
    const frozen = snapshot.documents[document];
    if (!frozen) {
      if (!entry.optionalRoute) {
        violations.push({ rule: 'new-required-route', message: `Document '${document}' (${entry.route}) is new but not optionalRoute: a control plane from the previous release answers 404 and the worker must survive that. Make the worker treat 404/405 as unsupported (isUnsupportedControlRoute) and set optionalRoute: true, then run contract:write.` });
      }
      continue;
    }
    const baseline = new Set(frozen.baseline);
    for (const key of keys) {
      if (baseline.has(key) || gatingFeature(gated, document, key)) continue;
      violations.push({ rule: 'ungated-key', message: `'${document}:${key}' is a new worker output key that a previous-release control plane does not accept. Add \`export const CONTROL_FEATURE_<NAME> = '<area>.<feature>' as const;\` to packages/render/src/worker-control.ts, list '${document}:${key}' under it in CONTROL_FEATURE_OUTPUTS, add it to CONTROL_FEATURES_V1 when the control plane parses it, and write the key only when context.controlFeatures has the feature. Never add it to the baseline.` });
    }
    for (const key of baseline) {
      if (keys.has(key)) continue;
      violations.push({ rule: 'baseline-key-removed', message: `'${document}:${key}' was removed from the worker output. A previous-release control plane may still require it: keep emitting it for one release. If it was optional on every live control plane, acknowledge with contract:write --allow-removal.` });
    }
  }
  return violations;
}

export function splitGatedKey(key: string): [string, string] {
  const index = key.indexOf(':');
  return index < 0 ? ['', key] : [key.slice(0, index), key.slice(index + 1)];
}

/** The snapshot the current code produces (baseline = every ungated key). */
export function buildWorkerOutputContractSnapshot(
  featureConstants: Readonly<Record<string, string>>,
  previous: WorkerOutputContractSnapshot | null,
  options: { allowRemoval?: boolean } = {},
): WorkerOutputContractSnapshot {
  const gated = gatedOutputKeys();
  const outputs = CONTROL_FEATURE_OUTPUTS as Record<string, readonly string[]>;
  const constantByValue = new Map(Object.entries(featureConstants).map(([name, value]) => [value, name]));
  const documents: WorkerOutputContractSnapshot['documents'] = {};
  for (const [document, entry] of Object.entries(WORKER_OUTPUT_DOCUMENTS)) {
    const keys = schemaKeyPaths(entry.schema).filter((key) => !gatingFeature(gated, document, key));
    const frozen = previous?.documents[document];
    // An existing baseline is carried forward, never widened; removals only when acknowledged.
    const baseline = frozen
      ? frozen.baseline.filter((key) => options.allowRemoval ? keys.includes(key) : true)
      : keys;
    documents[document] = { route: entry.route, optionalRoute: entry.optionalRoute, baseline: [...baseline].sort() };
  }
  const features: WorkerOutputContractSnapshot['features'] = {};
  for (const [feature, keys] of Object.entries(outputs).sort(([a], [b]) => a.localeCompare(b))) {
    features[feature] = { constant: constantByValue.get(feature) ?? '', keys: [...keys].sort() };
  }
  return { schema: WORKER_OUTPUT_CONTRACT_SCHEMA, comment: CONTRACT_SNAPSHOT_COMMENT, features, documents };
}

/** Every exported `CONTROL_FEATURE_*` string constant of a module namespace. */
export function controlFeatureConstants(namespace: Readonly<Record<string, unknown>>): Record<string, string> {
  return Object.fromEntries(Object.entries(namespace)
    .filter(([name, value]) => /^CONTROL_FEATURE_[A-Z0-9_]+$/.test(name) && typeof value === 'string')
    // Prewarm and intent features run the other way (control plane -> worker
    // fields a worker opts into via labels.prewarmFeatures / labels.intentFeatures);
    // they gate no worker output.
    .filter(([, value]) => !([...WORKER_PREWARM_FEATURES, ...WORKER_INTENT_FEATURES] as readonly string[]).includes(value as string))
    .map(([name, value]) => [name, value as string]));
}
