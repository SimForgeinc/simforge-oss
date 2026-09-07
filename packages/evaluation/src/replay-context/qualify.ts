/**
 * Qualification: turning an imported scene into a bundle a policy is allowed to drive.
 *
 * Import produces geometry, calibration and motion. Qualification produces the *permission*:
 * the five gate verdicts and the measured envelope, written into the bundle so that every
 * later consumer — the episode runner, the results UI, the compute worker — reads the same
 * numbers rather than re-deriving them.
 *
 * The order is not arbitrary. G3/G4 are pure trajectory algebra and run at import. G1/G2 need
 * the renderer. G5 needs a completed stock-replay episode, which the campaign runner owns, so
 * it arrives here as a measurement rather than being executed by this module: qualification
 * records evidence, it does not run policies.
 *
 * `validity.qualified` is true only when all five passed. Until then the bundle is readable,
 * inspectable and open-loop usable, and closed loop must refuse it.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { allGatesPassed, type GateThresholds } from './gates.js';
import { qualifyRenders, type QualifyOptions as RenderQualifyOptions, type QualifyResult as RenderQualifyResult } from './render.js';
import { stockReplayGate, type PoseSample } from './envelope.js';
import { formatFieldPath } from './refusal.js';
import {
  GATE_REPORT_PATH,
  REPLAY_CONTEXT_FILENAME,
  REPLAY_CONTEXT_SCHEMA,
  ReplayContextSchema,
  STOCK_REPLAY_VERDICT_PATH,
  type GateId,
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

export interface QualifyBundleOptions extends Omit<RenderQualifyOptions, 'bundle'> {
  readonly bundle: ReplayContext;
  /** Where the qualified bundle and its gate report are written. */
  readonly bundleDir: string;
  /** G5 evidence. Absent means G5 is not recorded and the bundle cannot become qualified. */
  readonly stockReplay?: StockReplayInput;
  readonly thresholds?: GateThresholds;
}

export interface QualifyBundleResult {
  readonly bundle: ReplayContext;
  readonly bundleFile: string;
  readonly reportFile: string;
  readonly renders: RenderQualifyResult;
}

/**
 * Measure the pixel gates, fold in the trajectory gates already on the bundle and the stock
 * replay if one was supplied, and persist the result.
 *
 * A bundle that fails a gate is still written. The failure and its measurement are the
 * product: an unusable scene must be explainable ("G2 failed at 0.5 m with 7% newly
 * unsupported pixels"), not silently absent.
 */
export async function qualifyBundle(options: QualifyBundleOptions): Promise<QualifyBundleResult> {
  const renders = await qualifyRenders(options);
  const gates: Partial<Record<GateId, GateVerdict>> = {
    ...options.bundle.validity.gates,
    G1: renders.G1,
    G2: renders.G2.gate,
  };
  if (options.stockReplay !== undefined) {
    gates.G5 = stockReplayGate(
      options.bundle,
      options.stockReplay.replayed,
      options.stockReplay.infractions,
      options.thresholds,
    );
    if (options.stockReplay.traceRef !== undefined) {
      gates.G5 = { ...gates.G5, detail: { ...gates.G5.detail, traceRef: options.stockReplay.traceRef } };
    }
  }

  const qualified = allGatesPassed(gates) && options.bundle.source.kind !== 'synthetic-fixture';
  const bundle: ReplayContext = {
    ...options.bundle,
    validity: {
      qualified,
      // An unqualified bundle carries a zero-width envelope: a measured off-trajectory region
      // means nothing when the scene did not pass the gates that make renders trustworthy.
      envelope: qualified ? renders.G2.envelope : { lateralM: 0, longitudinalS: 0, headingRad: 0 },
      gates,
      envelopeBasis: {
        offsetsTestedM: [...renders.G2.basis.offsetsTestedM],
        headingsTestedRad: [...renders.G2.basis.headingsTestedRad],
        largestPassingLateralM: renders.G2.basis.largestPassingLateralM,
        largestPassingHeadingRad: renders.G2.basis.largestPassingHeadingRad,
      },
      measuredAt: new Date().toISOString(),
    },
  };

  const bundleFile = await writeReplayContext(options.bundleDir, bundle);
  const reportFile = path.join(options.bundleDir, GATE_REPORT_PATH);
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(
    reportFile,
    `${JSON.stringify(
      {
        schema: 'simforge.replay-context-gates/v1',
        sceneId: bundle.sceneId,
        qualified,
        envelope: bundle.validity.envelope,
        gates,
        probes: renders.probes.map((probe) => ({
          offset: probe.offset,
          dir: probe.dir,
          holeFraction: probe.measurement.holeFraction,
          perCamera: probe.measurement.perCamera,
        })),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  if (gates.G5 !== undefined) await writeStockReplayVerdict(options.bundleDir, gates.G5);
  return { bundle, bundleFile, reportFile, renders };
}
