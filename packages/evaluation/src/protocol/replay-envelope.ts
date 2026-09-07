/**
 * Replay-context validity envelope, TypeScript side.
 *
 * The reconstruction workstream owns `simforge.replay-context/v1` and its
 * richer helpers (`packages/evaluation/src/replay-context`). The campaign
 * runner needs only three facts before it starts an episode, and needs them
 * even when that module is not present in the build:
 *
 * 1. Is the scene qualified at all (`validity.qualified`, gates G1..G5)?
 * 2. What is the measured envelope, for the record?
 * 3. Did the G5 stock-replay gate pass?
 *
 * So this reader binds directly to the frozen JSON paths. When the owner's
 * module IS available it is preferred, through a dynamic import, so richer
 * validation and the per-step monitor come along automatically.
 *
 * Runtime enforcement itself lives in the Python episode runner
 * (`simforge_oss_gym.replay_envelope`): an episode that leaves the envelope
 * must STOP at the breach — every later frame is rendered from geometry the
 * reconstruction never validated — and is then scored up to that point and
 * flagged. Leaving the envelope is an invalid episode, never a model failure.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

export const REPLAY_CONTEXT_SCHEMA = 'simforge.replay-context/v1';
export const REPLAY_CONTEXT_FILENAME = 'replay-context.json';

export interface EnvelopeLimits {
  readonly lateralM: number;
  readonly longitudinalS: number;
  readonly headingRad: number;
}

export interface ReplayContextSummary {
  readonly sceneId: string;
  readonly bundleDir: string;
  readonly digest: string;
  readonly qualified: boolean;
  readonly envelope: EnvelopeLimits;
  readonly envelopeBasis: Record<string, unknown>;
  readonly gates: Record<string, { passed?: boolean; measured?: unknown; threshold?: unknown }>;
  readonly cameraIds: readonly number[];
  readonly stockReplayPassed: boolean | null;
}

export class ReplayContextError extends Error {
  constructor(readonly code: 'replay_context_missing' | 'replay_context_invalid' | 'replay_context_unqualified', message: string) {
    super(message);
    this.name = 'ReplayContextError';
  }
}

/** The subset of the bundle the campaign runner reads (the owner owns the rest). */
const GateSchema = z
  .object({
    id: z.string().optional(),
    passed: z.boolean().optional(),
    measured: z.unknown().optional(),
    threshold: z.unknown().optional(),
  })
  .passthrough();

const ReplayContextDocumentSchema = z
  .object({
    schema: z.literal(REPLAY_CONTEXT_SCHEMA),
    sceneId: z.string().optional(),
    validity: z
      .object({
        qualified: z.boolean().default(false),
        envelope: z.object({
          lateralM: z.number().finite().nonnegative(),
          longitudinalS: z.number().finite().nonnegative(),
          headingRad: z.number().finite().nonnegative(),
        }),
        gates: z.record(z.string(), GateSchema).default({}),
        envelopeBasis: z.record(z.string(), z.unknown()).default({}),
      })
      .passthrough(),
    cameras: z.array(z.object({ cameraId: z.number().int() }).passthrough()).default([]),
  })
  .passthrough();

const StockReplaySchema = z.object({ passed: z.boolean() }).passthrough();

/** Read `<bundleDir>/replay-context.json` and the G5 verdict beside it. */
export async function loadReplayContextSummary(bundleDir: string): Promise<ReplayContextSummary> {
  const manifestPath = bundleDir.endsWith('.json') ? bundleDir : path.join(bundleDir, REPLAY_CONTEXT_FILENAME);
  let bytes: Buffer;
  try {
    bytes = await readFile(manifestPath);
  } catch {
    throw new ReplayContextError('replay_context_missing', `no replay-context bundle at ${manifestPath}`);
  }
  let parsed: z.infer<typeof ReplayContextDocumentSchema>;
  try {
    parsed = ReplayContextDocumentSchema.parse(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    const detail = error instanceof z.ZodError
      ? error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')
      : String(error);
    throw new ReplayContextError('replay_context_invalid', `${manifestPath}: ${detail}`);
  }
  const directory = path.dirname(manifestPath);
  let stockReplayPassed: boolean | null = null;
  try {
    const verdict = StockReplaySchema.parse(
      JSON.parse(await readFile(path.join(directory, 'qualification', 'stock-replay.json'), 'utf8')),
    );
    stockReplayPassed = verdict.passed;
  } catch {
    // Absent or unreadable: unknown, which is not the same as failed.
    stockReplayPassed = null;
  }
  return {
    sceneId: parsed.sceneId ?? path.basename(directory),
    bundleDir: directory,
    digest: createHash('sha256').update(bytes).digest('hex'),
    qualified: parsed.validity.qualified,
    envelope: parsed.validity.envelope,
    envelopeBasis: parsed.validity.envelopeBasis,
    gates: parsed.validity.gates,
    cameraIds: parsed.cameras.map((camera) => camera.cameraId).sort((a, b) => a - b),
    stockReplayPassed,
  };
}

/**
 * Refuse a model episode on a scene whose validity is not proven.
 *
 * An unqualified reconstruction cannot produce a meaningful policy score, so
 * the correct outcome is a refusal — not a low score that would be read as
 * the model driving badly.
 */
export function assertModelEpisodeAdmissible(summary: ReplayContextSummary): void {
  if (!summary.qualified) {
    const failed = Object.entries(summary.gates)
      .filter(([, gate]) => !gate?.passed)
      .map(([name]) => name);
    throw new ReplayContextError(
      'replay_context_unqualified',
      `scene ${summary.sceneId} is not qualified for model episodes (failing gates: ${failed.join(', ') || 'unknown'})`,
    );
  }
  if (summary.stockReplayPassed === false) {
    throw new ReplayContextError(
      'replay_context_unqualified',
      `scene ${summary.sceneId} failed the G5 stock-replay gate; the sim/executor/scoring chain is unproven on it`,
    );
  }
}
