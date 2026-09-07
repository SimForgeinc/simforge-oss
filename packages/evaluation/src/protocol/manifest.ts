/**
 * `simforge.eval-result-manifest/v1` — the one durable result document every
 * consumer reads: the desktop eval tab, the web portal and the cloud control
 * plane. `result.json` *is* this document and is written LAST, atomically, so
 * its presence is the completion marker and a partially written file can never
 * be mistaken for one.
 *
 * Invariants encoded here, not merely described:
 *
 * - `status` distinguishes `succeeded` from `partial`, `cancelled` and
 *   `failed`. Partial evidence is retained and marked, never presented as a
 *   complete result.
 * - `scored` is independent of `status`: an episode truncated at the edge of a
 *   reconstruction's validity envelope is scored up to the breach yet is not a
 *   successful model result (`status: 'partial'`, `truncation` set), and an
 *   open-loop run without a reference future is `succeeded` but unscored.
 * - `promotable` is false whenever the run is unscored, exploratory,
 *   truncated, or ran in a mode whose numbers are not comparable.
 * - `provenance` pins model, input, runtime, controller, quantization and RNG
 *   identity. Seed identity is explicitly scoped: it is not a cross-GPU
 *   reproducibility claim.
 */

import { createHash } from 'node:crypto';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

export const RESULT_MANIFEST_SCHEMA = 'simforge.eval-result-manifest/v1';

export const RESULT_KINDS = ['openloop', 'text', 'closedloop-episode', 'reconstruct'] as const;
export type ResultKind = (typeof RESULT_KINDS)[number];

export const RESULT_STATUSES = ['succeeded', 'partial', 'failed', 'cancelled'] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

/** Artifact roles the result UIs key off. Frozen with the presentation owner. */
export const ARTIFACT_ROLES = [
  'result-manifest',
  'openloop-result',
  'video',
  'frames',
  'overlay-frames',
  'trajectories',
  'trace',
  'events',
  'score',
  'provenance',
  'runner-summary',
  'evidence',
  'log',
] as const;
export type ArtifactRole = (typeof ARTIFACT_ROLES)[number];

/** Why a run stopped short of its configured budget. */
export const TRUNCATIONS = ['envelope_exceeded', 'terminated', 'truncated', 'cancelled', 'deadline_budget'] as const;

export const ERROR_CODES = [
  'input_error',
  'model_revision_mismatch',
  'capability_error',
  'storage_error',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ArtifactSchema = z.object({
  role: z.enum(ARTIFACT_ROLES),
  /** Relative to the directory holding `result.json`. */
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  mediaType: z.string().min(1).optional(),
});
export type EvalArtifact = z.infer<typeof ArtifactSchema>;

export const ModelProvenanceSchema = z.object({
  family: z.string().nullable(),
  revision: z.string().nullable(),
  checkpointDigest: z.string().nullable(),
  quant: z.string().nullable(),
  attn: z.string().nullable().default(null),
  torch: z.string().nullable().default(null),
  cuda: z.string().nullable().default(null),
  diffusionSteps: z.number().int().nullable().default(null),
  numTrajSamples: z.number().int().nullable().default(null),
  cameraProfile: z.string().nullable().default(null),
  rngProvenance: z.record(z.string(), z.unknown()).nullable().default(null),
  /** Honest scope of a seed guarantee; never "deterministic" unqualified. */
  determinismScope: z.enum(['same-host-same-device', 'unproven']).default('unproven'),
});

export const InputProvenanceSchema = z.object({
  kind: z.string(),
  ref: z.string().nullable().default(null),
  digest: z.string().nullable().default(null),
  ood: z.array(z.string()).default([]),
  replayContext: z.record(z.string(), z.unknown()).nullable().default(null),
});

export const ResultManifestSchema = z.object({
  schema: z.literal(RESULT_MANIFEST_SCHEMA).default(RESULT_MANIFEST_SCHEMA),
  kind: z.enum(RESULT_KINDS),
  runId: z.string().min(1),
  attemptId: z.string().min(1).nullable().default(null),
  jobId: z.string().min(1).nullable().default(null),
  workspaceId: z.string().min(1).nullable().default(null),
  status: z.enum(RESULT_STATUSES),
  /** Metrics in this manifest are meaningful only when true. */
  scored: z.boolean(),
  /** False for unscored, exploratory, truncated or non-comparable runs. */
  promotable: z.boolean().default(false),
  exploratory: z.boolean().default(false),
  /** `offline-simtime` | `realtime` for episodes; `openloop` otherwise. */
  mode: z.string(),
  truncation: z.enum(TRUNCATIONS).nullable().default(null),
  metrics: z.record(z.string(), z.unknown()).default({}),
  artifacts: z.array(ArtifactSchema).default([]),
  provenance: z.object({
    model: ModelProvenanceSchema.nullable().default(null),
    input: InputProvenanceSchema.nullable().default(null),
    runtime: z.record(z.string(), z.unknown()).default({}),
    controller: z.record(z.string(), z.unknown()).default({}),
    compute: z.record(z.string(), z.unknown()).nullable().default(null),
    metricVersion: z.string().default('simforge.eval-metrics/v1'),
  }),
  timing: z.object({
    startedAt: z.string(),
    completedAt: z.string(),
    durationMs: z.number().int().nonnegative(),
    executionMs: z.number().int().nonnegative().nullable().default(null),
  }),
  error: z
    .object({
      code: z.enum(ERROR_CODES),
      retryable: z.boolean(),
      message: z.string(),
      fields: z.array(z.string()).default([]),
    })
    .nullable()
    .default(null),
});
export type ResultManifest = z.infer<typeof ResultManifestSchema>;

/** Non-retryable codes: re-running them cannot change the outcome. */
const TERMINAL_ERROR_CODES: Record<ErrorCode, boolean> = {
  input_error: false,
  model_revision_mismatch: false,
  capability_error: false,
  storage_error: true,
  internal: true,
};

export const isRetryableErrorCode = (code: ErrorCode): boolean => TERMINAL_ERROR_CODES[code];

/** Describe an on-disk artifact for the manifest (digest + size). */
export async function describeArtifact(
  directory: string,
  relativePath: string,
  role: ArtifactRole,
  mediaType?: string,
): Promise<EvalArtifact> {
  const absolute = path.join(directory, relativePath);
  const bytes = await readFile(absolute);
  const stats = await stat(absolute);
  return {
    role,
    path: relativePath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: stats.size,
    ...(mediaType ? { mediaType } : {}),
  };
}

/**
 * Write `result.json` atomically into `directory`.
 *
 * The document is validated first: an invalid manifest is a programming error
 * that must not reach the durable store, where it would be read as a
 * completion marker.
 */
export async function writeResultManifest(directory: string, manifest: ResultManifest): Promise<string> {
  const parsed = ResultManifestSchema.parse(manifest);
  const target = path.join(directory, 'result.json');
  const scratch = path.join(directory, 'result.json.partial');
  await writeFile(scratch, `${JSON.stringify(parsed, null, 1)}\n`, 'utf8');
  await rename(scratch, target);
  return target;
}
