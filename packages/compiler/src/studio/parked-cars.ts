/**
 * Baked parked cars, as the editor reads them off a document's extension bag.
 *
 * Turning them into simulation actors is native
 * (`EngineRuntime.studioConcreteInput`, `simforge_compiler::studio_refinements`),
 * so the editor, the host and the compiler cannot drift apart. This module keeps
 * the reader the editor's parking UI uses.
 */

export const PARKED_CARS_EXTENSION_KEY = "studio.ambientTraffic.parkedCars.v1";

/** Id prefix every baked parked car carries. */
export const PARKED_CAR_ID_PREFIX = "parked:";

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
