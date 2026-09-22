/**
 * The rules cross-map transfer applies between the native compiler and the
 * response: repairing the lift's output so it parses, ordering candidates, and
 * drawing a lane-path route as one line. Pure, so they are tested directly.
 */

import type { ScenarioTemplateV2 } from "@simforge-oss/scenario";

/**
 * The native lift carries a formation wider than the anchor frame as a rigid
 * pair (`relative_to` + `rigidOffsetM`) and writes the raw lateral fraction into
 * `tFrac`, which the scenario schema bounds to ±1. With `rigidOffsetM` present
 * the materializer never reads `tFrac` (the offset owns placement), so bounding
 * it here is lossless — and without it the template does not parse at all.
 */
export function boundRigidPairLateralFractions(template: ScenarioTemplateV2): ScenarioTemplateV2 {
  return {
    ...template,
    roles: template.roles.map((role) =>
      role.kind === "relative_to" && role.rigidOffsetM && Math.abs(role.tFrac) > 1
        ? { ...role, tFrac: Math.sign(role.tFrac) }
        : role),
  };
}

/** Route drawn in a preview: enough to show where the subject goes, not the whole lane chain. */
const ROUTE_PREVIEW_M = 160;

/**
 * A lane path as one continuous line from the actor forward. Lane polylines
 * are stored in the lane's reference-line direction, which is against travel
 * for half of them, so each is turned to meet the previous one's end; the
 * first is turned to agree with the actor's heading and cut at its position.
 */
export function chainLanePath(
  lanes: ReadonlyArray<ReadonlyArray<{ x: number; z: number }>>,
  start: { x: number; z: number; headingRad: number },
): Array<{ x: number; z: number }> | null {
  const usable = lanes.filter((lane) => lane.length >= 2);
  if (usable.length === 0) return null;
  const distance = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
  // The path usually begins with runway behind the actor: start on the lane
  // the actor actually stands on.
  let first = 0;
  let firstDistance = Infinity;
  for (const [index, lane] of usable.entries()) {
    const nearest = Math.min(...lane.map((point) => distance(point, start)));
    if (nearest < firstDistance - 0.5) {
      first = index;
      firstDistance = nearest;
    }
  }
  const forward = { x: Math.cos(start.headingRad), z: -Math.sin(start.headingRad) };
  const out: Array<{ x: number; z: number }> = [];
  for (let index = first; index < usable.length; index += 1) {
    let points = [...usable[index]!];
    if (index === first) {
      // The first lane leaves by the end nearer the next lane; with no next
      // lane, by the end the actor faces.
      const next = usable[index + 1];
      const head = points[0]!;
      const tail = points[points.length - 1]!;
      const exitIsTail = next
        ? Math.min(distance(next[0]!, tail), distance(next[next.length - 1]!, tail))
          <= Math.min(distance(next[0]!, head), distance(next[next.length - 1]!, head))
        : (tail.x - head.x) * forward.x + (tail.z - head.z) * forward.z >= 0;
      if (!exitIsTail) points.reverse();
      let nearest = 0;
      for (let i = 1; i < points.length; i += 1) {
        if (distance(points[i]!, start) < distance(points[nearest]!, start)) nearest = i;
      }
      points = [{ x: start.x, z: start.z }, ...points.slice(nearest + 1)];
    } else {
      const last = out[out.length - 1]!;
      const toStart = distance(points[0]!, last);
      const toEnd = distance(points[points.length - 1]!, last);
      if (toEnd < toStart) points.reverse();
      // A lane that does not continue from the last one ends the drawn route.
      if (Math.min(toStart, toEnd) > 8) break;
    }
    out.push(...points);
  }
  let length = 0;
  for (let i = 1; i < out.length; i += 1) {
    length += distance(out[i]!, out[i - 1]!);
    if (length > ROUTE_PREVIEW_M) return out.slice(0, i + 1);
  }
  return out.length >= 2 ? out : null;
}

/** Clean placements first, then the matcher's own order; `rank` is the resulting position. */
export function rankCandidates<T extends { offRoadActors: number; rank: number }>(candidates: readonly T[], limit: number): T[] {
  return candidates
    .map((candidate, order) => ({ candidate, order }))
    .sort((a, b) => Number(a.candidate.offRoadActors > 0) - Number(b.candidate.offRoadActors > 0) || a.order - b.order)
    .slice(0, limit)
    .map(({ candidate }, index) => ({ ...candidate, rank: index + 1 }));
}
