/**
 * Whether an actor's trajectory stays on the drivable network, asked early
 * enough to be answerable.
 *
 * Road elevation is physical ground truth: every sensor in a render reads the
 * surface height the OpenDRIVE `<elevation>` profile gives, so
 * `buildXodrElevationResolver` refuses a position further than
 * {@link OFF_NETWORK_BOUND_M} from any lane ribbon rather than inventing a
 * height for terrain it knows nothing about. That refusal is correct, but on
 * its own it lands deep inside the ASAM export — after a revision exists —
 * as a code with no position in it.
 *
 * This asks the same question of a trace that already exists (the draft's
 * saved simulation), so a scenario that cannot be rendered says so while it
 * is being authored or submitted, naming the actor, when it leaves, and how
 * far off it ends up.
 */

import { pointOf, type TopologyIndex } from '@simforge-oss/engine';
import type { SimTrace } from '@simforge-oss/engine';

/**
 * How far from a lane ribbon a position may still be resolved to that lane's
 * surface. Beyond this the elevation is unknowable, not merely uncertain: at
 * 25 m — roughly seven lane widths — the actor is on terrain the OpenDRIVE
 * road profile does not describe, and extrapolating the last road height
 * there would silently corrupt every sensor that reads ground truth.
 *
 * `buildXodrElevationResolver` enforces exactly this bound; it is defined
 * here so the resolver and the early check can never disagree about it.
 */
export const OFF_NETWORK_BOUND_M = 25;

/** The nearest lane ribbon to a position, by perpendicular distance in metres. */
export interface NearestLane {
  readonly rsl: string;
  readonly laneType: string;
  readonly distanceM: number;
}

/**
 * Perpendicular distance from `(x, y)` to the closest point of any lane
 * polyline, searched exhaustively. The resolver's own lookup is pruned to a
 * spatial cell because it runs per sample on the hot path; this runs only
 * where a real distance has to be reported, so it does not prune.
 */
export function nearestLane(topology: TopologyIndex, x: number, y: number): NearestLane | null {
  let best: NearestLane | null = null;
  for (const rsl of Object.keys(topology.lanes)) {
    const lane = topology.lanes[rsl]!;
    const points = lane.polyline.map(pointOf);
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1]!;
      const b = points[index]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length2 = dx * dx + dy * dy;
      const t = length2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length2)) : 0;
      const distanceM = Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
      if (!best || distanceM < best.distanceM) best = { rsl, laneType: lane.laneType, distanceM };
    }
  }
  return best;
}

/** One actor's first departure from the drivable network, with the worst point of it. */
export interface OffNetworkDeparture {
  readonly actorId: string;
  /** Trace time of the first sample beyond the bound, in seconds. */
  readonly leavesAtSeconds: number;
  /**
   * Trace time of the last sample still on the network, in seconds: the
   * longest clip of this drive that a render could resolve elevation for.
   */
  readonly lastOnNetworkSeconds: number;
  /** Trace time of the sample that ends up furthest off, in seconds. */
  readonly worstAtSeconds: number;
  /** The furthest-off position, in the xodr-local frame the trace is written in. */
  readonly worstPosition: { readonly x: number; readonly y: number };
  /** Distance from that position to the nearest lane of any type, in metres. */
  readonly worstDistanceM: number;
  readonly nearestLaneRsl: string;
  /** How many of the actor's samples are beyond the bound. */
  readonly sampleCount: number;
  readonly totalSamples: number;
}

/**
 * Every actor in `trace` whose path leaves the drivable network, in trace
 * order. An empty result means the export's elevation lookup will resolve for
 * all of them. Samples where the actor is absent are not its trajectory and
 * are skipped, matching what the exporter writes.
 */
export function findOffNetworkDepartures(trace: SimTrace, topology: TopologyIndex): OffNetworkDeparture[] {
  const departures: OffNetworkDeparture[] = [];
  const times = trace.ticks.t;
  for (const actorId of Object.keys(trace.ticks.actors).sort()) {
    const track = trace.ticks.actors[actorId]!;
    let first: number | null = null;
    let lastOnNetwork: number | null = null;
    let worst: { index: number; distanceM: number; rsl: string } | null = null;
    let count = 0;
    let considered = 0;
    for (let index = 0; index < times.length; index += 1) {
      if (track.present[index] === 0) continue;
      const x = track.x[index]!;
      const y = track.y[index]!;
      considered += 1;
      const near = nearestLane(topology, x, y);
      if (!near || near.distanceM <= OFF_NETWORK_BOUND_M) {
        if (first === null) lastOnNetwork = index;
        continue;
      }
      count += 1;
      if (first === null) first = index;
      if (!worst || near.distanceM > worst.distanceM) worst = { index, distanceM: near.distanceM, rsl: near.rsl };
    }
    if (first === null || !worst) continue;
    departures.push({
      actorId,
      leavesAtSeconds: times[first]!,
      lastOnNetworkSeconds: lastOnNetwork === null ? 0 : times[lastOnNetwork]!,
      worstAtSeconds: times[worst.index]!,
      worstPosition: { x: track.x[worst.index]!, y: track.y[worst.index]! },
      worstDistanceM: worst.distanceM,
      nearestLaneRsl: worst.rsl,
      sampleCount: count,
      totalSamples: considered,
    });
  }
  return departures;
}

/**
 * The longest clip, in whole seconds, that every actor stays on the network
 * for. Whole seconds because it is advice a user types back into a clip
 * length, and rounded down so the suggestion is inside the network rather
 * than on its edge.
 */
export function longestRenderableClipSeconds(departures: readonly OffNetworkDeparture[]): number {
  return Math.floor(Math.min(...departures.map((departure) => departure.lastOnNetworkSeconds)));
}

/** What the author has to change, in the words of the thing that refused. */
export function offNetworkMessage(departures: readonly OffNetworkDeparture[]): string {
  return [
    departures.length === 1
      ? 'This scenario cannot be rendered: an actor drives off the drivable road network, where road elevation is undefined.'
      : `This scenario cannot be rendered: ${departures.length} actors drive off the drivable road network, where road elevation is undefined.`,
    ...departures.map((departure) =>
      `- ${departure.actorId} leaves the network ${departure.leavesAtSeconds.toFixed(1)} s in and is `
      + `${departure.worstDistanceM.toFixed(1)} m from the nearest lane (${departure.nearestLaneRsl}) at `
      + `${departure.worstAtSeconds.toFixed(1)} s, position x=${departure.worstPosition.x.toFixed(1)} `
      + `y=${departure.worstPosition.y.toFixed(1)} (${departure.sampleCount} of ${departure.totalSamples} samples off network).`),
    `Positions more than ${OFF_NETWORK_BOUND_M} m from a lane have no road surface to stand on, so a render would have to`
    + ' invent the ground height under the sensors.',
    longestRenderableClipSeconds(departures) < 1
      ? 'No clip length renders this drive: it leaves the road almost immediately. Move the route onto lanes that carry'
        + ' the drive, or author it on a map with a larger network.'
      : `Shorten the clip to ${longestRenderableClipSeconds(departures)} s, or move the route onto lanes that carry the`
        + ' drive for the whole clip, or author it on a map with a larger network.',
  ].join('\n');
}
