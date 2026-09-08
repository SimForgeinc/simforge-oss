/**
 * Validity gates G1–G5: what must be measured before a reconstructed or imported scene may
 * carry a policy.
 *
 * Each gate is a pure function from a measurement to a verdict, so the thresholds are
 * auditable and a gate report can be recomputed from stored measurements without a GPU.
 * Measurement itself lives in `render.ts` (pixels) and `envelope.ts` (trajectories).
 *
 * ## Where the numbers come from
 *
 * Thresholds are admission floors, chosen before any result was produced, and each carries
 * its rationale in the verdict so a reader never has to trust an unexplained constant.
 *
 * - **G1 / G2 (pixels).** This repository had no prior image-fidelity convention, so these
 *   are justified from what the measurement means rather than copied. A render at a
 *   *recorded* pose is essentially a training view of the reconstruction, so it should be
 *   comfortably better than the novel-view numbers 3DGS/3DGUT-class methods report on
 *   outdoor scenes; 22 dB PSNR with 0.75 SSIM is a floor that a visibly broken or
 *   mis-posed reconstruction fails while a legitimately hard capture (night, low light —
 *   the AV sample scenes include both) still passes. G2 measures *newly unsupported*
 *   pixels against the on-trajectory baseline for the same camera, so a scene that is
 *   uniformly dim is not punished twice; 2% is the point at which unobserved surface
 *   becomes a visible hole rather than an edge artefact.
 *   These two are explicitly provisional in the sense the plan requires: the reconstruction
 *   path stays beta until three distinct sequences have passed, and the measured
 *   distribution across those sequences is what tightens them. They are not moved to fit a
 *   result that has already been produced.
 * - **G3 (ego-history parity).** A numerical, not physical, tolerance: the bundle re-derives
 *   the same 16-step history from the same poses, so any disagreement beyond frame/unit
 *   conversion noise is a bug. 1 cm / 1 mrad.
 * - **G4 (dynamics usability).** Recorded actors are replayed by interpolating their
 *   trajectories at the render instant, so the gate bounds the coarsest sampling interval
 *   rather than any clock coincidence: interpolation error for a turning vehicle goes as
 *   v·Δt²·ω/8, which at 15 m/s and 0.3 rad/s is ~2 cm at 200 ms and ~14 cm at 500 ms, so
 *   200 ms (two decision periods) keeps a replayed actor's pose well inside its own footprint
 *   between samples. Recorded actors intersecting the recorded ego path is a hard zero — it
 *   means tracks and ego are not in the same frame or clock — as is a published camera
 *   reference instant outside the recorded window.
 * - **G5 (stock replay).** Bounds taken from this repository's own conventions:
 *   `docs/policy-step.md` bounds the pure-pursuit executor at p95 cross-track ≤ 0.35 m
 *   (measured there: p50 0.14, p95 0.24, max 0.29), and the NuRec importer's own accepted
 *   report records ego open-loop replay at p95 0.0039 m / max 0.163 m. G5 replays the
 *   *recorded* trajectory through the full sim/executor/scoring chain, so it must land
 *   inside the executor's own bound: max ≤ 0.35 m, p95 ≤ 0.10 m, and zero infractions. A
 *   G5 failure indicts our chain, never the model — no model is involved.
 */

import type { Envelope, GateId, GateVerdict } from './schema.js';

export interface GateThresholds {
  /** G1: minimum mean PSNR (dB) of re-rendered vs recorded frames at recorded poses. */
  readonly onTrajectoryPsnrDb: number;
  /** G1: minimum mean SSIM over the same frames. */
  readonly onTrajectorySsim: number;
  /** G2: maximum fraction of newly unsupported pixels at an offset pose, vs the on-trajectory baseline. */
  readonly offTrajectoryHoleFraction: number;
  /** G3: maximum position disagreement (m) in the re-derived ego history. */
  readonly egoHistoryPositionM: number;
  /** G3: maximum heading disagreement (rad) in the re-derived ego history. */
  readonly egoHistoryHeadingRad: number;
  /** G4: coarsest allowed actor-track sampling interval (µs). */
  readonly trackSampleGapUs: number;
  /** G5: maximum lateral deviation (m) when replaying the recorded trajectory. */
  readonly stockReplayMaxLateralM: number;
  /** G5: p95 lateral deviation (m) for the same replay. */
  readonly stockReplayP95LateralM: number;
}

/** Documented defaults; see the module docstring for the justification of each. */
export const DEFAULT_GATE_THRESHOLDS: GateThresholds = {
  onTrajectoryPsnrDb: 22,
  onTrajectorySsim: 0.75,
  offTrajectoryHoleFraction: 0.02,
  egoHistoryPositionM: 0.01,
  egoHistoryHeadingRad: 0.001,
  trackSampleGapUs: 200_000,
  stockReplayMaxLateralM: 0.35,
  stockReplayP95LateralM: 0.10,
};

/** Lateral offsets (m) probed by G2. The largest passing one becomes the envelope. */
export const DEFAULT_OFFSETS_M: readonly number[] = [0.5, 1.0, 1.5];
/** Heading offsets (rad) probed by G2 — ±5°. */
export const DEFAULT_HEADINGS_RAD: readonly number[] = [(5 * Math.PI) / 180];

const RATIONALE: Record<GateId, string> = {
  G1: 'Renders at recorded poses are near-training views of the reconstruction; below 22 dB PSNR / 0.75 SSIM the scene is visibly wrong or mis-posed. Provisional floor, tightened from the measured distribution once three sequences have passed.',
  G2: 'Measures pixels that become unsupported when the camera moves off the recorded path, relative to the on-trajectory baseline for the same camera. Above 2% the renderer is showing unobserved surface as a hole rather than an edge artefact, so the render is no longer evidence about the world.',
  G3: 'The bundle re-derives the 16-step ego history from the same recorded poses, so disagreement beyond unit/frame conversion noise (1 cm, 1 mrad) is a defect in the derivation, not a property of the scene.',
  G4: 'Replayed actors are interpolated at the render instant, so their sampling interval must stay within two decision periods (200 ms) for the interpolated pose to be faithful; recorded actors must not intersect the recorded ego path, and published camera reference instants must fall inside the recorded window.',
  G5: 'Replaying the recorded trajectory through the full sim/executor/scoring chain must stay inside the pure-pursuit executor bound documented in docs/policy-step.md (p95 cross-track <= 0.35 m; measured p50 0.14 / p95 0.24 / max 0.29) and produce no infraction. This qualifies our chain, not a model.',
};

function verdict(
  id: GateId,
  name: string,
  measured: number,
  threshold: number,
  direction: 'at-least' | 'at-most',
  unit: string,
  detail?: Record<string, unknown>,
): GateVerdict {
  const passed = direction === 'at-least' ? measured >= threshold : measured <= threshold;
  return {
    id,
    name,
    passed,
    measured,
    threshold,
    direction,
    unit,
    rationale: RATIONALE[id],
    ...(detail === undefined ? {} : { detail }),
  };
}

/* ------------------------------------------------------------------ G1 / G2 */

/** Per-camera pixel comparison of a render at a recorded pose against the recorded frame. */
export interface FrameFidelity {
  readonly sensorId: string;
  readonly cameraId: number;
  readonly frames: number;
  readonly psnrDb: number;
  readonly ssim: number;
}

/**
 * G1 — on-trajectory re-render fidelity.
 *
 * The gate is the *worst* camera, not the mean over cameras: a rig whose front-wide view is
 * excellent and whose cross-left view is broken cannot serve a four-camera model, and
 * averaging would hide exactly that.
 */
export function gateG1(
  perCamera: readonly FrameFidelity[],
  thresholds: GateThresholds = DEFAULT_GATE_THRESHOLDS,
): GateVerdict {
  if (perCamera.length === 0) {
    return verdict('G1', 'On-trajectory re-render fidelity', 0, thresholds.onTrajectoryPsnrDb, 'at-least', 'dB', {
      reason: 'no cameras were measured',
    });
  }
  const worst = perCamera.reduce((a, b) => (a.psnrDb <= b.psnrDb ? a : b));
  const worstSsim = perCamera.reduce((a, b) => (a.ssim <= b.ssim ? a : b));
  const base = verdict('G1', 'On-trajectory re-render fidelity', worst.psnrDb, thresholds.onTrajectoryPsnrDb, 'at-least', 'dB', {
    worstCamera: worst.sensorId,
    worstPsnrDb: worst.psnrDb,
    worstSsim: worstSsim.ssim,
    ssimThreshold: thresholds.onTrajectorySsim,
    perCamera,
  });
  // SSIM is a second necessary condition on the same gate: a blurred render can hold PSNR.
  return { ...base, passed: base.passed && worstSsim.ssim >= thresholds.onTrajectorySsim };
}

/** Newly unsupported pixel fraction at one probed offset, worst camera of the rig. */
export interface OffsetCoverage {
  readonly lateralM: number;
  readonly headingRad: number;
  readonly holeFraction: number;
  readonly worstCamera: string;
}

export interface G2Result {
  readonly gate: GateVerdict;
  readonly envelope: Envelope;
  readonly basis: {
    readonly offsetsTestedM: readonly number[];
    readonly headingsTestedRad: readonly number[];
    readonly largestPassingLateralM: number;
    readonly largestPassingHeadingRad: number;
  };
}

/**
 * G2 — off-trajectory coverage, and the envelope it defines.
 *
 * The envelope is the largest probed offset that passed *with every smaller offset also
 * passing*: a scene that fails at 0.5 m but passes at 1.0 m is incoherent, and taking the
 * larger number would licence exactly the renders we could not trust. Failing the smallest
 * probe yields a zero-width envelope, which is a valid on-trajectory-replay-only scene, not
 * an error.
 *
 * `longitudinalS` is carried through from the caller's probe plan rather than measured
 * here: longitudinal freedom is bounded by the recorded actors' time support (G4), not by
 * pixel coverage.
 */
export function gateG2(
  coverage: readonly OffsetCoverage[],
  longitudinalS: number,
  thresholds: GateThresholds = DEFAULT_GATE_THRESHOLDS,
): G2Result {
  const lateralProbes = [...coverage].sort((a, b) => a.lateralM - b.lateralM);
  let largestLateral = 0;
  for (const probe of lateralProbes) {
    if (probe.lateralM === 0) continue;
    if (probe.holeFraction > thresholds.offTrajectoryHoleFraction) break;
    largestLateral = probe.lateralM;
  }
  const headingProbes = [...coverage].sort((a, b) => a.headingRad - b.headingRad);
  let largestHeading = 0;
  for (const probe of headingProbes) {
    if (probe.headingRad === 0) continue;
    if (probe.holeFraction > thresholds.offTrajectoryHoleFraction) break;
    largestHeading = probe.headingRad;
  }
  const worst = coverage.length === 0 ? 1 : Math.max(...coverage.map((probe) => probe.holeFraction));
  const gate = verdict(
    'G2',
    'Off-trajectory coverage',
    worst,
    thresholds.offTrajectoryHoleFraction,
    'at-most',
    'fraction of pixels',
    { probes: coverage, largestPassingLateralM: largestLateral, largestPassingHeadingRad: largestHeading },
  );
  return {
    // The gate passes when the smallest probe held, i.e. the scene supports *some* deviation.
    gate: { ...gate, passed: largestLateral > 0 },
    envelope: { lateralM: largestLateral, longitudinalS, headingRad: largestHeading },
    basis: {
      offsetsTestedM: lateralProbes.map((probe) => probe.lateralM),
      headingsTestedRad: headingProbes.map((probe) => probe.headingRad),
      largestPassingLateralM: largestLateral,
      largestPassingHeadingRad: largestHeading,
    },
  };
}

/* ----------------------------------------------------------------- G3 / G4 */

export interface EgoHistoryParity {
  readonly maxPositionErrorM: number;
  readonly maxHeadingErrorRad: number;
  readonly samplesCompared: number;
}

/** G3 — the derived 16-step ego history reproduces the recorded poses. */
export function gateG3(parity: EgoHistoryParity, thresholds: GateThresholds = DEFAULT_GATE_THRESHOLDS): GateVerdict {
  const base = verdict('G3', 'Ego-history parity', parity.maxPositionErrorM, thresholds.egoHistoryPositionM, 'at-most', 'm', {
    maxHeadingErrorRad: parity.maxHeadingErrorRad,
    headingThresholdRad: thresholds.egoHistoryHeadingRad,
    samplesCompared: parity.samplesCompared,
  });
  return {
    ...base,
    passed: base.passed && parity.maxHeadingErrorRad <= thresholds.egoHistoryHeadingRad && parity.samplesCompared > 0,
  };
}

export interface DynamicsConsistency {
  /** Coarsest sampling interval found in any recorded track. */
  readonly maxTrackSampleGapUs: number;
  readonly egoPathIntersections: number;
  readonly tracksChecked: number;
  /** Published camera reference instants that fall outside the recorded window. */
  readonly framesOutsideWindow: number;
}

/** G4 — actor tracks are time-aligned with the cameras and consistent with the recorded ego path. */
export function gateG4(consistency: DynamicsConsistency, thresholds: GateThresholds = DEFAULT_GATE_THRESHOLDS): GateVerdict {
  const base = verdict('G4', 'Dynamics consistency', consistency.maxTrackSampleGapUs, thresholds.trackSampleGapUs, 'at-most', 'µs', {
    egoPathIntersections: consistency.egoPathIntersections,
    tracksChecked: consistency.tracksChecked,
    framesOutsideWindow: consistency.framesOutsideWindow,
  });
  return {
    ...base,
    passed: base.passed && consistency.egoPathIntersections === 0 && consistency.framesOutsideWindow === 0,
  };
}

/* ----------------------------------------------------------------------- G5 */

export interface StockReplayMeasurement {
  readonly maxLateralM: number;
  readonly p95LateralM: number;
  readonly infractions: number;
  readonly stepsCompared: number;
  /** Trace the measurement was taken from, for the persisted verdict. */
  readonly traceRef?: string;
}

/**
 * G5 — replaying the recorded trajectory reproduces it, with no infractions.
 *
 * This is the precondition for any model episode on the scene: it proves the
 * sim/executor/scoring chain on this specific world before a policy is allowed to be blamed
 * for anything.
 */
export function gateG5(
  measurement: StockReplayMeasurement,
  thresholds: GateThresholds = DEFAULT_GATE_THRESHOLDS,
): GateVerdict {
  const base = verdict('G5', 'Stock replay', measurement.maxLateralM, thresholds.stockReplayMaxLateralM, 'at-most', 'm', {
    p95LateralM: measurement.p95LateralM,
    p95ThresholdM: thresholds.stockReplayP95LateralM,
    infractions: measurement.infractions,
    stepsCompared: measurement.stepsCompared,
    ...(measurement.traceRef === undefined ? {} : { traceRef: measurement.traceRef }),
  });
  return {
    ...base,
    passed:
      base.passed
      && measurement.p95LateralM <= thresholds.stockReplayP95LateralM
      && measurement.infractions === 0
      && measurement.stepsCompared > 0,
  };
}

/** True only when all five gates are present and passing. */
export function allGatesPassed(gates: Partial<Record<GateId, GateVerdict>>): boolean {
  const ids: readonly GateId[] = ['G1', 'G2', 'G3', 'G4', 'G5'];
  return ids.every((id) => gates[id]?.passed === true);
}
