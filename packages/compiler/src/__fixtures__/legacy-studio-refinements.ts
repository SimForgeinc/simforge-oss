/**
 * FROZEN REFERENCE: the TypeScript Studio refinements as they were before the
 * move to native (`simforge_compiler::studio_refinements`), kept only for the
 * golden cross-check (`studio-refinements.golden.test.ts`). Do not import
 * from product code.
 */
/* eslint-disable */
import { parseSimScenarioInput, type Interaction, type SimScenarioInput } from '@simforge-oss/engine';

const HIGH_SPEED_WORLD_ROUTE_MPS = 20;
const PASSENGER_CAR_MAX_LATERAL_ACCELERATION_MPS2 = 7;
const MIN_STABLE_YAW_RATE_RADPS = 0.08;
const CRUISE_RESTORE_ACCELERATION_MPS2 = 3;
const WHEELED_ROAD_ACTOR_KINDS = new Set([
  'vehicle',
  'car',
  'van',
  'truck',
  'bus',
  'motorcycle',
  'bicycle',
]);

/** Stabilize high-speed authored world routes before they reach dynamic-v1. */
export function withStableHighSpeedWorldRoutes(input: SimScenarioInput): SimScenarioInput {
  const actorIds = new Set(
    input.interactions
      .filter((interaction) =>
        interaction.verb === 'route'
        && interaction.target.kind === 'polyline'
        && interaction.bestEffortWorldPath === true)
      .map((interaction) => interaction.actorId),
  );
  if (actorIds.size === 0) return input;

  const existingProfiles = input.physics?.vehicleProfiles ?? {};
  const vehicleProfiles = { ...existingProfiles };
  const stabilizedActorIds = new Set<string>();
  let changed = false;

  for (const actor of input.actors) {
    if (!actorIds.has(actor.id) || actor.static || !WHEELED_ROAD_ACTOR_KINDS.has(actor.kind)) continue;
    const referenceSpeedMps = Math.max(
      Math.abs(actor.initial.speedMps),
      Math.abs(actor.behavior.cruiseSpeedMps ?? 0),
    );
    if (referenceSpeedMps < HIGH_SPEED_WORLD_ROUTE_MPS) continue;

    const existing = existingProfiles[actor.id] ?? {};
    const lateralAccelerationMps2 = existing.maxLateralAccelerationMps2
      ?? PASSENGER_CAR_MAX_LATERAL_ACCELERATION_MPS2;
    const feasibleYawRateRadps = Math.max(
      MIN_STABLE_YAW_RATE_RADPS,
      lateralAccelerationMps2 / referenceSpeedMps,
    );
    const maxYawRateRadps = existing.maxYawRateRadps === undefined
      ? feasibleYawRateRadps
      : Math.min(existing.maxYawRateRadps, feasibleYawRateRadps);
    vehicleProfiles[actor.id] = { ...existing, maxYawRateRadps };
    stabilizedActorIds.add(actor.id);
    changed = true;
  }

  const interactions = input.interactions.map((interaction) => {
    if (
      !stabilizedActorIds.has(interaction.actorId)
      || interaction.verb !== 'route'
      || interaction.target.kind !== 'polyline'
      || interaction.joinFromCurrentPose !== true
    ) return interaction;
    changed = true;
    return { ...interaction, joinFromCurrentPose: false };
  });

  if (!changed) return input;
  return parseSimScenarioInput({
    ...input,
    physics: {
      ...input.physics,
      mode: input.physics?.mode ?? 'dynamic-v1',
      vehicleProfiles,
    },
    interactions,
  });
}

/** Restore an actor's baseline cruise speed when a bounded speed action releases. */
export function withBoundedSpeedCruiseRestoration(input: SimScenarioInput): SimScenarioInput {
  const actors = new Map(input.actors.map((actor) => [actor.id, actor]));
  const existingIds = new Set(input.interactions.map((interaction) => interaction.id));
  const restorations: Interaction[] = [];

  for (const interaction of input.interactions) {
    if (interaction.verb !== 'speed' || !interaction.window) continue;
    const actor = actors.get(interaction.actorId);
    const cruiseSpeedMps = actor?.behavior.cruiseSpeedMps;
    if (!actor || cruiseSpeedMps === undefined || actor.static) continue;
    const releaseTime = interaction.window.endS;
    if (releaseTime >= input.clipSeconds - 1e-9) continue;
    if (hasLongitudinalCommandAt(input.interactions, interaction.id, interaction.actorId, releaseTime)) continue;
    const id = `restore-cruise-${interaction.id}`;
    if (existingIds.has(id)) continue;
    existingIds.add(id);
    restorations.push({
      id,
      actorId: interaction.actorId,
      trigger: { kind: 'at', t: releaseTime },
      verb: 'speed',
      target: { mode: 'absolute', value: cruiseSpeedMps },
      dynamics: {
        shape: 'linear',
        constraint: 'rate',
        value: CRUISE_RESTORE_ACCELERATION_MPS2,
      },
    });
  }

  if (restorations.length === 0) return input;
  return parseSimScenarioInput({ ...input, interactions: [...input.interactions, ...restorations] });
}

function hasLongitudinalCommandAt(
  interactions: readonly Interaction[],
  releasedInteractionId: string,
  actorId: string,
  time: number,
): boolean {
  return interactions.some(
    (candidate) =>
      candidate.id !== releasedInteractionId
      && candidate.actorId === actorId
      && (candidate.verb === 'speed' || candidate.verb === 'gap')
      && candidate.trigger.kind === 'at'
      && Math.abs(candidate.trigger.t - time) <= 1e-9,
  );
}

const STUDIO_BODY_COLOR_TAG_PREFIX = "studio:body-color:";
const STUDIO_BODY_COLOR_EXTENSION_KEY = "studio.presentation.bodyColor";

/** `#rrggbb` for a hex or `rgb(r, g, b)` string; `null` for anything else. */
export function normalizeStudioBodyColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let text = value.trim().toLowerCase();
  if (!text) return null;
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  if (/^#[0-9a-f]{3}$/.test(text)) {
    return `#${[...text.slice(1)].map((channel) => channel + channel).join("")}`;
  }
  if (text.startsWith("rgb(") && text.endsWith(")")) text = text.slice(4, -1);
  const channels = text.split(",");
  if (channels.length !== 3) return null;
  const bytes: number[] = [];
  for (const channel of channels) {
    const parsed = Number(channel.trim());
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) return null;
    bytes.push(parsed);
  }
  return `#${bytes.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

interface TaggedActorsCarrier {
  readonly actors: readonly { readonly tags: readonly string[] }[];
}

interface PaintedRolesCarrier {
  readonly roles: readonly {
    readonly id: string;
    readonly extensions?: Readonly<Record<string, unknown>> | undefined;
  }[];
}

/**
 * Reconcile authored Studio paint onto an already-materialized input: every
 * `role:<id>` actor carries exactly the tag its role's paint implies, and stale
 * paint tags are dropped. Returns the same object when nothing changes.
 */
export function withStudioBodyColorTags<T extends TaggedActorsCarrier>(input: T, template: PaintedRolesCarrier): T {
  const colors: Record<string, string> = {};
  for (const role of template.roles) {
    const color = normalizeStudioBodyColor(role.extensions?.[STUDIO_BODY_COLOR_EXTENSION_KEY]);
    if (color) colors[role.id] = color;
  }

  let changed = false;
  const actors = input.actors.map((actor) => {
    const roleTag = actor.tags.find((tag) => tag.startsWith("role:"));
    const color = roleTag ? colors[roleTag.slice("role:".length)] : undefined;
    const tags = actor.tags.filter((tag) => !tag.startsWith(STUDIO_BODY_COLOR_TAG_PREFIX));
    if (color) tags.push(`${STUDIO_BODY_COLOR_TAG_PREFIX}${color}`);
    if (tags.length === actor.tags.length && tags.every((tag, index) => tag === actor.tags[index])) return actor;
    changed = true;
    return { ...actor, tags };
  });
  return changed ? { ...input, actors } : input;
}
const PARKED_CARS_EXTENSION_KEY = "studio.ambientTraffic.parkedCars.v1";

/** Id prefix every baked parked car carries. */
const PARKED_CAR_ID_PREFIX = "parked:";

/** One committed parked car, in scene metres. */
export interface ParkedCar {
  readonly id: string;
  readonly stallId: string;
  readonly catalogId: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly headingRad: number;
  readonly lengthM: number;
  readonly widthM: number;
  readonly heightM: number;
}

const CAR_NUMBER_KEYS = [
  "x",
  "y",
  "z",
  "headingRad",
  "lengthM",
  "widthM",
  "heightM",
] as const;

/**
 * Baked cars off a document's extension bag, dropping anything incomplete.
 *
 * The bag is an untyped `Record<string, unknown>` by design and a hand-edited
 * document is a supported input, so a malformed entry is skipped rather than
 * allowed to fail deep inside the compiler as `runtime_asset_identity_missing`.
 */
export function bakedParkedCarsFromExtensions(
  extensions: Readonly<Record<string, unknown>> | undefined,
): readonly ParkedCar[] {
  const raw = extensions?.[PARKED_CARS_EXTENSION_KEY];
  if (raw == null || typeof raw !== "object") return [];
  const baked = (raw as Record<string, unknown>)["baked"];
  if (!Array.isArray(baked)) return [];

  const cars: ParkedCar[] = [];
  for (const entry of baked) {
    if (entry == null || typeof entry !== "object") continue;
    const car = entry as Record<string, unknown>;
    if (typeof car["id"] !== "string" || car["id"].length === 0) continue;
    if (typeof car["stallId"] !== "string") continue;
    if (typeof car["catalogId"] !== "string" || car["catalogId"].length === 0) continue;
    let usable = true;
    for (const key of CAR_NUMBER_KEYS) {
      const value = car[key];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        usable = false;
        break;
      }
    }
    if (usable) cars.push(car as unknown as ParkedCar);
  }
  return cars;
}

/**
 * Length of the degenerate route a parked car carries, metres.
 *
 * ASAM export rejects a single-point route outright — `route_too_short`, "ASAM
 * routes require at least two distinct world positions" — so a stationary car
 * still needs two. One millimetre along the car's own heading is collinear with
 * its pose, so nothing can derive a direction that contradicts the stall, and it
 * is three orders of magnitude finer than the map pipeline's own accuracy.
 */
const PARKED_CAR_ROUTE_M = 0.001;


/**
 * Behaviour rules a parked car carries.
 *
 * These are the upstream `actorSchema` defaults. A parked car never acts on any
 * of them — it has no route to speak of and zero speed — but the exporter reads
 * `rules.obeySignals` unconditionally, so the field has to be present.
 */
const PARKED_CAR_RULES = {
  obeySignals: true,
  yieldToVehicles: true,
  yieldToPedestrians: true,
  collisionAvoidance: true,
  aggression: 0.5,
  speedFactor: 1,
} as const;

/** The minimum an input must look like for parked cars to be appended. */
interface ActorsCarrier {
  readonly actors: readonly { readonly id: string }[];
}

/**
 * Append baked parked cars to a concrete simulation input.
 *
 * Each becomes an ordinary actor at zero speed with a degenerate route, which is
 * what makes it physical (it collides and occludes) and exportable: the vendored
 * exporter emits it as a `ScenarioObject` with an Init teleport and a trajectory
 * whose every speed is zero — a car standing in a bay.
 *
 * With no baked cars the input is returned by identity, so every existing
 * scenario compiles to exactly the bytes it did before.
 */
export function withParkedCarActors<T extends ActorsCarrier>(
  input: T,
  baked: readonly ParkedCar[],
): T {
  if (baked.length === 0) return input;

  // An authored role or ambient vehicle already holding the id wins: the
  // document is the authority on its own actors, and a duplicate id would fail
  // inside the exporter rather than here.
  const taken = new Set(input.actors.map((actor) => actor.id));
  const additions = baked
    .filter((car) => !taken.has(car.id))
    // Sorted so the appended block is byte-stable however the extension was
    // written, merged, or re-serialised. The digest depends on this.
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((car) => ({
      id: car.id,
      kind: "car",
      /**
       * The whole reason a parked car is cheap.
       *
       * The engine keys a fast path off this: it skips the motion backend, route
       * following, cruise-speed resolution, signal obedience, and static/static
       * collision pairs, and forces speed to zero. Without it every parked car
       * is integrated at every fixed step like a driving vehicle — which is
       * exactly the lag a car park full of them produces.
       */
      static: true,
      // The compiler asserts exactly one `catalog:` tag per actor
      // (`runtime_asset_identity_missing` / `_ambiguous`), and it is what binds
      // the actor to a CARLA blueprint.
      tags: [`catalog:${car.catalogId}`],
      initial: {
        pose: { x: car.x, z: car.z, headingRad: car.headingRad },
        speedMps: 0,
      },
      behavior: {
        // Spelled out rather than left to the schema's defaults: this module is
        // deliberately free of `@simforge-oss/*`, so nothing here can parse an
        // actor. The exporter reads `rules.obeySignals` directly and crashes on
        // an actor that lacks it. `parked-cars-export.test.ts` asserts these
        // match what `actorSchema` fills in, so upstream drift fails loudly.
        rules: PARKED_CAR_RULES,
        route: {
          kind: "polyline",
          points: [
            { x: car.x, z: car.z },
            // Scene heading h points along (cos h, -sin h) in (x, z).
            {
              x: car.x + PARKED_CAR_ROUTE_M * Math.cos(car.headingRad),
              z: car.z - PARKED_CAR_ROUTE_M * Math.sin(car.headingRad),
            },
          ],
        },
      },
      presentAtStart: true,
      dims: { l: car.lengthM, w: car.widthM, h: car.heightM },
    }));

  if (additions.length === 0) return input;
  return { ...input, actors: [...input.actors, ...additions] } as unknown as T;
}
