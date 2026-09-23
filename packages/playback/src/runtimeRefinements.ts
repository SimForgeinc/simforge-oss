import type { ActorRenderer, ActorView } from '@simforge-oss/viewer';
import type { PlaybackBundle } from './model';

const GRAVITY_MPS2 = 9.81;
const MIN_CURB_RISE_M = 0.04;
const MAX_CURB_RISE_M = 0.35;
const MIN_CURB_SLOPE = 0.08;
const CURB_EVENT_COOLDOWN_S = 0.45;

interface HopEvent {
  readonly t: number;
  readonly launchVelocityMps: number;
}

export interface PlaybackVerticalMotion {
  readonly offsetAt: (actorId: string, timeS: number) => number;
  readonly eventsByActor: ReadonlyMap<string, readonly HopEvent[]>;
}

/** Deterministic presentation motion layered over the planar evidence trace. */
export function createPlaybackVerticalMotion(
  bundle: PlaybackBundle,
  sampleHeight: (x: number, z: number) => number | null,
): PlaybackVerticalMotion {
  const mutable = new Map<string, HopEvent[]>();
  const actorById = new Map(bundle.actors.map((actor) => [actor.id, actor]));
  const times = bundle.trace.ticks.t;

  for (const event of bundle.trace.events) {
    if (event.kind !== 'collision') continue;
    const actorId = event.a.startsWith('map:') ? event.b : event.b.startsWith('map:') ? event.a : null;
    if (!actorId || !actorById.has(actorId)) continue;
    const track = bundle.trace.ticks.actors[actorId];
    if (!track) continue;
    const tick = nearestTick(times, event.t);
    const speedMps = track.speedMps[tick] ?? 0;
    addHop(mutable, actorId, {
      t: event.t,
      launchVelocityMps: clamp(0.9 + speedMps * 0.035, 0.9, 2.4),
    });
  }

  for (const actor of bundle.actors) {
    if (
      actor.static
      || actor.tags.some((tag) => tag === 'ambient' || tag.startsWith('ambient:'))
      || actor.kind === 'pedestrian'
      || actor.kind === 'animal'
      || actor.kind === 'static_object'
    ) continue;
    const track = bundle.trace.ticks.actors[actor.id];
    if (!track) continue;
    let priorHeight = sampleHeight(track.x[0]!, track.z[0]!);
    let lastEventT = Number.NEGATIVE_INFINITY;
    for (let index = 1; index < times.length; index += 1) {
      const height = sampleHeight(track.x[index]!, track.z[index]!);
      if (height === null || priorHeight === null) {
        priorHeight = height;
        continue;
      }
      const riseM = height - priorHeight;
      const distanceM = Math.hypot(
        track.x[index]! - track.x[index - 1]!,
        track.z[index]! - track.z[index - 1]!,
      );
      const timeS = times[index]!;
      if (
        riseM >= MIN_CURB_RISE_M
        && riseM <= MAX_CURB_RISE_M
        && distanceM > 1e-3
        && riseM / distanceM >= MIN_CURB_SLOPE
        && (track.speedMps[index - 1] ?? 0) > 1.5
        && timeS - lastEventT >= CURB_EVENT_COOLDOWN_S
      ) {
        addHop(mutable, actor.id, {
          t: timeS,
          launchVelocityMps: clamp(
            0.55 + riseM * 2.8 + (track.speedMps[index - 1] ?? 0) * 0.012,
            0.7,
            1.65,
          ),
        });
        lastEventT = timeS;
      }
      priorHeight = height;
    }
  }

  const eventsByActor = new Map(
    [...mutable.entries()].map(([actorId, events]) => [actorId, events.sort((a, b) => a.t - b.t)]),
  );
  return {
    eventsByActor,
    offsetAt(actorId, timeS) {
      let offsetM = 0;
      for (const event of eventsByActor.get(actorId) ?? []) {
        const elapsedS = timeS - event.t;
        if (elapsedS < 0) break;
        const flightS = (2 * event.launchVelocityMps) / GRAVITY_MPS2;
        if (elapsedS > flightS) continue;
        offsetM = Math.max(
          offsetM,
          event.launchVelocityMps * elapsedS - 0.5 * GRAVITY_MPS2 * elapsedS ** 2,
        );
      }
      return offsetM;
    },
  };
}

/** Keep the shared renderer owner while changing only trace-playback poses. */
export function withPlaybackVerticalMotion(
  renderer: ActorRenderer,
  motion: PlaybackVerticalMotion,
): ActorRenderer {
  return new Proxy(renderer, {
    get(target, property) {
      if (property === 'syncLayer') {
        return (layer: string, actors: readonly ActorView[]) => {
          target.syncLayer(layer, layer === 'playback'
            ? actors.map((actor) => ({
              ...actor,
              y: actor.y + motion.offsetAt(actor.id, actor.animationTimeS ?? 0),
            }))
            : actors);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function addHop(target: Map<string, HopEvent[]>, actorId: string, event: HopEvent): void {
  const events = target.get(actorId) ?? [];
  if (!events.some((candidate) => Math.abs(candidate.t - event.t) < 1e-3)) events.push(event);
  target.set(actorId, events);
}

function nearestTick(times: readonly number[], timeS: number): number {
  let low = 0;
  let high = times.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (times[middle]! < timeS) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return 0;
  return Math.abs(times[low]! - timeS) < Math.abs(times[low - 1]! - timeS) ? low : low - 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Post-impact poses that override immutable trace samples before rendering. */
export class CollisionActorOverrides {
  private actors = new Map<string, ActorView>();

  replace(actors: readonly ActorView[]): void {
    this.actors = new Map(actors.map((actor) => [actor.id, actor] as const));
  }

  apply(actors: readonly ActorView[]): readonly ActorView[] {
    if (this.actors.size === 0) return actors;
    return actors.map((actor) => this.actors.get(actor.id) ?? actor);
  }

  clear(): void {
    this.actors.clear();
  }

  get size(): number {
    return this.actors.size;
  }
}

export function withCollisionActorOverrides(
  renderer: ActorRenderer,
  overrides: CollisionActorOverrides,
): ActorRenderer {
  return new Proxy(renderer, {
    get(target, property) {
      if (property === 'syncLayer') {
        return (layer: string, actors: readonly ActorView[]) => {
          target.syncLayer(layer, layer === 'playback' ? overrides.apply(actors) : actors);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
