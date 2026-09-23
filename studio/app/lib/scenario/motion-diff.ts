import type { ScenarioMotionDiffDto } from "@simforge-oss/studio-host";

/**
 * Motion diff between two stored traces of one scenario (for example the
 * revision's original result and an explicit re-simulation under a newer
 * engine). It compares only what a render replays: per-actor presence and
 * world pose (x, y, heading) at matching tick times. Every released trace
 * format stores those channels the same way; legacy scene-frame documents
 * (`z = -y`) are read back into xodr-local.
 *
 * Tolerances match the render parity gate: 1 mm and 0.05°.
 */

export const MOTION_DIFF_SCHEMA = "simforge.motion-diff/v1" as const;
export const MOTION_DIFF_TOLERANCE = { positionM: 1e-3, headingDeg: 0.05 } as const;

type Track = { present: number[]; x: number[]; y: number[]; headingRad: number[] };
type TraceLike = { header?: { frame?: string }; ticks: { t: number[]; actors: Record<string, Record<string, unknown>> } };

function tracks(trace: TraceLike): Map<string, Track> {
  const scene = trace.header?.frame === "scene";
  const out = new Map<string, Track>();
  for (const [id, raw] of Object.entries(trace.ticks.actors)) {
    const track = raw as { present: number[]; x: number[]; y?: number[]; z?: number[]; headingRad: number[] };
    const y = scene ? (track.z ?? []).map((z) => -z) : track.y;
    if (!Array.isArray(track.x) || !Array.isArray(y) || !Array.isArray(track.headingRad) || !Array.isArray(track.present)) {
      throw new Error(`motion_diff_track_invalid: actor ${id} has no pose channels`);
    }
    out.set(id, { present: track.present, x: track.x, y, headingRad: track.headingRad });
  }
  return out;
}

function tickKey(t: number): string {
  return (Math.round(t * 1e6) / 1e6).toFixed(6);
}

function wrapPi(a: number): number {
  let v = a % (2 * Math.PI);
  if (v > Math.PI) v -= 2 * Math.PI;
  if (v < -Math.PI) v += 2 * Math.PI;
  return v;
}

export function motionDiff(
  base: { trace: TraceLike; traceSha256: string; engineSemVer: string },
  candidate: { trace: TraceLike; traceSha256: string; engineSemVer: string },
): ScenarioMotionDiffDto {
  const a = tracks(base.trace);
  const b = tracks(candidate.trace);
  const bIndex = new Map(candidate.trace.ticks.t.map((t, i) => [tickKey(t), i]));
  const actorsOnlyInBase = [...a.keys()].filter((id) => !b.has(id)).sort();
  const actorsOnlyInCandidate = [...b.keys()].filter((id) => !a.has(id)).sort();
  const changed = new Set<string>();
  let comparedTicks = 0;
  let maxPositionDeltaM = 0;
  let maxHeadingDeltaDeg = 0;
  let worst: { actorId: string; t: number } | null = null;
  let firstDivergenceS: number | null = null;
  const diverge = (id: string, t: number) => {
    changed.add(id);
    if (firstDivergenceS === null || t < firstDivergenceS) firstDivergenceS = t;
  };
  let unmatchedTicks = 0;
  base.trace.ticks.t.forEach((t, i) => {
    const j = bIndex.get(tickKey(t));
    if (j === undefined) {
      unmatchedTicks += 1;
      return;
    }
    comparedTicks += 1;
    for (const [id, ta] of a) {
      const tb = b.get(id);
      if (!tb) continue;
      const pa = ta.present[i] === 1;
      const pb = tb.present[j] === 1;
      if (pa !== pb) {
        diverge(id, t);
        continue;
      }
      if (!pa) continue;
      const d = Math.hypot(ta.x[i]! - tb.x[j]!, ta.y[i]! - tb.y[j]!);
      const h = Math.abs(wrapPi(ta.headingRad[i]! - tb.headingRad[j]!)) * (180 / Math.PI);
      if (d > maxPositionDeltaM) {
        maxPositionDeltaM = d;
        worst = { actorId: id, t };
      }
      if (h > maxHeadingDeltaDeg) maxHeadingDeltaDeg = h;
      if (d > MOTION_DIFF_TOLERANCE.positionM || h > MOTION_DIFF_TOLERANCE.headingDeg) diverge(id, t);
    }
  });
  const unmatchedCandidateTicks = candidate.trace.ticks.t.length - comparedTicks;
  const identical = changed.size === 0
    && actorsOnlyInBase.length === 0
    && actorsOnlyInCandidate.length === 0
    && unmatchedTicks === 0
    && unmatchedCandidateTicks === 0;
  return {
    schema: MOTION_DIFF_SCHEMA,
    identical,
    tolerance: { ...MOTION_DIFF_TOLERANCE },
    comparedTicks,
    unmatchedTicks: unmatchedTicks + unmatchedCandidateTicks,
    maxPositionDeltaM: Math.round(maxPositionDeltaM * 1e4) / 1e4,
    maxHeadingDeltaDeg: Math.round(maxHeadingDeltaDeg * 1e3) / 1e3,
    worst: maxPositionDeltaM > 0 ? worst : null,
    firstDivergenceS,
    actorsChanged: [...changed].sort(),
    actorsOnlyInBase,
    actorsOnlyInCandidate,
    base: { traceSha256: base.traceSha256, engineSemVer: base.engineSemVer },
    candidate: { traceSha256: candidate.traceSha256, engineSemVer: candidate.engineSemVer },
  };
}
