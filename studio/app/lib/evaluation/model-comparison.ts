/**
 * When two closed-loop runs may be compared, which metrics may be RANKED, and
 * what a rank does and does not claim.
 *
 * The rule lives here rather than in the page because it is the substance of a
 * comparison: a table that orders two columns by a number has asserted the
 * difference is attributable to the model, and that is only true when
 * everything else about the two runs was held. One testable place decides it so
 * a component cannot quietly widen it.
 *
 * FOUR VERDICTS. Only `matched` is orderable, and even then the ordering is
 * "these two runs, on this scenario set, under this rig and runtime" — never a
 * causal claim about the models in general. Nothing in this module emits the
 * word "better".
 *
 * - `matched` — same scenario INPUT DIGEST, same seed and policy seed, same rig
 *   (profile id AND its version/hash AND resolution, intrinsics, extrinsics,
 *   cadence and history depth), same quant and checkpoint digest, same runtime.
 *   Camera ids alone are NOT sufficient: two rigs can feed slots [0,1,2,6] at
 *   different resolutions or with different extrinsics and produce different
 *   observations.
 * - `sensor-different` — same scenario and seed, different rig. Metrics are
 *   still shown, badged, because "A scored 0.71 with four cameras and B scored
 *   0.64 with two" is worth reading; it is not a ranking.
 * - `runtime-different` — same rig, different quant, checkpoint digest, engine
 *   build, addon or cadence. NF4 against BF16 is a quantization measurement,
 *   not a model comparison.
 * - `incomparable` — different scenario input or seed, or one side missing.
 *
 * PER-METRIC AVAILABILITY. A run does not have one availability, it has one per
 * metric: a scene with no speed-limit authority reports driving score and
 * off-road and reports speeding as unavailable. So a metric is ranked over the
 * columns that DEFINE it and shown as unavailable in the columns that do not.
 * Nothing is imputed as zero — a missing component is not a bad score.
 */

/** A rig, to the depth that decides whether two runs saw the same world. */
export type ComparisonRig = {
  /** Human-facing preset name, e.g. `alpamayo-4cam`. */
  readonly profile: string | null;
  /**
   * `modelRigProfileVersion(family)`, e.g. `alpamayo-1@ea8ec92ae4ae`: a digest
   * over the model's camera order and input cadence TOGETHER with the rig's
   * resolved sensor geometry. Equal implies an identical rig; unequal is at
   * least sensor-different even when the profile NAME matches, which is the
   * cheap exact test the long field list below cannot give on its own.
   */
  readonly profileVersion: string | null;
  readonly profileSha256: string | null;
  /** Model camera slots actually fed, sorted. */
  readonly cameraIds: readonly number[];
  readonly resolution: { readonly width: number | null; readonly height: number | null };
  /** Digest over the per-camera intrinsics the run rendered with. */
  readonly intrinsicsSha256: string | null;
  /** Digest over the per-camera mounts/extrinsics. */
  readonly extrinsicsSha256: string | null;
  /** Frames per camera the model was fed, and their spacing. */
  readonly historyFrames: number | null;
  readonly historyDtS: number | null;
  /** Camera cadence in Hz; a rig at 10 Hz is not a rig at 30 Hz. */
  readonly cadenceHz: number | null;
  /**
   * Render frame rate the clip was produced at (20, 24 or 30 today).
   *
   * Compared as part of the RIG rather than the runtime, because it decides
   * what the model saw: a 24 fps clip feeding a 10 Hz model carries up to
   * 20.8 ms of nearest-frame jitter against a 5 ms tolerance, and that lands in
   * the metric. Two runs from different render rates are not matched even when
   * every other field agrees.
   */
  readonly renderFps: number | null;
  /**
   * Whether the render cadence divided the model's input cadence exactly.
   *
   * A history resampled from 24 fps carries up to 20.8 ms of jitter against one
   * rendered at 20 or 30 fps, and that lands in the metric while every other
   * field agrees. So a jittered run is not `matched` with a clean one even when
   * the rig, quant and runtime are identical.
   */
  readonly cadenceDividesExactly: boolean | null;
  readonly worstResampleErrorS: number | null;
};

export type ComparisonRuntime = {
  readonly engineVersion: string | null;
  readonly abiVersion: number | null;
  readonly addonSha256: string | null;
  readonly decisionHz: number | null;
};

/** The identity of one closed-loop run, as its manifest recorded it. */
export type ComparisonIdentity = {
  readonly family: string | null;
  /** Human label for the family, for the summary line. */
  readonly familyLabel: string | null;
  readonly revision: string | null;
  readonly quant: string | null;
  readonly checkpointDigest: string | null;
  readonly rig: ComparisonRig;
  readonly runtime: ComparisonRuntime;
  readonly policySeed: number | null;
};

/** Why a cell cannot be ranked, in the order a reader should be told. */
export type UnrankableReason =
  | 'missing'
  | 'failed'
  | 'cancelled'
  | 'truncated'
  | 'unscored'
  | 'metric-unavailable';

export type ComparisonCellResult = {
  readonly episodeId: string | null;
  readonly status: string | null;
  readonly scored: boolean;
  readonly truncation: string | null;
  /** Metric id -> value. A metric absent here is not defined for this run. */
  readonly metrics: Readonly<Record<string, number | null>>;
  /** Metric ids the run could not assess. Never treated as zero. */
  readonly unavailable: readonly string[];
  /**
   * Why a run legitimately produced no score, when it did not fail.
   *
   * A synthetic input has no recorded future to score against, and a t0 too
   * near the end of a clip has no horizon; both are structural and must read
   * differently from a crash. Absent when the run was scored or when it failed.
   */
  readonly unscoredReason: string | null;
  /** Digest of the scenario INPUT, not its id: the same id can be re-authored. */
  readonly scenarioInputDigest: string | null;
  readonly identity: ComparisonIdentity;
};

export type ComparabilityVerdict = 'matched' | 'sensor-different' | 'runtime-different' | 'incomparable';

export type ComparabilityDetail = {
  readonly verdict: ComparabilityVerdict;
  /** Identity fields that differ, named for display. Empty for `matched`. */
  readonly differing: readonly string[];
};

const sameIds = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

function rigDifferences(a: ComparisonRig, b: ComparisonRig): string[] {
  // The profile version is a digest over camera order, input cadence and
  // resolved sensor geometry, so an inequality here settles it without needing
  // every field below to be present. The field-by-field list still runs, so a
  // reader is told WHICH part differs rather than only that something did.
  const differing: string[] =
    a.profileVersion !== null && b.profileVersion !== null && a.profileVersion !== b.profileVersion
      ? ['rig.profileVersion']
      : [];
  if ((a.profile ?? null) !== (b.profile ?? null)) differing.push('rig.profile');
  if (!differing.includes('rig.profileVersion') && (a.profileVersion ?? null) !== (b.profileVersion ?? null)) {
    differing.push('rig.profileVersion');
  }
  if ((a.profileSha256 ?? null) !== (b.profileSha256 ?? null)) differing.push('rig.profileSha256');
  if (!sameIds(a.cameraIds, b.cameraIds)) differing.push('rig.cameraIds');
  if (a.resolution.width !== b.resolution.width || a.resolution.height !== b.resolution.height) {
    differing.push('rig.resolution');
  }
  if ((a.intrinsicsSha256 ?? null) !== (b.intrinsicsSha256 ?? null)) differing.push('rig.intrinsics');
  if ((a.extrinsicsSha256 ?? null) !== (b.extrinsicsSha256 ?? null)) differing.push('rig.extrinsics');
  if ((a.historyFrames ?? null) !== (b.historyFrames ?? null)) differing.push('rig.historyFrames');
  if ((a.historyDtS ?? null) !== (b.historyDtS ?? null)) differing.push('rig.historyDtS');
  if ((a.cadenceHz ?? null) !== (b.cadenceHz ?? null)) differing.push('rig.cadenceHz');
  if ((a.renderFps ?? null) !== (b.renderFps ?? null)) differing.push('rig.renderFps');
  if ((a.cadenceDividesExactly ?? null) !== (b.cadenceDividesExactly ?? null)) {
    differing.push('rig.cadenceDividesExactly');
  }
  // The jitter magnitude itself, not only the boolean: two runs both flagged
  // inexact can still differ in how badly, and the worse one is not
  // interchangeable with the better.
  if ((a.worstResampleErrorS ?? null) !== (b.worstResampleErrorS ?? null)) {
    differing.push('rig.worstResampleErrorS');
  }
  return differing;
}

/**
 * Compare two cells.
 *
 * `null` on either side is `incomparable`: a comparison needs two runs, and a
 * one-sided row is a gap in the grid rather than a result.
 */
export function comparability(
  a: ComparisonCellResult | null,
  b: ComparisonCellResult | null,
): ComparabilityDetail {
  if (!a || !b || !a.episodeId || !b.episodeId) {
    return { verdict: 'incomparable', differing: ['episode'] };
  }
  // The scenario INPUT, not its label: a re-authored fixture keeps its id.
  if (
    a.scenarioInputDigest !== null &&
    b.scenarioInputDigest !== null &&
    a.scenarioInputDigest !== b.scenarioInputDigest
  ) {
    return { verdict: 'incomparable', differing: ['scenarioInputDigest'] };
  }
  if ((a.identity.policySeed ?? null) !== (b.identity.policySeed ?? null)) {
    return { verdict: 'runtime-different', differing: ['policySeed'] };
  }

  const sensor = rigDifferences(a.identity.rig, b.identity.rig);
  const runtime: string[] = [];
  if ((a.identity.quant ?? null) !== (b.identity.quant ?? null)) runtime.push('quant');
  if ((a.identity.checkpointDigest ?? null) !== (b.identity.checkpointDigest ?? null)) {
    // Same revision with a different checkpoint digest is a different set of
    // weights, whatever the label says.
    runtime.push('checkpointDigest');
  }
  if ((a.identity.runtime.engineVersion ?? null) !== (b.identity.runtime.engineVersion ?? null)) {
    runtime.push('engineVersion');
  }
  if ((a.identity.runtime.abiVersion ?? null) !== (b.identity.runtime.abiVersion ?? null)) {
    runtime.push('abiVersion');
  }
  if ((a.identity.runtime.addonSha256 ?? null) !== (b.identity.runtime.addonSha256 ?? null)) {
    runtime.push('addonSha256');
  }
  if ((a.identity.runtime.decisionHz ?? null) !== (b.identity.runtime.decisionHz ?? null)) {
    runtime.push('decisionHz');
  }

  // Sensors first: a rig difference is the one a reader is most likely to
  // mistake for a model difference, so it is never hidden behind a runtime note.
  if (sensor.length > 0) return { verdict: 'sensor-different', differing: [...sensor, ...runtime] };
  if (runtime.length > 0) return { verdict: 'runtime-different', differing: runtime };
  // Two columns of the SAME model differ in nothing at all; that is a repeat,
  // and it is matched — a repeat is exactly the control a reader may want.
  return { verdict: 'matched', differing: [] };
}

/** Whether this cell produced a result at all, and if not, why. */
export function cellUnrankable(cell: ComparisonCellResult | null): UnrankableReason | null {
  if (!cell || !cell.episodeId) return 'missing';
  if (cell.status === 'failed') return 'failed';
  if (cell.status === 'cancelled') return 'cancelled';
  if (cell.truncation !== null) return 'truncated';
  if (!cell.scored) return 'unscored';
  return null;
}

/** Whether this cell defines `metricId`, and if not, why. */
export function metricUnrankable(
  cell: ComparisonCellResult | null,
  metricId: string,
): UnrankableReason | null {
  const base = cellUnrankable(cell);
  if (base !== null) return base;
  if (!cell) return 'missing';
  if (cell.unavailable.includes(metricId)) return 'metric-unavailable';
  const value = cell.metrics[metricId];
  return typeof value === 'number' && Number.isFinite(value) ? null : 'metric-unavailable';
}

export type ComparisonRow = {
  readonly scenarioId: string;
  readonly seed: number;
  readonly cells: readonly (ComparisonCellResult | null)[];
};

export type MetricRanking = {
  readonly metricId: string;
  /** Per column: the mean over rows this metric is defined and matched in. */
  readonly columns: readonly {
    readonly columnIndex: number;
    readonly mean: number | null;
    readonly rows: number;
  }[];
  /** Rows excluded from every column's mean, with the reason. */
  readonly excluded: readonly {
    readonly scenarioId: string;
    readonly seed: number;
    readonly reason: UnrankableReason | ComparabilityVerdict;
  }[];
  /**
   * True only when every counted row was `matched` across all columns. False
   * means the numbers are comparable READINGS but not an ordering, and the page
   * must say so rather than sorting them.
   */
  readonly orderable: boolean;
};

/**
 * Rank one metric across columns over the rows where it is defined everywhere
 * and every column is `matched` against the baseline (column 0).
 *
 * A mean taken over a different subset per column is not a comparison, it is
 * several measurements printed next to each other — so a row is counted only
 * when EVERY column defines the metric there. `mean` is null for a column with
 * no such rows, which a reader must be able to tell from a genuine zero.
 */
export function rankMetric(
  rows: readonly ComparisonRow[],
  columnCount: number,
  metricId: string,
): MetricRanking {
  const excluded: MetricRanking['excluded'][number][] = [];
  const totals = Array.from({ length: columnCount }, () => ({ sum: 0, rows: 0 }));
  let orderable = true;

  for (const row of rows) {
    let reason: UnrankableReason | ComparabilityVerdict | null = null;
    for (let index = 0; index < columnCount && reason === null; index += 1) {
      reason = metricUnrankable(row.cells[index] ?? null, metricId);
    }
    if (reason === null) {
      for (let index = 1; index < columnCount && reason === null; index += 1) {
        const detail = comparability(row.cells[0] ?? null, row.cells[index] ?? null);
        if (detail.verdict !== 'matched') reason = detail.verdict;
      }
    }
    if (reason !== null) {
      excluded.push({ scenarioId: row.scenarioId, seed: row.seed, reason });
      if (reason === 'sensor-different' || reason === 'runtime-different') orderable = false;
      continue;
    }
    for (let index = 0; index < columnCount; index += 1) {
      const value = row.cells[index]?.metrics[metricId];
      if (typeof value !== 'number') continue;
      totals[index]!.sum += value;
      totals[index]!.rows += 1;
    }
  }

  const columns = totals.map((total, columnIndex) => ({
    columnIndex,
    mean: total.rows === 0 ? null : total.sum / total.rows,
    rows: total.rows,
  }));
  return {
    metricId,
    columns,
    excluded,
    orderable: orderable && columns.some((column) => column.rows > 0),
  };
}
