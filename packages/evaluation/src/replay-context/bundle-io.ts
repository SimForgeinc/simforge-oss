/**
 * Reading and writing `simforge.replay-context/v1` bundles.
 *
 * A bundle's `validity` block is written by measurement (the qualification gates), never by
 * assertion, and everything downstream treats the file as authoritative, so it is validated on
 * the way in and on the way out. Producing and qualifying bundles (importers, reconstruction,
 * render probes) belongs to the scene provider that owns the renderer; this module only
 * defines the document and moves it to and from disk.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { type PoseSample } from './envelope.js';
import { formatFieldPath } from './refusal.js';
import {
  REPLAY_CONTEXT_FILENAME,
  REPLAY_CONTEXT_SCHEMA,
  ReplayContextSchema,
  STOCK_REPLAY_VERDICT_PATH,
  type GateVerdict,
  type ReplayContext,
} from './schema.js';

/**
 * Why a bundle could not be loaded.
 *
 * The two cases are settled differently by the compute control plane — a bundle that is not
 * there and a bundle that is malformed are both the customer's input, but only one of them is
 * worth telling them which field to fix — so they are distinct codes rather than one error.
 */
export type ReplayContextLoadFailure = {
  readonly ok: false;
  readonly code: 'replay_context_missing' | 'replay_context_invalid';
  readonly message: string;
  /** Dotted field paths, so a portal message can name what to fix rather than saying "invalid". */
  readonly fields: readonly string[];
};

export type ReplayContextLoadResult =
  | { readonly ok: true; readonly bundle: ReplayContext }
  | ReplayContextLoadFailure;

/**
 * Read a bundle, reporting failure as a value.
 *
 * Preferred over {@link loadReplayContext} wherever the bundle is customer data: the caller
 * gets the offending field paths and can settle the attempt against the right cause, instead
 * of flattening a schema error into a string that says nothing actionable.
 */
export async function tryLoadReplayContext(target: string): Promise<ReplayContextLoadResult> {
  const file = target.endsWith('.json') ? target : path.join(target, REPLAY_CONTEXT_FILENAME);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      ok: false,
      // Unparseable JSON is a malformed document, not an absent one; only a genuinely absent
      // file is reported as missing, because the two lead to different user instructions.
      code: missing ? 'replay_context_missing' : 'replay_context_invalid',
      message: missing
        ? `${file} does not exist; a replay-context bundle is a directory containing ${REPLAY_CONTEXT_FILENAME}`
        : `${file} could not be read as JSON: ${(error as Error).message}`,
      fields: [],
    };
  }
  const parsed = ReplayContextSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'replay_context_invalid',
      message: `${file} is not a valid ${REPLAY_CONTEXT_SCHEMA} document`,
      fields: parsed.error.issues.map((issue) => formatFieldPath(issue.path) || '<document root>'),
    };
  }
  return { ok: true, bundle: parsed.data };
}

/**
 * Read a bundle, throwing on failure.
 *
 * Kept for callers where an unreadable bundle is a programming or configuration error rather
 * than customer input. The thrown message carries the same field detail.
 */
export async function loadReplayContext(target: string): Promise<ReplayContext> {
  const result = await tryLoadReplayContext(target);
  if (result.ok) return result.bundle;
  const detail = result.fields.length === 0 ? '' : `: ${result.fields.join(', ')}`;
  throw new Error(`${result.message}${detail}`);
}

/**
 * Write a bundle to its directory.
 *
 * Validated on the way out as well as the way in: a bundle whose validity block contradicts
 * its gates (qualified with a failing gate, or with gates missing) must never reach disk,
 * because everything downstream treats the file as authoritative.
 */
export async function writeReplayContext(bundleDir: string, bundle: ReplayContext): Promise<string> {
  const validated = ReplayContextSchema.parse(bundle);
  await mkdir(bundleDir, { recursive: true });
  const file = path.join(bundleDir, REPLAY_CONTEXT_FILENAME);
  await writeFile(file, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
  return file;
}

/** Persist the G5 verdict where the campaign runner looks for it before a model episode. */
export async function writeStockReplayVerdict(bundleDir: string, verdict: GateVerdict): Promise<string> {
  const file = path.join(bundleDir, STOCK_REPLAY_VERDICT_PATH);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8');
  return file;
}

export interface StockReplayInput {
  /** Ego poses the sim actually produced with the policy pinned to the recorded trajectory. */
  readonly replayed: readonly PoseSample[];
  /** Infractions the episode scored. A stock replay that infracts disqualifies the scene. */
  readonly infractions: number;
  readonly traceRef?: string;
}
