/**
 * The record of a launched comparison.
 *
 * A comparison started from the launcher is not derivable from the campaign
 * ledger alone: the ledger knows which episodes ran, but not that THESE runs
 * were submitted together as columns of one question, nor which requested
 * columns were refused and why. That is what this file holds — beside the run
 * artifacts, under the same runs root, so it travels with the evidence and
 * needs no schema owned by another workstream.
 *
 * What it deliberately records:
 *
 * - The identity each column was submitted with (family, revision, quant,
 *   checkpoint digest, rig profile) as a FACT of the submission. Scoring still
 *   reads identity from each run's own provenance — that is the authority — but
 *   a column whose runs never produced provenance can still say what it asked
 *   for, which is the difference between "pending" and "unknown".
 * - Refused columns, as refusals. A refused column has no runs and no metrics
 *   and is never rendered as a column of the table; it is a reason a person
 *   asked for something that could not execute.
 * - Retries and failures per run id, so a column that partly failed reads as
 *   partly failed instead of quietly averaging the survivors.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { runsRoot } from './ledger';

export const COMPARISON_SCHEMA = 'simforge.eval-comparison/v1';

export type ComparisonRecordColumn = {
  readonly label: string;
  readonly target: 'local' | 'cloud';
  readonly modelVersionId: string;
  readonly identity: {
    readonly family: string;
    readonly revision: string | null;
    readonly quant: string;
    readonly checkpointDigest: string | null;
    readonly rigProfile: string;
  };
  /** Run/job ids in seed order; the comparison follows these to artifacts. */
  readonly runIds: readonly string[];
};

export type ComparisonRecordRefusal = {
  readonly modelVersionId: string;
  readonly target: 'local' | 'cloud';
  readonly code: string;
  readonly reason: string;
};

export type ComparisonRecord = {
  readonly schema: typeof COMPARISON_SCHEMA;
  readonly comparisonId: string;
  readonly campaignId: string;
  readonly kind: 'closedloop-episode' | 'openloop';
  readonly createdAt: string;
  /** Shared across every column: the control the comparison rests on. */
  readonly shared: {
    readonly spec: string;
    readonly seeds: readonly number[];
    readonly steps: number;
    readonly decisionHz: number;
    readonly mode: 'offline-simtime' | 'realtime';
    readonly deadlineMs: number | null;
    readonly frameSource: string | null;
    /** Artifact ids by role for cloud columns; empty for a local comparison. */
    readonly cloudInputs: readonly { readonly role: string; readonly artifactId: string }[];
  };
  readonly columns: readonly ComparisonRecordColumn[];
  readonly refused: readonly ComparisonRecordRefusal[];
};

function comparisonPath(comparisonId: string): string {
  return join(runsRoot(), 'comparisons', `${comparisonId}.json`);
}

/** Reject a path-shaped id before it is joined into the runs root. */
export function isSafeComparisonId(comparisonId: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/.test(comparisonId) && !comparisonId.startsWith('.');
}

export async function writeComparison(record: ComparisonRecord): Promise<void> {
  if (!isSafeComparisonId(record.comparisonId)) {
    throw new Error(`unsafe comparison id: ${record.comparisonId}`);
  }
  const path = comparisonPath(record.comparisonId);
  await mkdir(join(runsRoot(), 'comparisons'), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

export async function readComparison(comparisonId: string): Promise<ComparisonRecord | null> {
  if (!isSafeComparisonId(comparisonId)) return null;
  let raw: string;
  try {
    raw = await readFile(comparisonPath(comparisonId), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as ComparisonRecord;
    return parsed.schema === COMPARISON_SCHEMA ? parsed : null;
  } catch {
    return null;
  }
}

/** Comparisons recorded for one campaign, newest first. */
export async function listComparisons(campaignId: string): Promise<readonly ComparisonRecord[]> {
  let names: string[];
  try {
    names = await readdir(join(runsRoot(), 'comparisons'));
  } catch {
    return [];
  }
  const records: ComparisonRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const record = await readComparison(name.slice(0, -'.json'.length));
    if (record && record.campaignId === campaignId) records.push(record);
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
