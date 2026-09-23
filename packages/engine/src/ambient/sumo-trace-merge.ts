/**
 * Bake worker SUMO traffic into the authoritative trace.
 *
 * The merged trace is the only place SUMO traffic exists downstream: editor
 * playback, Evaluation, the render timeline, Bevy and CARLA all replay these
 * tracks and never run traffic themselves. Authored tracks, signals, events
 * and metrics are carried over untouched (one-way coupling). Each SUMO actor
 * becomes an ordinary ambient trace actor with render metadata and an
 * explicit `origin: "sumo"`.
 */

import type { SimTrace, TraceActorMetadata } from '../trace/trace.js';
import {
  decodeMaterializedTrafficArtifact,
  type MaterializedTrafficArtifactEnvelope,
} from './materialized-traffic.js';
import { SUMO_TRAFFIC_ORIGIN, SUMO_TRAFFIC_VEHICLE } from './sumo-traffic.js';

/** Render identity of one merged SUMO actor (plus the explicit origin). */
export function sumoTraceActorMetadata(): TraceActorMetadata & { readonly origin: typeof SUMO_TRAFFIC_ORIGIN } {
  return {
    kind: SUMO_TRAFFIC_VEHICLE.kind,
    dims: { ...SUMO_TRAFFIC_VEHICLE.dims },
    static: false,
    // Tags survive every runtime that re-serializes the header, and the render
    // timeline derives `origin` from them (`sumo` wins over `ambient`).
    tags: ['ambient', `catalog:${SUMO_TRAFFIC_VEHICLE.catalogId}`, SUMO_TRAFFIC_ORIGIN],
    origin: SUMO_TRAFFIC_ORIGIN,
  };
}

export function mergeSumoTrafficIntoTrace(
  trace: SimTrace,
  traffic: MaterializedTrafficArtifactEnvelope,
): SimTrace {
  // Re-validate the exact canonical bytes; the merge never trusts a parsed object.
  const { artifact, sha256 } = decodeMaterializedTrafficArtifact(traffic.bytes);
  if (sha256 !== traffic.sha256) throw new Error(`SUMO traffic bytes ${sha256} do not match ${traffic.sha256}`);
  if (artifact.provider.id !== 'sumo') throw new Error(`expected SUMO traffic, got ${artifact.provider.id}`);
  if (trace.header.dt !== artifact.fixedStepSeconds || trace.header.clipSeconds !== artifact.durationSeconds) {
    throw new Error('trace grid does not match the SUMO traffic grid');
  }
  if (trace.header.materializedTrafficDigest) throw new Error('trace already carries materialized traffic');
  const frames = trace.ticks.t.length;
  artifact.actors.forEach((actor) => {
    if (actor.states.length !== frames) throw new Error(`SUMO actor ${actor.id} does not cover the trace ticks`);
    actor.states.forEach((state, index) => {
      if (Math.abs(state.t - trace.ticks.t[index]!) > 1e-9) throw new Error('SUMO traffic frames are off the trace grid');
    });
  });
  const overlap = artifact.actors.map((actor) => actor.id).filter((id) => trace.ticks.actors[id] !== undefined);
  if (overlap.length > 0) throw new Error(`SUMO actors collide with trace actors: ${overlap.join(', ')}`);

  const actors: SimTrace['ticks']['actors'] = { ...trace.ticks.actors };
  const actorMetadata: Record<string, TraceActorMetadata> = { ...(trace.header.actorMetadata ?? {}) };
  for (const actor of artifact.actors) {
    actors[actor.id] = {
      x: actor.states.map((state) => state.x),
      // Materialized traffic is scene x/z; the trace is OpenDRIVE-local x/y (y = -z).
      y: actor.states.map((state) => (state.z === 0 ? 0 : -state.z)),
      headingRad: actor.states.map((state) => state.headingRad),
      speedMps: actor.states.map((state) => state.speedMps),
      lateralOffsetM: actor.states.map(() => 0),
      motionDirection: actor.states.map(() => 1 as const),
      laneRsl: actor.states.map(() => null),
      s: travelled(actor.states),
      present: actor.states.map((state) => (state.present ? 1 : 0)),
    };
    actorMetadata[actor.id] = sumoTraceActorMetadata();
  }
  const sumoIds = artifact.actors.map((actor) => actor.id);
  return {
    ...trace,
    header: {
      ...trace.header,
      actorIds: [...trace.header.actorIds, ...sumoIds].sort(compare),
      actorMetadata: sortKeys(actorMetadata),
      ambientActorIds: [...new Set([...(trace.header.ambientActorIds ?? []), ...sumoIds])].sort(compare),
      materializedTrafficDigest: sha256,
    },
    ticks: { ...trace.ticks, actors: sortKeys(actors) },
  };
}

/** Distance driven since first appearance (sqrt is correctly rounded: identical everywhere). */
function travelled(states: readonly { readonly present: boolean; readonly x: number; readonly z: number }[]): number[] {
  let total = 0;
  let previous: { x: number; z: number } | null = null;
  return states.map((state) => {
    if (!state.present) {
      previous = null;
      return total;
    }
    if (previous) {
      const dx = state.x - previous.x;
      const dz = state.z - previous.z;
      total += Math.sqrt(dx * dx + dz * dz);
    }
    previous = { x: state.x, z: state.z };
    return Math.round(total * 1e4) / 1e4;
  });
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(record).sort(compare).map((key) => [key, record[key]!]));
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Whether a trace already carries baked worker SUMO traffic. The editor's
 * live SUMO preview stands down for such a trace: the authoritative traffic
 * is replayed from it, never simulated again.
 */
export function traceCarriesSumoTraffic(trace: {
  readonly header: { readonly actorMetadata?: Readonly<Record<string, { readonly tags: readonly string[] }>> };
}): boolean {
  return Object.values(trace.header.actorMetadata ?? {}).some((meta) => meta.tags.includes(SUMO_TRAFFIC_ORIGIN));
}
