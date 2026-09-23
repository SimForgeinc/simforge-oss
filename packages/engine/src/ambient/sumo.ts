import { DEFAULT_ACTOR_DIMS } from '../schema/input.js';
import type { ResolvedAmbientTrafficProfile } from './profile.js';
import { sumoIdHash } from './sumo-runtime.js';

/** The ambient profile's vehicle classes, in the order the mix is drawn (the native ambient generator's order). */
export const SUMO_VEHICLE_CLASSES = ['car', 'van', 'truck', 'bus', 'motorcycle'] as const;
export type SumoVehicleClass = typeof SUMO_VEHICLE_CLASSES[number];

/** One class's rendered body, shared by SUMO car following and every renderer. */
export interface SumoVehicleBody {
  readonly kind: SumoVehicleClass;
  readonly catalogId: string;
  readonly dims: { readonly l: number; readonly w: number; readonly h: number };
}

/**
 * The body of each SUMO vehicle class. The catalog ids are the documented kind
 * defaults (`defaultCatalogIdForActorKind`, the native ambient generator's
 * `ambient_catalog_id`); the non-car bodies are the engine's kind dimensions
 * (`DEFAULT_ACTOR_DIMS`). The car keeps the body SUMO traffic has always used.
 */
export const SUMO_VEHICLE_BODIES: Readonly<Record<SumoVehicleClass, SumoVehicleBody>> = Object.freeze({
  car: Object.freeze({ kind: 'car', catalogId: 'vehicle.sedan', dims: Object.freeze({ l: 4.55, w: 1.82, h: 1.48 }) }),
  van: Object.freeze({ kind: 'van', catalogId: 'vehicle.van', dims: Object.freeze({ ...DEFAULT_ACTOR_DIMS.van }) }),
  truck: Object.freeze({ kind: 'truck', catalogId: 'vehicle.box_truck', dims: Object.freeze({ ...DEFAULT_ACTOR_DIMS.truck }) }),
  bus: Object.freeze({ kind: 'bus', catalogId: 'vehicle.bus', dims: Object.freeze({ ...DEFAULT_ACTOR_DIMS.bus }) }),
  motorcycle: Object.freeze({ kind: 'motorcycle', catalogId: 'vehicle.motorcycle', dims: Object.freeze({ ...DEFAULT_ACTOR_DIMS.motorcycle }) }),
}) as Readonly<Record<SumoVehicleClass, SumoVehicleBody>>;

/** SUMO vType id of a class: the car keeps the historical `ambient`, so an all-car demand is byte-identical. */
export function sumoVehicleTypeId(vehicleClass: SumoVehicleClass): string {
  return vehicleClass === 'car' ? 'ambient' : `ambient-${vehicleClass}`;
}

/**
 * The class of one route slot, drawn from the profile's `vehicleMix`: a
 * deterministic function of the profile seed and the slot's SUMO id (FNV-1a,
 * no platform RNG), so a slot keeps its class whatever else the demand holds.
 * An all-zero mix names no vehicle and is refused.
 */
export function sumoVehicleClassFor(
  seed: string | number,
  slotId: string,
  mix: Readonly<Record<SumoVehicleClass, number>>,
): SumoVehicleClass {
  const weights = SUMO_VEHICLE_CLASSES.map((vehicleClass) => mix[vehicleClass]);
  if (weights.some((weight) => !Number.isFinite(weight) || weight < 0)) {
    throw new Error(`sumo_vehicle_mix_invalid: ${JSON.stringify(mix)}`);
  }
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0)) throw new Error('sumo_vehicle_mix_empty: the ambient vehicle mix gives every class zero weight');
  let draw = mix32(sumoNumericSeed(`${String(seed)}:vtype:${slotId}`)) / 2 ** 32 * total;
  for (let index = 0; index < SUMO_VEHICLE_CLASSES.length; index += 1) {
    draw -= weights[index]!;
    if (draw < 0) return SUMO_VEHICLE_CLASSES[index]!;
  }
  // Rounding can leave `draw` at 0 after the last positive weight: that class.
  let last = SUMO_VEHICLE_CLASSES.length - 1;
  while (weights[last] === 0) last -= 1;
  return SUMO_VEHICLE_CLASSES[last]!;
}

/** Browser/CLI-neutral transform published by a generated SUMO map sidecar. */
export interface SumoNetworkWorldTransform {
  readonly translationX: number;
  readonly translationY: number;
  readonly rotationDegrees: number;
  readonly scale: number;
  readonly invertY: boolean;
}

/**
 * Provider-neutral scene coordinates used by the simulator, CLI and Studio.
 *
 * `x` is scene east/right and `z` is scene south/forward.  In particular this
 * is *not* an intermediate mathematical `y`: callers must never negate `z`
 * before or after these functions.  `invertY` in the generated sidecar is the
 * single place where SUMO/OpenDRIVE +y is reflected into scene +z.
 */
export interface SumoScenePoint {
  readonly x: number;
  readonly z: number;
}

export interface SumoNetworkPoint {
  readonly x: number;
  readonly y: number;
}

export function sumoNetworkToScene(
  point: SumoNetworkPoint,
  transform: SumoNetworkWorldTransform,
): SumoScenePoint {
  assertUsableTransform(transform);
  const radians = transform.rotationDegrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const reflectedY = transform.invertY ? -point.y : point.y;
  return {
    x: (point.x * cosine - reflectedY * sine) * transform.scale + transform.translationX,
    z: (point.x * sine + reflectedY * cosine) * transform.scale + transform.translationY,
  };
}

export function sumoSceneToNetwork(
  point: SumoScenePoint,
  transform: SumoNetworkWorldTransform,
): SumoNetworkPoint {
  assertUsableTransform(transform);
  const radians = -transform.rotationDegrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const translatedX = (point.x - transform.translationX) / transform.scale;
  const translatedZ = (point.z - transform.translationY) / transform.scale;
  return {
    x: translatedX * cosine - translatedZ * sine,
    y: (translatedX * sine + translatedZ * cosine) * (transform.invertY ? -1 : 1),
  };
}

/** SUMO navigation degrees -> scene navigation degrees. */
export function sumoNetworkHeadingToScene(
  headingDegrees: number,
  transform: SumoNetworkWorldTransform,
): number {
  return (transform.invertY ? 180 - headingDegrees : headingDegrees) + transform.rotationDegrees;
}

/** Scene navigation degrees -> SUMO navigation degrees. */
export function sumoSceneHeadingToNetwork(
  headingDegrees: number,
  transform: SumoNetworkWorldTransform,
): number {
  const relative = headingDegrees - transform.rotationDegrees;
  return transform.invertY ? 180 - relative : relative;
}

function assertUsableTransform(transform: SumoNetworkWorldTransform): void {
  if (!Number.isFinite(transform.scale) || transform.scale === 0) {
    throw new RangeError('SUMO scene transform scale must be finite and non-zero');
  }
}

/** Versioned generated sidecar consumed by every SUMO runtime surface. */
export interface SumoNetworkManifest {
  readonly schema: 'uniscenarios.sumo-network.v1';
  readonly mapId: string;
  readonly networkFile: string;
  readonly sha256: string;
  readonly worldFromNetwork: SumoNetworkWorldTransform;
  readonly routeCandidates: readonly (readonly string[])[];
}

/** Compliance/provenance envelope next to the packaged Wasm module. */
export interface SumoRuntimeManifest {
  readonly schema: 'uniscenarios.sumo-runtime.v1';
  readonly sumoVersion: string;
  readonly sumoCommit: string;
  readonly wasmBytes: number;
  readonly wasmGzipBytes: number;
  readonly licenseNotice: string;
  readonly sourceOffer: string;
}

/** Deterministic SUMO route XML shared by the editor and headless debugger. */
export interface SumoRouteDocumentOptions {
  /** Spread initial departures over this window. The CLI defaults to t=0. */
  readonly departureWindowSeconds?: number;
  /** Replenish every Nth population slot at this cadence. Omit for one-shot CLI runs. */
  readonly replenishmentPeriodSeconds?: number;
  readonly replenishmentStride?: number;
  readonly flowEndSeconds?: number;
  /**
   * Body of every ambient vehicle. Omitted, SUMO uses its passenger default
   * (5.0 × 1.8 m); the worker passes the rendered catalog body so car
   * following and the drawn vehicle agree.
   */
  readonly vehicleDimensions?: { readonly lengthM: number; readonly widthM: number; readonly heightM: number };
  /**
   * Draw each route slot's class from the profile's `vehicleMix` and declare
   * one vType per class drawn, each with its class body
   * (`SUMO_VEHICLE_BODIES`). Omitted, every vehicle shares the single
   * `ambient` vType (the editor preview's legacy demand).
   */
  readonly vehicleMix?: boolean;
  /**
   * Route the bridge assigns to externally owned proxies. A proxy SUMO could
   * not place stays *pending* on this route, and SUMO may later insert it at
   * the route's start; the worker therefore points it at an edge no ambient
   * route uses. Defaults to the first candidate route (legacy behaviour).
   */
  readonly proxyRouteEdges?: readonly string[];
}

/** One vehicle or flow of a route document. */
export interface SumoRouteSlot {
  readonly id: string;
  readonly element: 'vehicle' | 'flow';
  readonly vehicleClass: SumoVehicleClass;
}

export interface SumoRouteDemand {
  readonly document: string;
  readonly slots: readonly SumoRouteSlot[];
  /**
   * Every SUMO vehicle id the document can insert (flow members are
   * `<flowId>.<n>`), by the bridge's id hash, with its class. Present with
   * `vehicleMix`.
   */
  readonly classesByIdHash?: ReadonlyMap<number, SumoVehicleClass>;
}

export function buildSumoRouteDocument(
  candidates: readonly (readonly string[])[],
  profile: ResolvedAmbientTrafficProfile,
  options: SumoRouteDocumentOptions = {},
): string {
  return buildSumoRouteDemand(candidates, profile, options).document;
}

export function buildSumoRouteDemand(
  candidates: readonly (readonly string[])[],
  profile: ResolvedAmbientTrafficProfile,
  options: SumoRouteDocumentOptions = {},
): SumoRouteDemand {
  if (candidates.length === 0) throw new Error('SUMO map has no usable traffic routes');
  const shuffled = deterministicShuffle(candidates, sumoNumericSeed(profile.seed));
  const count = Math.max(0, Math.min(profile.maxActors, shuffled.length));
  const aggression = clamp(profile.aggressiveness, 0, 1);
  const tau = (1.45 - aggression * 0.65).toFixed(2);
  const accel = (2.0 + aggression * 1.2).toFixed(2);
  const sigma = (0.15 + aggression * 0.45).toFixed(2);
  const speedDev = clamp(profile.speedVariance, 0, 0.8).toFixed(2);
  const proxyEdges = (options.proxyRouteEdges && options.proxyRouteEdges.length > 0 ? options.proxyRouteEdges : candidates[0]!).map(xml).join(' ');
  const departureWindowSeconds = Math.max(0, options.departureWindowSeconds ?? 0);
  const replenishmentPeriodSeconds = options.replenishmentPeriodSeconds;
  const replenishmentStride = Math.max(1, Math.trunc(options.replenishmentStride ?? 4));
  const flowEndSeconds = Math.max(departureWindowSeconds, options.flowEndSeconds ?? 3600);
  const slots: SumoRouteSlot[] = [];
  const vehicles = shuffled.slice(0, count).map((edges, index) => {
    const depart = count <= 1 ? 0 : index / (count - 1) * departureWindowSeconds;
    const id = sumoVehicleId(profile.seed, index);
    const vehicleClass = options.vehicleMix ? sumoVehicleClassFor(profile.seed, id, profile.vehicleMix) : 'car';
    const type = sumoVehicleTypeId(vehicleClass);
    const route = edges.map(xml).join(' ');
    const flow = replenishmentPeriodSeconds !== undefined && replenishmentPeriodSeconds > 0 && index % replenishmentStride === 0;
    slots.push({ id, element: flow ? 'flow' : 'vehicle', vehicleClass });
    return flow
      ? `  <flow id="${id}" type="${type}" begin="${depart.toFixed(2)}" end="${flowEndSeconds}" period="${replenishmentPeriodSeconds}" departLane="best" departPos="random_free" departSpeed="max"><route edges="${route}"/></flow>`
      : `  <vehicle id="${id}" type="${type}" depart="${departureWindowSeconds > 0 ? depart.toFixed(2) : '0'}" departLane="best" departPos="random_free" departSpeed="max"><route edges="${route}"/></vehicle>`;
  }).join('\n');
  const vTypeLine = (vehicleClass: SumoVehicleClass): string => {
    const body = options.vehicleMix
      ? { lengthM: SUMO_VEHICLE_BODIES[vehicleClass].dims.l, widthM: SUMO_VEHICLE_BODIES[vehicleClass].dims.w, heightM: SUMO_VEHICLE_BODIES[vehicleClass].dims.h }
      : options.vehicleDimensions;
    const dimensions = body ? ` length="${body.lengthM}" width="${body.widthM}" height="${body.heightM}"` : '';
    return `  <vType id="${sumoVehicleTypeId(vehicleClass)}" carFollowModel="EIDM" laneChangeModel="SL2015" accel="${accel}" decel="4.5" emergencyDecel="9" sigma="${sigma}" tau="${tau}" speedFactor="1" speedDev="${speedDev}"${dimensions}/>`;
  };
  // `ambient` is always declared (the proxies' route needs none, but an
  // all-car document stays byte-identical); other classes only when drawn.
  const used = new Set(slots.map((slot) => slot.vehicleClass));
  const vTypes = SUMO_VEHICLE_CLASSES.filter((vehicleClass) => vehicleClass === 'car' || used.has(vehicleClass)).map(vTypeLine).join('\n');
  const document = `<?xml version="1.0" encoding="UTF-8"?>
<routes>
${vTypes}
  <route id="proxy-route" edges="${proxyEdges}"/>
${vehicles}
</routes>`;
  if (!options.vehicleMix) return { document, slots };
  const classesByIdHash = new Map<number, SumoVehicleClass>();
  const owners = new Map<number, string>();
  const bind = (vehicleId: string, vehicleClass: SumoVehicleClass): void => {
    const hash = sumoIdHash(vehicleId);
    const owner = owners.get(hash);
    if (owner !== undefined && owner !== vehicleId) throw new Error(`sumo_id_hash_collision: ${owner} and ${vehicleId}`);
    owners.set(hash, vehicleId);
    classesByIdHash.set(hash, vehicleClass);
  };
  slots.forEach((slot, index) => {
    if (slot.element === 'vehicle') {
      bind(slot.id, slot.vehicleClass);
      return;
    }
    // SUMO names a flow's vehicles `<flowId>.<n>` from 0, one per period until `end`.
    const begin = count <= 1 ? 0 : Number((index / (count - 1) * departureWindowSeconds).toFixed(2));
    const inserted = Math.ceil((flowEndSeconds - begin) / replenishmentPeriodSeconds!) + 1;
    for (let member = 0; member < inserted; member += 1) bind(`${slot.id}.${member}`, slot.vehicleClass);
  });
  return { document, slots, classesByIdHash };
}

export function sumoNumericSeed(seed: string | number): number {
  const source = String(seed);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function sumoVehicleId(seed: string | number, index: number): string {
  return `sumo-${sumoNumericSeed(seed).toString(16)}-${index}`;
}

/** Hash stored by the lean SUMO bridge in lieu of allocating actor-id strings. */
export function sumoActorIdHash(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function validateSumoNetworkManifest(manifest: SumoNetworkManifest, mapId: string): void {
  if (manifest.schema !== 'uniscenarios.sumo-network.v1') throw new Error('Unsupported SUMO map sidecar');
  if (manifest.mapId !== mapId) throw new Error(`SUMO sidecar belongs to ${manifest.mapId}, not ${mapId}`);
  if (!manifest.networkFile || !manifest.sha256 || manifest.routeCandidates.length === 0) {
    throw new Error(`SUMO sidecar for ${mapId} is incomplete`);
  }
}

export function validateSumoRuntimeManifest(manifest: SumoRuntimeManifest): void {
  if (manifest.schema !== 'uniscenarios.sumo-runtime.v1' || manifest.sumoVersion !== '1.27.1') {
    throw new Error('Unsupported SUMO browser runtime');
  }
  if (!manifest.licenseNotice || !manifest.sourceOffer || !(manifest.wasmBytes > 0)) {
    throw new Error('SUMO runtime compliance metadata is incomplete');
  }
}

/**
 * MurmurHash3's 32-bit finalizer: FNV-1a leaves its high bits nearly equal for
 * ids that differ only in a trailing digit, and the class draw reads the high
 * bits. Integer-only (`Math.imul`), identical on every engine.
 */
function mix32(value: number): number {
  let hash = value >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function deterministicShuffle<T>(items: readonly T[], seed: number): T[] {
  const copy = [...items];
  let state = seed || 1;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = Math.imul(state ^ state >>> 15, 1 | state);
    state ^= state + Math.imul(state ^ state >>> 7, 61 | state);
    const next = ((state ^ state >>> 14) >>> 0) % (index + 1);
    [copy[index], copy[next]] = [copy[next]!, copy[index]!];
  }
  return copy;
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
