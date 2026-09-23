/**
 * LEGACY: OpenSCENARIO → native scene states. NOT a render path.
 *
 * The render contract is the render timeline (`timeline-lowering.ts`,
 * `docs/engineering/render-timeline.md`): renderers replay the authoritative
 * trace through the shared sampler, and the native engine refuses a job
 * without one (`native_render_timeline_missing`). This xosc lowering
 * re-derives poses from a derived export (yaw only, no dims or colour, coarse
 * environment) and survives only for offline tools that screen xosc motion.
 * Do not extend it, and never route a render through it.
 *
 * This module also owns the kind vocabularies the timeline lowering shares
 * (`nativeActorClass`, `nativeActorCatalogId`): both are total over the
 * engine's actor kinds and refuse anything else (`native_actor_kind_unmapped`).
 */

import { createHash } from 'node:crypto';

import {
  extractOpenScenarioExecutionPlan,
  type OpenScenarioExecutionPlan,
  type OpenScenarioPlanActor,
  type OpenScenarioPlanSample,
} from '@simforge-oss/openscenario';
import { SCENE_ACTOR_CLASS_OF_KIND } from '@simforge-oss/scenario';
import { RenderInputError } from '../render-input-error.js';
import { unionFrameMicros, type FixedSchedule } from '../schedule.js';

export interface NativeActorState {
  readonly id: string;
  readonly kind: 'spawn' | 'update' | 'despawn';
  readonly catalogId: string;
  readonly actorClass: string;
  /** Authored L/W/H extents (timeline lowering). */
  readonly dims?: { readonly l: number; readonly w: number; readonly h: number };
  /** Authored sRGB body colour (timeline lowering). */
  readonly color?: string;
  readonly transform: {
    readonly position: readonly [number, number, number];
    readonly rotation: readonly [number, number, number, number];
  };
  readonly velocity: readonly [number, number, number];
  /** Unwrapped wheel rotation (timeline `wheelSpinRad`); every wheeled actor on the timeline path. */
  readonly wheelSpinRad?: number;
  /** Four-wheelers: sprung-body attitude, applied to the model's `body` node only. */
  readonly bodyAttitude?: { readonly pitchRad: number; readonly rollRad: number };
  /** Four-wheelers: per-wheel drop `[FL, FR, RL, RR]`, metres, applied to the `wheel_*` nodes. */
  readonly wheelDropM?: readonly [number, number, number, number];
}

export interface NativeSceneState {
  readonly version: 'simforge.scene-state.v1';
  readonly mapId: string;
  readonly tick: number;
  readonly tickHz: number;
  readonly weather: { readonly preset: 'clear' | 'rain' | 'fog' | 'night' };
  readonly timeOfDay: number;
  /**
   * Ground fallback for actors whose scene `y` is ~0. The timeline lowering
   * sends `0`: its `y` is the baked height, authoritative even at 0.
   */
  readonly groundY?: number;
  readonly actors: readonly NativeActorState[];
}

/**
 * One rendered actor's appearance identity: the catalog id the scene state
 * carries and whether the scenario authored it (`catalog:<id>` tag) or the
 * lowering substituted the semantic class default.
 */
export interface NativeActorAppearance {
  readonly actorId: string;
  /**
   * Engine actor kind (`car`, `pedestrian`, …) the appearance was derived
   * for. Required for an unauthored appearance, whose catalog id must be the
   * kind's documented default; a lowering always sets it.
   */
  readonly kind?: string;
  readonly catalogId: string;
  readonly authored: boolean;
}

/** What the native engine renders from, whichever source it was lowered from. */
export interface NativeSceneLowering {
  readonly source: 'render-timeline' | 'openscenario-legacy';
  readonly mapId: string;
  readonly fixedTimestepSeconds: number;
  readonly states: readonly NativeSceneState[];
  readonly frameTimes: readonly number[];
  /** Every actor that appears in at least one state, sorted by id. */
  readonly appearances: readonly NativeActorAppearance[];
  readonly sha256: string;
}

export interface NativeLowering extends NativeSceneLowering {
  readonly source: 'openscenario-legacy';
  readonly plan: OpenScenarioExecutionPlan;
}

function q(value: number): number {
  return Number(value.toFixed(6));
}

export function canonicalSceneJson(value: unknown): string {
  return canonicalJson(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON cannot contain non-finite numbers');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new TypeError(`canonical JSON cannot contain ${typeof value}`);
}

function sampleAt(actor: OpenScenarioPlanActor, time: number): OpenScenarioPlanSample {
  const samples = actor.samples;
  if (time <= samples[0]!.t) return samples[0]!;
  if (time >= samples.at(-1)!.t) return samples.at(-1)!;
  let low = 0;
  let high = samples.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle]!.t <= time) low = middle;
    else high = middle;
  }
  const left = samples[low]!;
  const right = samples[high]!;
  const ratio = (time - left.t) / (right.t - left.t);
  const headingDelta = Math.atan2(
    Math.sin(right.headingRad - left.headingRad),
    Math.cos(right.headingRad - left.headingRad),
  );
  return {
    t: time,
    x: left.x + (right.x - left.x) * ratio,
    y: left.y + (right.y - left.y) * ratio,
    z: left.z + (right.z - left.z) * ratio,
    headingRad: left.headingRad + headingDelta * ratio,
    speedMps: left.speedMps + (right.speedMps - left.speedMps) * ratio,
    present: left.present && right.present,
  };
}

/**
 * Engine actor kind → the native service's actor class (primitive body, semantic
 * and instance class: `renderer/service` `actor_dims`, `SemanticClass::
 * from_actor_class`). Total over the engine kinds (`ACTOR_KINDS`) plus the
 * OpenSCENARIO vehicle categories the legacy lowering reads; every entry is
 * explicit and an unknown kind is refused, never labelled `prop`.
 */
export const NATIVE_ACTOR_CLASSES: Readonly<Record<string, string>> = Object.freeze({
  // Engine kinds: the one shared table (@simforge-oss/scenario).
  ...SCENE_ACTOR_CLASS_OF_KIND,
  // OpenSCENARIO categories (legacy lowering only).
  obstacle: 'prop', suv: 'suv', pickup: 'pickup',
});

/**
 * Engine actor kind → catalog id when the scenario authored none. The same
 * table as `@simforge-oss/playback` `defaultCatalogIdForActorKind` (a test
 * pins them equal) and the native ambient generator. `obstacle` is the
 * OpenSCENARIO spelling of `static_object`.
 */
export const NATIVE_KIND_DEFAULT_CATALOG_IDS: Readonly<Record<string, string>> = Object.freeze({
  vehicle: 'vehicle.sedan', car: 'vehicle.sedan', truck: 'vehicle.box_truck', bus: 'vehicle.bus',
  van: 'vehicle.van', motorcycle: 'vehicle.motorcycle', bicycle: 'vehicle.bicycle',
  pedestrian: 'pedestrian.adult', scooter: 'vehicle.bicycle', sidewalk_robot: 'sidewalk_robot.delivery_rover',
  drone: 'drone.camera_quadcopter', animal: 'animal.dog', static_object: 'hazard.cardboard_box',
  obstacle: 'hazard.cardboard_box',
});

function unmappedKind(kind: string, subject: string, table: string): RenderInputError {
  return new RenderInputError('native_actor_kind_unmapped', `${subject} has actor kind "${kind}", which the native ${table} table does not map`, { kind });
}

/** The native service's actor class for an engine actor kind; refuses an unknown kind. */
export function nativeActorClass(kind: string, subject = 'an actor'): string {
  const mapped = Object.hasOwn(NATIVE_ACTOR_CLASSES, kind) ? NATIVE_ACTOR_CLASSES[kind] : undefined;
  if (mapped === undefined) throw unmappedKind(kind, subject, 'actor class');
  return mapped;
}

/** The documented catalog default for an actor kind; refuses an unknown kind. */
export function nativeKindDefaultCatalogId(kind: string, subject = 'an actor'): string {
  const mapped = Object.hasOwn(NATIVE_KIND_DEFAULT_CATALOG_IDS, kind) ? NATIVE_KIND_DEFAULT_CATALOG_IDS[kind] : undefined;
  if (mapped === undefined) throw unmappedKind(kind, subject, 'catalog default');
  return mapped;
}

function authoredCatalogId(tags: readonly string[]): string | undefined {
  const tagged = tags.find((tag) => tag.startsWith('catalog:'));
  return tagged?.slice('catalog:'.length);
}

/**
 * The catalog id the native scene state carries for an actor: the authored
 * `catalog:<id>` tag verbatim, else the kind's documented default. An
 * unknown kind is refused (`native_actor_kind_unmapped`), never a sedan.
 */
export function nativeActorCatalogId(kind: string, tags: readonly string[], subject = 'an actor'): string {
  const authored = authoredCatalogId(tags);
  if (authored !== undefined) return authored;
  return nativeKindDefaultCatalogId(kind, subject);
}

function environment(plan: OpenScenarioExecutionPlan): { preset: 'clear' | 'rain' | 'fog' | 'night'; hour: number } {
  const authored = plan.environment.authored;
  const preset = authored.timeOfDay === 'night'
    ? 'night'
    : authored.weather === 'rain'
      ? 'rain'
      : plan.environment.standard.fogVisualRangeM < 1_000
        ? 'fog'
        : 'clear';
  const hour = authored.timeOfDay === 'night' ? 2 : authored.timeOfDay === 'dusk' ? 19.5 : authored.timeOfDay === 'dawn' ? 6 : 12;
  return { preset, hour };
}

export function lowerOpenScenarioToNative(
  xosc: string,
  sourceSha256: string,
  schedules: readonly FixedSchedule[],
): NativeLowering {
  if (schedules.length === 0) throw new Error('native render requires at least one RGB schedule');
  const plan = extractOpenScenarioExecutionPlan(xosc, { sourceSha256 });
  const frameTimes = unionFrameMicros(schedules).map((value) => value / 1_000_000);
  const conditions = environment(plan);
  const previous = new Map<string, boolean>();
  const rendered = new Set<string>();
  const states = frameTimes.map((clipTime, tick): NativeSceneState => {
    const planTime = plan.warmupSeconds + clipTime;
    if (planTime > plan.stopTimeS + 1e-8) {
      throw new Error(`render frame ${tick} at ${planTime}s exceeds OpenSCENARIO stop time ${plan.stopTimeS}s`);
    }
    const actors: NativeActorState[] = [];
    for (const actor of [...plan.actors].sort((left, right) => left.id.localeCompare(right.id))) {
      const sample = sampleAt(actor, planTime);
      const wasPresent = previous.get(actor.id) === true;
      previous.set(actor.id, sample.present);
      if (!sample.present && !wasPresent) continue;
      const kind = sample.present ? (wasPresent ? 'update' : 'spawn') : 'despawn';
      const metadata = plan.actorMetadata[actor.id];
      const yaw = sample.headingRad;
      rendered.add(actor.id);
      actors.push({
        id: actor.id,
        kind,
        catalogId: nativeActorCatalogId(actor.kind, metadata?.tags ?? actor.tags, `actor ${actor.id}`),
        actorClass: nativeActorClass(actor.kind, `actor ${actor.id}`),
        // The OpenSCENARIO BoundingBox dimensions (the service requires dims).
        dims: { l: q(actor.dims.l), w: q(actor.dims.w), h: q(actor.dims.h) },
        transform: {
          position: [q(sample.x), q(sample.z), q(-sample.y)],
          rotation: [0, q(Math.sin(yaw / 2)), 0, q(Math.cos(yaw / 2))],
        },
        velocity: [q(sample.speedMps * Math.cos(yaw)), 0, q(-sample.speedMps * Math.sin(yaw))],
      });
    }
    const previousTime = tick === 0 ? frameTimes[1] ?? clipTime + plan.dt : frameTimes[tick - 1]!;
    const tickHz = q(1 / Math.max(1e-9, Math.abs(clipTime - previousTime)));
    return {
      version: 'simforge.scene-state.v1', mapId: plan.mapId, tick, tickHz,
      weather: { preset: conditions.preset }, timeOfDay: conditions.hour, actors,
    };
  });
  const appearances = [...plan.actors]
    .filter((actor) => rendered.has(actor.id))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((actor): NativeActorAppearance => {
      const tags = plan.actorMetadata[actor.id]?.tags ?? actor.tags;
      return {
        actorId: actor.id,
        kind: actor.kind,
        catalogId: nativeActorCatalogId(actor.kind, tags, `actor ${actor.id}`),
        authored: authoredCatalogId(tags) !== undefined,
      };
    });
  const sha256 = createHash('sha256').update(canonicalJson({ planSource: sourceSha256, states })).digest('hex');
  return {
    source: 'openscenario-legacy', mapId: plan.mapId, fixedTimestepSeconds: plan.dt,
    plan, states, frameTimes, appearances, sha256,
  };
}
