import type { NativeTextureMemberSource } from './texture-profile.js';

/**
 * The map's street luminaire derivative (`derived/luminaires/manifest.json`,
 * schema `simforge.map-luminaires.v1`, built at ingest by
 * `@simforge-oss/map-pipeline` `buildLuminaires`,
 * docs/engineering/map-luminaires.md). The worker hands its fixtures to the
 * service as `lighting.night.fixtures`; the service lights the nearest ones
 * (a bounded pool of point lights) once the sun is below the luminaires'
 * switch-on elevation.
 */
export const NATIVE_LUMINAIRES_MANIFEST = 'derived/luminaires/manifest.json';
const LUMINAIRES_SCHEMA = 'simforge.map-luminaires.v1';

/** Sun elevation at or below which the service turns luminaires on (render-core `NIGHT_SOURCES_ELEVATION_DEG`). */
export const NATIVE_LUMINAIRES_ON_ELEVATION_DEG = -3;

/** One fixture as the service's `NightFixture` reads it (photometry at the calibrated defaults). */
export interface NativeNightFixture {
  readonly source_id: string;
  readonly source_name: string;
  readonly position: readonly [number, number, number];
  readonly heading_rad: number;
  readonly rule: string;
}

export interface NativeLuminairesPlan {
  readonly members: readonly string[];
  readonly manifestSha256: string;
  readonly buildKey: string;
  readonly fixtures: readonly NativeNightFixture[];
}

/**
 * `undefined` when the map carries no derivative (a night render then warns:
 * `night_luminaires_absent`). A derivative from another master, or malformed,
 * is an error.
 */
export async function planNativeLuminaires(source: NativeTextureMemberSource): Promise<NativeLuminairesPlan | undefined> {
  const manifestSha256 = source.sha256(NATIVE_LUMINAIRES_MANIFEST);
  if (!manifestSha256) return undefined;
  let manifest: { schema?: unknown; buildKey?: unknown; fixtures?: unknown; source?: { master?: { path?: unknown; sha256?: unknown } } };
  try {
    manifest = JSON.parse(await source.readText(NATIVE_LUMINAIRES_MANIFEST)) as typeof manifest;
  } catch (error) {
    throw new Error(`native_luminaires_invalid: ${NATIVE_LUMINAIRES_MANIFEST} is not JSON (${(error as Error).message})`);
  }
  if (manifest.schema !== LUMINAIRES_SCHEMA) throw new Error(`native_luminaires_invalid: schema ${String(manifest.schema)} (${LUMINAIRES_SCHEMA})`);
  if (typeof manifest.buildKey !== 'string') throw new Error('native_luminaires_invalid: no buildKey');
  if (!Array.isArray(manifest.fixtures)) throw new Error('native_luminaires_invalid: fixtures');
  const master = manifest.source?.master;
  if (master?.path !== 'master.gltf' || master.sha256 !== source.sha256('master.gltf')) {
    throw new Error('native_luminaires_master_mismatch: the derivative was built from another master.gltf');
  }
  const fixtures = manifest.fixtures.map((value, index): NativeNightFixture => {
    const f = value as { sourceId?: unknown; sourceName?: unknown; position?: unknown; headingRad?: unknown; rule?: unknown };
    const position = f.position as number[] | undefined;
    if (typeof f.sourceId !== 'string' || !Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite)
      || typeof f.headingRad !== 'number' || !Number.isFinite(f.headingRad)) {
      throw new Error(`native_luminaires_invalid: fixture ${index}`);
    }
    return {
      source_id: f.sourceId,
      source_name: typeof f.sourceName === 'string' ? f.sourceName : f.sourceId,
      position: [position[0]!, position[1]!, position[2]!],
      heading_rad: f.headingRad,
      rule: typeof f.rule === 'string' ? f.rule : '',
    };
  });
  return { members: [NATIVE_LUMINAIRES_MANIFEST], manifestSha256, buildKey: manifest.buildKey, fixtures };
}

/**
 * The fixtures in the order the service activates them before it has a
 * camera pose (it lights the first `fixture_budget` of the list, then
 * re-sorts by distance to the camera on each relight): nearest first to the
 * job's camera path (closest approach over every scheduled camera eye), ties
 * by source id. `observer` is the first camera eye.
 */
export function orderNativeFixtures(
  fixtures: readonly NativeNightFixture[],
  eyes: readonly (readonly [number, number, number])[],
): { fixtures: NativeNightFixture[]; observer: [number, number, number] | undefined } {
  const closest = (f: NativeNightFixture): number => {
    let best = Infinity;
    for (const eye of eyes) {
      const d = (f.position[0] - eye[0]) ** 2 + (f.position[1] - eye[1]) ** 2 + (f.position[2] - eye[2]) ** 2;
      if (d < best) best = d;
    }
    return best;
  };
  const keyed = fixtures.map((fixture) => ({ fixture, distance: closest(fixture) }));
  keyed.sort((a, b) => a.distance - b.distance || (a.fixture.source_id < b.fixture.source_id ? -1 : a.fixture.source_id > b.fixture.source_id ? 1 : 0));
  const first = eyes[0];
  return { fixtures: keyed.map((entry) => entry.fixture), observer: first ? [first[0], first[1], first[2]] : undefined };
}
