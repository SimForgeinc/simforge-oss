/**
 * Where a render's motion comes from, in words.
 *
 * Renders replay a revision's ORIGINAL stored simulation by default, under
 * whatever engine produced it; re-simulating under a newer engine is an
 * explicit action with a motion diff, and the legacy OpenSCENARIO replay is
 * an explicit, labelled choice for revisions that have no stored trace. These
 * helpers are the one place those states are named, so the render panel, the
 * render details and tests agree.
 */

import type {
  ScenarioMotionDiffDto,
  ScenarioMotionSource,
  ScenarioRevisionMotionDto,
} from "@simforge-oss/studio-host";

/** The recorded motion of a finished or running render job. */
export function renderMotionLabel(motion: {
  source: ScenarioMotionSource | null;
  engineSemVer: string | null;
} | null | undefined): string {
  if (!motion) return "Not recorded";
  switch (motion.source) {
    case "original":
      return motion.engineSemVer ? `Original simulation · engine ${motion.engineSemVer}` : "Original simulation";
    case "resimulated":
      return motion.engineSemVer ? `Re-simulated · engine ${motion.engineSemVer}` : "Re-simulated";
    case "original-xosc":
      return "Original motion · legacy OpenSCENARIO replay";
    default:
      // Jobs from before motion sources were recorded: they re-simulated at submission.
      return motion.engineSemVer ? `Simulated at submission · engine ${motion.engineSemVer}` : "Not recorded";
  }
}

export type RevisionMotionPlan =
  | { kind: "replay-original"; engineSemVer: string; engineIsCurrent: boolean; resimulateLabel: string | null }
  | { kind: "replay-active"; engineSemVer: string; engineIsCurrent: boolean; resimulateLabel: string | null; note: string }
  | { kind: "original-missing"; message: string; resimulateLabel: string; legacyXoscAvailable: boolean };

/** What a render of this revision will replay, before it is submitted. */
export function revisionMotionPlan(motion: ScenarioRevisionMotionDto): RevisionMotionPlan {
  const current = motion.currentEngineSemVer;
  const resimulateLabel = `Re-simulate on engine ${current}`;
  if (!motion.active) {
    return {
      kind: "original-missing",
      message: motion.legacyXoscAvailable
        ? "This version has no stored simulation. Its original motion survives only as its OpenSCENARIO export."
        : "This version has no stored simulation and no OpenSCENARIO export: its original motion is lost.",
      resimulateLabel,
      legacyXoscAvailable: motion.legacyXoscAvailable,
    };
  }
  const engineIsCurrent = motion.active.engineSemVer === current;
  const offerResimulate = engineIsCurrent ? null : resimulateLabel;
  if (motion.active.original) {
    return { kind: "replay-original", engineSemVer: motion.active.engineSemVer, engineIsCurrent, resimulateLabel: offerResimulate };
  }
  return {
    kind: "replay-active",
    engineSemVer: motion.active.engineSemVer,
    engineIsCurrent,
    resimulateLabel: offerResimulate,
    note: motion.active.reason === "backfill-resimulated"
      ? "Its original simulation was not kept; this is a later re-simulation."
      : "A re-simulation was chosen as this version's motion.",
  };
}

function metres(value: number): string {
  return value >= 1 ? `${value.toFixed(2)} m` : `${Math.round(value * 1000)} mm`;
}

/** One line summarizing what a re-simulation changed. */
export function motionDiffSummary(diff: ScenarioMotionDiffDto): string {
  const engines = diff.base.engineSemVer === diff.candidate.engineSemVer
    ? `engine ${diff.candidate.engineSemVer}`
    : `engine ${diff.base.engineSemVer} → ${diff.candidate.engineSemVer}`;
  if (diff.identical) return `Motion identical (${engines}).`;
  const parts: string[] = [];
  if (diff.actorsChanged.length > 0) {
    parts.push(`${diff.actorsChanged.length} actor${diff.actorsChanged.length === 1 ? "" : "s"} moved (max ${metres(diff.maxPositionDeltaM)}, ${diff.maxHeadingDeltaDeg.toFixed(2)}°)`);
  }
  if (diff.firstDivergenceS !== null) parts.push(`from t = ${diff.firstDivergenceS.toFixed(2)} s`);
  if (diff.actorsOnlyInBase.length > 0) parts.push(`${diff.actorsOnlyInBase.length} actor(s) gone`);
  if (diff.actorsOnlyInCandidate.length > 0) parts.push(`${diff.actorsOnlyInCandidate.length} new actor(s)`);
  if (diff.unmatchedTicks > 0) parts.push(`${diff.unmatchedTicks} tick(s) only in one run`);
  return `Motion changed (${engines}): ${parts.join(", ")}.`;
}
