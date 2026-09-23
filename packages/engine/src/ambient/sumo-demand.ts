/**
 * Actor-centred SUMO demand shared by the editor preview and the worker.
 *
 * Route candidates come from the map's SUMO sidecar. Demand prefers routes
 * whose departure edge is near the authored action: a deterministic 70/20/10
 * local/approach/background split, balanced round-robin across the authored
 * focuses. Distances are compared squared, so the ranking uses only exact
 * IEEE arithmetic and is identical on every JavaScript engine.
 */

import type { ResolvedAmbientTrafficProfile } from './profile.js';
import {
  buildSumoRouteDocument,
  sumoSceneToNetwork,
  type SumoNetworkWorldTransform,
  type SumoRouteDocumentOptions,
  type SumoScenePoint,
} from './sumo.js';

export const SUMO_DEMAND_REPLENISHMENT_PERIOD_SECONDS = 40;
export const SUMO_DEMAND_DEPARTURE_WINDOW_SECONDS = 30;
export const SUMO_DEMAND_WARMUP_SECONDS = 60;
export const SUMO_DEMAND_LOCAL_RADIUS_METERS = 300;
export const SUMO_DEMAND_APPROACH_RADIUS_METERS = 700;

/** Route-document options every SUMO surface uses for ambient demand. */
export const SUMO_DEMAND_ROUTE_OPTIONS: SumoRouteDocumentOptions = Object.freeze({
  departureWindowSeconds: SUMO_DEMAND_DEPARTURE_WINDOW_SECONDS,
  replenishmentPeriodSeconds: SUMO_DEMAND_REPLENISHMENT_PERIOD_SECONDS,
  replenishmentStride: 4,
  flowEndSeconds: 3600,
});

export interface LocalizedSumoRouteCandidates {
  readonly candidates: readonly (readonly string[])[];
  readonly nearbyCandidates: readonly (readonly string[])[];
  readonly approachCandidates: readonly (readonly string[])[];
  readonly backgroundCandidates: readonly (readonly string[])[];
  readonly nearbyRouteStarts: number;
}

/** Rank route candidates by how close their departure edge is to any focus. */
export function localizeSumoRouteCandidates(
  candidates: readonly (readonly string[])[],
  networkXml: string,
  transform: SumoNetworkWorldTransform,
  focuses: readonly SumoScenePoint[],
): LocalizedSumoRouteCandidates {
  if (focuses.length === 0) {
    return {
      candidates,
      nearbyCandidates: [],
      approachCandidates: [],
      backgroundCandidates: candidates,
      nearbyRouteStarts: 0,
    };
  }
  const centers = sumoEdgeCenters(networkXml);
  const networkFocuses = focuses.map((focus) => sumoSceneToNetwork(focus, transform));
  const scale2 = transform.scale * transform.scale;
  const ranked = candidates
    .map((candidate, ordinal) => {
      const point = centers.get(candidate[0] ?? '');
      let distance2 = Number.POSITIVE_INFINITY;
      let focusIndex = -1;
      if (point) {
        networkFocuses.forEach((focus, index) => {
          const dx = point.x - focus.x;
          const dy = point.y - focus.y;
          const value = (dx * dx + dy * dy) * scale2;
          if (value < distance2) {
            distance2 = value;
            focusIndex = index;
          }
        });
      }
      return { candidate, ordinal, distance2, focusIndex };
    })
    .sort((left, right) => left.distance2 - right.distance2 || left.ordinal - right.ordinal);
  const local2 = SUMO_DEMAND_LOCAL_RADIUS_METERS ** 2;
  const approach2 = SUMO_DEMAND_APPROACH_RADIUS_METERS ** 2;
  const nearby = balanceAcrossFocuses(ranked.filter((item) => item.distance2 <= local2), focuses.length);
  const approach = balanceAcrossFocuses(
    ranked.filter((item) => item.distance2 > local2 && item.distance2 <= approach2),
    focuses.length,
  );
  const background = balanceAcrossFocuses(ranked.filter((item) => item.distance2 > approach2), focuses.length);
  return {
    candidates: [...nearby, ...approach, ...background],
    nearbyCandidates: nearby,
    approachCandidates: approach,
    backgroundCandidates: background,
    nearbyRouteStarts: nearby.length,
  };
}

/** Select a deterministic 70/20/10 local/approach/background population. */
export function selectActorCenteredSumoDemand(
  localized: LocalizedSumoRouteCandidates,
  maxActors: number,
): readonly (readonly string[])[] {
  const target = Math.min(Math.max(0, maxActors), localized.candidates.length);
  const nearbyTarget = Math.ceil(target * 0.7);
  const approachTarget = Math.floor(target * 0.2);
  const backgroundTarget = Math.max(0, target - nearbyTarget - approachTarget);
  const selected = [
    ...localized.nearbyCandidates.slice(0, nearbyTarget),
    ...localized.approachCandidates.slice(0, approachTarget),
    ...localized.backgroundCandidates.slice(0, backgroundTarget),
  ];
  if (selected.length === target) return selected;
  const used = new Set(selected);
  for (const candidate of localized.candidates) {
    if (selected.length >= target) break;
    if (!used.has(candidate)) {
      selected.push(candidate);
      used.add(candidate);
    }
  }
  return selected;
}

export interface SumoDemandPlan {
  readonly routeDocument: string;
  readonly selectedRoutes: number;
  readonly nearbyRouteStarts: number;
  /** Candidates dropped because they drive along an authored actor's lanes. */
  readonly authoredCorridorRejects: number;
}

/**
 * SUMO edges carrying any of the given OpenDRIVE lanes (`road:section:lane`
 * or `road_lane`), matched through each SUMO lane's `origId`.
 */
export function sumoEdgesForRoadLanes(networkXml: string, lanes: Iterable<string>): Set<string> {
  const wanted = new Set<string>();
  for (const lane of lanes) {
    const parts = lane.split(':');
    wanted.add(parts.length === 3 ? `${parts[0]}_${parts[2]}` : lane);
  }
  const edges = new Set<string>();
  for (const match of networkXml.matchAll(/<lane\b([^>]*?)(?:\/>|>([\s\S]*?)<\/lane>)/g)) {
    const id = /(?:^|\s)id="([^"]+)"/.exec(match[1]!)?.[1];
    if (!id || id.startsWith(':')) continue;
    const origIds = /<param\b[^>]*key="origId"[^>]*value="([^"]*)"/.exec(match[2] ?? '')?.[1]?.split(/\s+/) ?? [];
    if (origIds.some((origId) => wanted.has(origId))) edges.add(id.slice(0, id.lastIndexOf('_')));
  }
  return edges;
}

/**
 * A drivable edge no route candidate uses, for the proxy route: a proxy SUMO
 * could not place (the bridge leaves it pending) can then only ever appear
 * where no ambient vehicle drives. Deterministic: the first such edge by id.
 */
export function sumoIsolatedProxyEdge(networkXml: string, candidates: readonly (readonly string[])[]): string | null {
  const used = new Set(candidates.flat());
  const edges: string[] = [];
  for (const match of networkXml.matchAll(/<edge\b([^>]*)>([\s\S]*?)<\/edge>/g)) {
    const attrs = match[1]!;
    const id = /(?:^|\s)id="([^"]+)"/.exec(attrs)?.[1];
    if (!id || id.startsWith(':') || /\sfunction="/.test(attrs) || used.has(id)) continue;
    const lanes = [...match[2]!.matchAll(/<lane\b([^>]*?)(?:\/>|>)/g)].map((lane) => lane[1]!);
    const drivable = lanes.some((lane) => !/\sallow="/.test(lane) && !/\bdisallow="[^"]*\bpassenger\b/.test(lane)
      && Number(/\slength="([^"]+)"/.exec(lane)?.[1] ?? 0) >= 8);
    if (drivable) edges.push(id);
  }
  edges.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return edges[0] ?? null;
}

/** Candidates → localized selection → route XML, as every SUMO surface runs it. */
export function planSumoDemand(
  candidates: readonly (readonly string[])[],
  networkXml: string,
  transform: SumoNetworkWorldTransform,
  profile: ResolvedAmbientTrafficProfile,
  focuses: readonly SumoScenePoint[],
  routeOptions: SumoRouteDocumentOptions = SUMO_DEMAND_ROUTE_OPTIONS,
  /**
   * Edges authored actors drive along. One-way coupling means an authored
   * actor never yields to ambient traffic, so ambient routes on its lanes
   * would be run into; like the native generator's authored-corridor
   * exclusion, those candidates are dropped.
   */
  excludedEdges: ReadonlySet<string> = new Set(),
): SumoDemandPlan {
  const eligible = excludedEdges.size === 0
    ? candidates
    : candidates.filter((route) => !route.some((edge) => excludedEdges.has(edge)));
  const localized = localizeSumoRouteCandidates(eligible, networkXml, transform, focuses);
  const demand = focuses.length > 0 ? selectActorCenteredSumoDemand(localized, profile.maxActors) : localized.candidates;
  return {
    routeDocument: buildSumoRouteDocument(demand, profile, routeOptions),
    selectedRoutes: Math.max(0, Math.min(profile.maxActors, demand.length)),
    nearbyRouteStarts: localized.nearbyRouteStarts,
    authoredCorridorRejects: candidates.length - eligible.length,
  };
}

function balanceAcrossFocuses<T extends { readonly candidate: readonly string[]; readonly focusIndex: number }>(
  ranked: readonly T[],
  focusCount: number,
): readonly (readonly string[])[] {
  const queues = Array.from({ length: focusCount }, () => [] as T[]);
  const unassigned: T[] = [];
  for (const item of ranked) {
    const queue = queues[item.focusIndex];
    if (queue) queue.push(item);
    else unassigned.push(item);
  }
  const balanced: (readonly string[])[] = [];
  let offset = 0;
  while (balanced.length < ranked.length - unassigned.length) {
    for (const queue of queues) {
      const item = queue[offset];
      if (item) balanced.push(item.candidate);
    }
    offset += 1;
  }
  return [...balanced, ...unassigned.map((item) => item.candidate)];
}

/** Mean vertex of every non-internal edge shape, in SUMO network coordinates. */
export function sumoEdgeCenters(networkXml: string): Map<string, { x: number; y: number }> {
  const centers = new Map<string, { x: number; y: number }>();
  for (const match of networkXml.matchAll(/<edge\b[^>]*\bid="([^"]+)"[^>]*\bshape="([^"]+)"[^>]*>/g)) {
    if (match[1]!.startsWith(':')) continue;
    const valid = match[2]!.trim().split(/\s+/).map((entry) => entry.split(',').map(Number))
      .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
    if (valid.length === 0) continue;
    centers.set(match[1]!, {
      x: valid.reduce((sum, point) => sum + point[0]!, 0) / valid.length,
      y: valid.reduce((sum, point) => sum + point[1]!, 0) / valid.length,
    });
  }
  return centers;
}
