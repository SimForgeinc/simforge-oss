import {
  isTrafficPlaybackActor,
  playbackActorOrigin,
  type PlaybackBundle,
  type SampledActor,
} from "@simforge-oss/playback";

import type { TrafficActorSelection } from "./inspector/TrafficActorDetailsPanel";

/** Ids the editor's display-only browser SUMO preview draws (`decodeSumoActorViews`). */
const SUMO_PREVIEW_ID = /^sumo:[0-9a-f]{8}$/;

/**
 * Resolve a picked body to the read-only traffic card, or `null` when it is
 * not traffic (authored actors keep the normal selection path). Internal
 * helpers such as the blank world's clock actor are never shown.
 */
export function trafficActorSelection(
  actorId: string,
  bundle: Pick<PlaybackBundle, "actors"> | null | undefined,
  sampled: readonly Pick<SampledActor, "id" | "speedMps" | "present">[] = [],
): TrafficActorSelection | null {
  if (SUMO_PREVIEW_ID.test(actorId)) {
    return { id: actorId, source: "sumo-preview", kind: "car", catalogId: "vehicle.sedan", speedMps: null };
  }
  const actor = bundle?.actors.find((candidate) => candidate.id === actorId);
  if (!actor || actor.id === "ambient-world-seed" || !isTrafficPlaybackActor(actor)) return null;
  const sample = sampled.find((candidate) => candidate.id === actorId && candidate.present);
  return {
    id: actor.id,
    source: playbackActorOrigin(actor) === "sumo" ? "sumo-trace" : "native",
    kind: actor.kind,
    catalogId: actor.catalogId,
    speedMps: sample ? sample.speedMps : null,
  };
}
