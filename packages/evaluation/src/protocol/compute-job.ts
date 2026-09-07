/**
 * `simforge.compute-job/v1` — the job document the cloud worker handler hands
 * to `simforge-eval-worker`, plus `simforge.policy-episode-params/v1`.
 *
 * The control plane resolves every customer-supplied artifact id to an exact
 * object, downloads it, and passes a LOCAL path. This runner therefore never
 * fetches from the network, never sees a presigned URL and never sees a
 * customer credential. Input integrity is verified against the declared
 * digest before use, so a truncated download fails as `input_error` instead of
 * looking like a model failure.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import { z } from 'zod';

import { OpenloopParamsSchema, type OpenloopParams } from './params.js';

export const COMPUTE_JOB_SCHEMA = 'simforge.compute-job/v1';

export const JOB_KINDS = [
  'alpamayo.openloop',
  'alpamayo.text',
  'alpamayo.closedloop-episode',
  'reconstruct.nurec',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];


export const JobInputSchema = z.object({
  role: z.string().min(1),
  localPath: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  bytes: z.number().int().nonnegative().optional(),
});
export type JobInput = z.infer<typeof JobInputSchema>;

export const ComputeJobInputSchema = z.object({
  schema: z.literal(COMPUTE_JOB_SCHEMA).default(COMPUTE_JOB_SCHEMA),
  jobId: z.string().min(1),
  attemptId: z.string().min(1),
  kind: z.enum(JOB_KINDS),
  workspaceId: z.string().min(1).nullable().default(null),
  model: z.object({
    family: z.string().min(1),
    revision: z.string().min(1),
    quant: z.string().min(1),
    attn: z.string().min(1).nullable().default(null),
  }),
  /** `simforge.openloop-params/v2` or `simforge.policy-episode-params/v1`. */
  params: z.record(z.string(), z.unknown()),
  inputs: z.array(JobInputSchema).default([]),
  outputDir: z.string().min(1),
  limits: z
    .object({
      maxItems: z.number().int().positive().default(64),
      maxSimSeconds: z.number().positive().default(60),
    })
    .default({}),
  /** How to reach the already-running model engine in this worker. */
  endpoint: z
    .object({
      httpUrl: z.string().url().optional(),
      socketPath: z.string().min(1).optional(),
      timeoutMs: z.number().int().positive().max(1_800_000).default(600_000),
    })
    .optional(),
});
export type ComputeJobInput = z.infer<typeof ComputeJobInputSchema>;

/** Resolve `role` against the job's inputs; throws with the known roles. */
export function resolveJobInput(job: ComputeJobInput, role: string): JobInput {
  const found = job.inputs.find((input) => input.role === role);
  if (!found) {
    throw new Error(`job ${job.jobId} has no input with role ${role} (have: ${job.inputs.map((i) => i.role).join(', ') || 'none'})`);
  }
  return found;
}

/**
 * Verify every declared input digest and size before the job touches them.
 *
 * Returns the mismatches; the caller fails the attempt as `input_error`. A
 * corrupted or truncated download must never be interpreted as a model or
 * scenario failure.
 */
export async function verifyJobInputs(job: ComputeJobInput): Promise<string[]> {
  const problems: string[] = [];
  for (const input of job.inputs) {
    let stats;
    try {
      stats = await stat(input.localPath);
    } catch {
      problems.push(`${input.role}: ${input.localPath} is missing`);
      continue;
    }
    if (input.bytes !== undefined && stats.size !== input.bytes) {
      problems.push(`${input.role}: ${stats.size} bytes on disk, job declared ${input.bytes}`);
      continue;
    }
    if (input.sha256 === undefined) continue;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(input.localPath)) hash.update(chunk as Buffer);
    const digest = hash.digest('hex');
    if (digest !== input.sha256) {
      problems.push(`${input.role}: sha256 ${digest} does not match the declared ${input.sha256}`);
    }
  }
  return problems;
}

/** Openloop params carried by a job, with the job's item cap applied. */
export function openloopParamsOf(job: ComputeJobInput): OpenloopParams {
  const params = OpenloopParamsSchema.parse(job.params);
  if (params.items.length > job.limits.maxItems) {
    throw new Error(`job ${job.jobId} carries ${params.items.length} items, limit is ${job.limits.maxItems}`);
  }
  return params;
}
