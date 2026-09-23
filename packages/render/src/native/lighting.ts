
import type { Environment, TimeOfDay, Weather } from '@simforge-oss/scenario';
import {
  EnvironmentExtensionError,
  LIGHTING_EXTENSION_KEY,
  parseRenderLightingOverrides,
  parseRenderSceneMinutes,
  sceneClockSunAngles,
  type EditorLightingOverrides,
} from '@simforge-oss/scenario/contracts';

import { RenderInputError } from '../render-input-error.js';

/**
 * The scenario's environment as the native renderer's `Lighting` (the look
 * itself is the render config's preset; see `nativeRenderRequest`).
 *
 * This is the Lookdev Lab's `settings.renderer_lighting` for the platform:
 * the same weather presets, the same NOAA solar model at the corpus site. A campaign render of "cloudy at 19:55" is the lab's
 * "cloudy at 19:55". Every value the renderer would otherwise default is sent
 * explicitly, so the manifest names the look.
 *
 * The sun is placed at the map's own site (its OpenDRIVE `geoReference`) on
 * the scene clock, which is local civil time there. Nothing about the look is
 * silently substituted: a malformed extension block, an explicit sun the
 * renderer cannot place, weather it cannot draw or a site whose civil time is
 * unknown fails the render.
 */

/** Day of year the scene clock runs on: the scenario schema has no date, so this is the product's documented date. */
export const DEFAULT_DAY_OF_YEAR = 172;

/** Where and in which civil time the scene clock runs: the map origin. */
export interface NativeLightingSite {
  readonly latitudeDeg: number;
  readonly longitudeDeg: number;
  /** Civil UTC offset of the scene clock on {@link DEFAULT_DAY_OF_YEAR}. */
  readonly utcOffsetHours: number;
  readonly timeZone: string;
}

/**
 * Civil time zones the scene clock can run in, as the UTC offset they keep on
 * {@link DEFAULT_DAY_OF_YEAR} (summer: daylight time). A site outside every
 * zone is refused rather than given another zone's clock.
 */
const SITE_TIME_ZONES: readonly {
  readonly timeZone: string;
  readonly utcOffsetHours: number;
  readonly latitude: readonly [number, number];
  readonly longitude: readonly [number, number];
}[] = [
  // California, Oregon, Washington, Nevada.
  { timeZone: 'America/Los_Angeles (PDT)', utcOffsetHours: -7, latitude: [32.5, 49], longitude: [-124.8, -114] },
  // Germany, Austria, Switzerland, Benelux, Czechia, Poland, Denmark.
  { timeZone: 'Europe/Berlin (CEST)', utcOffsetHours: 2, latitude: [45.8, 55.1], longitude: [2.5, 24.2] },
];

/**
 * The lighting site of a map from its OpenDRIVE header: the transverse
 * Mercator origin (`+lat_0`, `+lon_0`) every SimForge map is georeferenced
 * with, and the civil zone that contains it (`native_lighting_site_unknown`
 * when either is missing).
 */
export function nativeLightingSiteFromOpenDrive(xodr: string, mapId: string): NativeLightingSite {
  const geoReference = /<geoReference>\s*(?:<!\[CDATA\[)?([^<\]]*)(?:\]\]>)?\s*<\/geoReference>/u.exec(xodr)?.[1]?.trim();
  if (!geoReference) {
    throw new RenderInputError('native_lighting_site_unknown', `map ${mapId} has no OpenDRIVE geoReference; the sun cannot be placed`);
  }
  const parameter = (name: string): number | undefined => {
    const match = new RegExp(`(?:^|\\s)\\+${name}=(-?[0-9.]+)(?:\\s|$)`, 'u').exec(geoReference);
    const value = match ? Number(match[1]) : Number.NaN;
    return Number.isFinite(value) ? value : undefined;
  };
  const latitudeDeg = parameter('lat_0');
  const longitudeDeg = parameter('lon_0');
  if (!/(?:^|\s)\+proj=tmerc(?:\s|$)/u.test(geoReference) || latitudeDeg === undefined || longitudeDeg === undefined
    || Math.abs(latitudeDeg) > 90 || Math.abs(longitudeDeg) > 180) {
    throw new RenderInputError('native_lighting_site_unknown', `map ${mapId} geoReference "${geoReference}" is not a transverse Mercator origin with +lat_0/+lon_0`);
  }
  const zone = SITE_TIME_ZONES.find((candidate) =>
    latitudeDeg >= candidate.latitude[0] && latitudeDeg <= candidate.latitude[1]
    && longitudeDeg >= candidate.longitude[0] && longitudeDeg <= candidate.longitude[1]);
  if (!zone) {
    throw new RenderInputError('native_lighting_site_unknown', `map ${mapId} lies at ${latitudeDeg}, ${longitudeDeg}, where the scene clock has no known civil time zone`);
  }
  return { latitudeDeg, longitudeDeg, utcOffsetHours: zone.utcOffsetHours, timeZone: zone.timeZone };
}

/** Renderer weather label (`render_core::weather::Weather`). */
export type NativeWeather = 'clear' | 'cloudy' | 'overcast' | 'fog' | 'rain';

export interface WeatherPreset {
  readonly weather: NativeWeather;
  readonly cloudCover: number;
  readonly visibilityM: number;
  readonly haze: number;
  readonly wetness: number;
  readonly turbidity: number;
  readonly cloudType: number;
  readonly cloudBaseM: number;
  readonly cloudTopM: number;
  readonly cloudDensity: number;
}

/** The lab's `WEATHER_PRESETS`, keyed by renderer label. */
export const WEATHER_PRESETS: Readonly<Record<NativeWeather, WeatherPreset>> = {
  clear: { weather: 'clear', cloudCover: 0, visibilityM: 80_000, haze: 0, wetness: 0, turbidity: 2.4, cloudType: 0.85, cloudBaseM: 1200, cloudTopM: 2800, cloudDensity: 1 },
  cloudy: { weather: 'cloudy', cloudCover: 0.45, visibilityM: 30_000, haze: 0.03, wetness: 0, turbidity: 2.8, cloudType: 0.85, cloudBaseM: 1200, cloudTopM: 2800, cloudDensity: 1 },
  overcast: { weather: 'overcast', cloudCover: 0.95, visibilityM: 12_000, haze: 0.10, wetness: 0.05, turbidity: 3.2, cloudType: 0.15, cloudBaseM: 700, cloudTopM: 1900, cloudDensity: 1.4 },
  fog: { weather: 'fog', cloudCover: 0.75, visibilityM: 150, haze: 0.20, wetness: 0.15, turbidity: 3.0, cloudType: 0.10, cloudBaseM: 400, cloudTopM: 1200, cloudDensity: 1.4 },
  rain: { weather: 'rain', cloudCover: 0.90, visibilityM: 3_000, haze: 0.10, wetness: 0.85, turbidity: 2.6, cloudType: 0.30, cloudBaseM: 500, cloudTopM: 2600, cloudDensity: 1.8 },
};

/**
 * Scenario weather → renderer label. The scenario has ten presets and the
 * renderer five air-mass states; the extra scenario presets are the renderer
 * state plus a wetness/visibility adjustment.
 */
export function weatherPreset(weather: Weather): WeatherPreset {
  switch (weather) {
    case 'clear': return WEATHER_PRESETS.clear;
    case 'cloudy': return WEATHER_PRESETS.cloudy;
    case 'overcast': return WEATHER_PRESETS.overcast;
    case 'light_rain': return { ...WEATHER_PRESETS.rain, cloudCover: 0.85, visibilityM: 8_000, wetness: 0.6 };
    case 'heavy_rain': return { ...WEATHER_PRESETS.rain, visibilityM: 1_500, wetness: 1 };
    case 'wet_road': return { ...WEATHER_PRESETS.overcast, wetness: 0.7 };
    case 'fog_light': return { ...WEATHER_PRESETS.fog, cloudCover: 0.6, visibilityM: 600, wetness: 0.1 };
    case 'fog_dense': return WEATHER_PRESETS.fog;
    // The renderer has no falling snow, sleet or snow cover: drawing an
    // overcast wet road instead would render a different scenario.
    case 'snow':
    case 'sleet':
      throw new RenderInputError('native_weather_unsupported', `the native renderer cannot draw ${weather}`);
  }
}

/** Studio's slider minutes for a time-of-day preset (`scene-time.ts`). */
export const PRESET_MINUTES: Readonly<Record<TimeOfDay, number>> = {
  dawn: 6 * 60,
  morning: 9 * 60,
  noon: 12 * 60,
  afternoon: 15 * 60,
  dusk: 18 * 60,
  night: 0,
  night_lit: 21 * 60,
};

function environmentExtension<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof EnvironmentExtensionError) {
      throw new RenderInputError('render_environment_extension_invalid', `scenario environment extension ${error.message}`, { extension: error.extension });
    }
    throw error;
  }
}

/**
 * Scene clock in local minutes past midnight: the exact authored time
 * (`org.simforge.sceneTime.v1`), else the time-of-day preset's documented
 * minutes. A malformed clock block fails (`render_environment_extension_invalid`).
 */
export function sceneMinutes(environment: Environment): number {
  const exact = environmentExtension(() => parseRenderSceneMinutes(environment));
  return exact ?? PRESET_MINUTES[environment.timeOfDay];
}

/**
 * NOAA low-precision solar position at `site`. Elevation and compass azimuth
 * in degrees; the lab's `solar_position`, to the same three decimals.
 */
export function solarPosition(
  timeMinutes: number,
  dayOfYear: number,
  site: Pick<NativeLightingSite, 'latitudeDeg' | 'longitudeDeg' | 'utcOffsetHours'>,
): { elevationDeg: number; azimuthDeg: number } {
  const gamma = 2 * Math.PI / 365 * (dayOfYear - 1 + (timeMinutes / 60 - 12) / 24);
  const eqtime = 229.18 * (
    0.000075
    + 0.001868 * Math.cos(gamma)
    - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma)
    - 0.040849 * Math.sin(2 * gamma)
  );
  const decl = 0.006918
    - 0.399912 * Math.cos(gamma)
    + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma)
    + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma)
    + 0.00148 * Math.sin(3 * gamma);
  const timeOffset = eqtime + 4 * site.longitudeDeg - 60 * site.utcOffsetHours;
  const trueSolar = timeMinutes + timeOffset;
  const hourAngle = (trueSolar / 4 - 180) * Math.PI / 180;
  const lat = site.latitudeDeg * Math.PI / 180;
  const cosZenith = Math.max(-1, Math.min(1,
    Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle)));
  const zenith = Math.acos(cosZenith);
  const elevation = 90 - zenith * 180 / Math.PI;
  const denom = Math.cos(lat) * Math.sin(zenith);
  let azimuth: number;
  if (Math.abs(denom) < 1e-9) {
    azimuth = 180;
  } else {
    const cosAz = Math.max(-1, Math.min(1, (Math.sin(lat) * cosZenith - Math.sin(decl)) / denom));
    azimuth = Math.acos(cosAz) * 180 / Math.PI;
    if (hourAngle > 0) azimuth = 360 - azimuth;
  }
  return {
    elevationDeg: Math.round(elevation * 1000) / 1000,
    azimuthDeg: Math.round((((azimuth % 360) + 360) % 360) * 1000) / 1000,
  };
}

/** `render_core::engine::Lighting`, wire form. */
export interface NativeLighting {
  readonly sun_elev_deg: number;
  readonly sun_azim_deg: number;
  readonly rung: 3;
  readonly weather: NativeWeather;
  readonly sun_scale: number;
  readonly ambient_scale: number;
  readonly sky_scale: number;
  readonly ev100_bias: number;
  readonly cloud_cover: number;
  readonly haze: number;
  readonly wetness: number;
  readonly atmosphere: true;
  readonly turbidity: number;
  readonly ozone_du: number;
  readonly air_density: number;
  readonly visibility_m: number;
  readonly night: {
    readonly utc_year: number;
    readonly utc_day_of_year: number;
    readonly utc_minutes: number;
    readonly latitude_deg: number;
    readonly longitude_deg: number;
    readonly elevation_m: number;
    readonly natural_ambient_lux: number;
    readonly urban_skyglow_lux: number;
    readonly limiting_magnitude: number;
    readonly fixture_budget: number;
    readonly fixture_shadow_budget: number;
    readonly window_mode: 'synthetic_facade';
    readonly cloud_quality: 'scalable';
    readonly cloud_wind_mps: readonly [number, number];
    readonly cloud_density: number;
    readonly cloud_type: number;
    readonly cloud_base_m: number;
    readonly cloud_top_m: number;
    readonly sky_display_lift: number;
    readonly exposure_offset_stops: number;
    readonly sky_debug_mode: 0;
    /** Cloud clock advance per render, s: the lab's clip setting at 30 fps. */
    readonly cloud_fixed_step_s: number;
  };
}

export interface NativeLightingResolution {
  readonly lighting: NativeLighting;
  /** What the mapping decided, for the render manifest. */
  readonly provenance: {
    readonly weather: Weather;
    readonly preset: NativeWeather;
    readonly sceneMinutes: number;
    readonly dayOfYear: number;
    readonly sunSource: 'solar-model';
    readonly site: NativeLightingSite;
    readonly overrides: Readonly<Record<string, number>>;
  };
}

/**
 * Authored sun angles the renderer cannot honour: azimuth is corridor-relative
 * (`environment.sunAzimuthDeg`) and the render has no corridor frame to place
 * it in. Angles Studio derived from the scene clock (`sceneClockSunAngles`)
 * are the clock's shadow, not a sun of their own, and the solar model places
 * that clock's sun.
 */
function assertNoExplicitSun(environment: Environment, exactMinutes: number | null): void {
  const { sunAzimuthDeg: azimuth, sunElevationDeg: elevation } = environment;
  if (azimuth === undefined && elevation === undefined) return;
  if (exactMinutes !== null) {
    const derived = sceneClockSunAngles(exactMinutes);
    if (typeof azimuth === 'number' && typeof elevation === 'number'
      && Math.abs(azimuth - derived.azimuthDeg) < 1e-6 && Math.abs(elevation - derived.elevationDeg) < 1e-6) {
      return;
    }
  }
  throw new RenderInputError(
    'native_lighting_sun_override_unsupported',
    `the scenario authors its own sun (azimuth ${JSON.stringify(azimuth)} deg corridor-relative, elevation ${JSON.stringify(elevation)} deg); the native renderer places the sun from the scene clock and cannot resolve a corridor-relative azimuth`,
  );
}

/**
 * Resolve a scenario environment into the renderer's lighting.
 *
 * The sun comes from the solar model at the scene clock and the map's site —
 * the same NOAA position the lab uses. Sun angles the scenario authors
 * explicitly are refused (`native_lighting_sun_override_unsupported`), not
 * overwritten. Studio's lighting block (`org.simforge.lighting.v1`) is
 * honoured as the lab's normalized knobs: `sun`/`ambient`/`sky` scale the
 * resolved sources, `exposure` is a bias on the meter, `visibilityM` and
 * `haze` replace the preset's air. `sunWarmth` has no counterpart under the
 * physical atmosphere: a non-neutral value is refused.
 */
export function resolveNativeLighting(
  environment: Environment,
  options: { readonly site: NativeLightingSite; readonly dayOfYear?: number; readonly cloudFixedStepS?: number },
): NativeLightingResolution {
  const preset = weatherPreset(environment.weather);
  const exactMinutes = environmentExtension(() => parseRenderSceneMinutes(environment));
  const minutes = exactMinutes ?? PRESET_MINUTES[environment.timeOfDay];
  assertNoExplicitSun(environment, exactMinutes);
  const site = options.site;
  const dayOfYear = options.dayOfYear ?? DEFAULT_DAY_OF_YEAR;
  const sun = solarPosition(minutes, dayOfYear, site);
  const overrides: EditorLightingOverrides = environmentExtension(() => parseRenderLightingOverrides(environment));
  if (overrides.sunWarmth !== undefined && overrides.sunWarmth !== 0) {
    throw new RenderInputError('native_lighting_sun_warmth_unsupported', `authored sunWarmth ${overrides.sunWarmth} has no counterpart in the native renderer's physical sun`);
  }
  const utcMinutes = (((minutes - 60 * site.utcOffsetHours) % 1440) + 1440) % 1440;
  const utcDayShift = Math.floor((minutes - 60 * site.utcOffsetHours) / 1440);
  const utcDay = 1 + ((((dayOfYear - 1 + utcDayShift) % 365) + 365) % 365);
  const lighting: NativeLighting = {
    sun_elev_deg: sun.elevationDeg,
    sun_azim_deg: sun.azimuthDeg,
    rung: 3,
    weather: preset.weather,
    sun_scale: overrides.sun ?? 1,
    ambient_scale: overrides.ambient ?? 1,
    sky_scale: overrides.sky ?? 1,
    // Studio's `exposure` is a linear multiplier on the picture; the
    // renderer's bias is in stops on EV100, where positive darkens.
    ev100_bias: overrides.exposure === undefined ? 0 : -Math.log2(overrides.exposure),
    cloud_cover: preset.cloudCover,
    haze: overrides.haze ?? preset.haze,
    wetness: preset.wetness,
    atmosphere: true,
    turbidity: preset.turbidity,
    ozone_du: 300,
    air_density: 1,
    visibility_m: overrides.visibilityM ?? preset.visibilityM,
    night: {
      utc_year: 2026,
      utc_day_of_year: utcDay,
      utc_minutes: utcMinutes,
      latitude_deg: site.latitudeDeg,
      longitude_deg: site.longitudeDeg,
      elevation_m: 15,
      natural_ambient_lux: 0.002,
      urban_skyglow_lux: 0.05,
      limiting_magnitude: 6.5,
      fixture_budget: 12,
      fixture_shadow_budget: 0,
      window_mode: 'synthetic_facade',
      cloud_quality: 'scalable',
      cloud_wind_mps: [12, 4],
      cloud_density: preset.cloudDensity,
      cloud_type: preset.cloudType,
      cloud_base_m: preset.cloudBaseM,
      cloud_top_m: preset.cloudTopM,
      sky_display_lift: 120,
      exposure_offset_stops: 0,
      sky_debug_mode: 0,
      cloud_fixed_step_s: options.cloudFixedStepS ?? 1 / 30,
    },
  };
  return {
    lighting,
    provenance: {
      weather: environment.weather,
      preset: preset.weather,
      sceneMinutes: minutes,
      dayOfYear,
      sunSource: 'solar-model',
      site,
      overrides: Object.fromEntries(
        Object.entries(overrides).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
      ),
    },
  };
}

export { LIGHTING_EXTENSION_KEY };
