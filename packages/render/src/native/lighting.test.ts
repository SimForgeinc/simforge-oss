import { describe, expect, it } from 'vitest';

import type { Environment } from '@simforge-oss/scenario';
import { LIGHTING_EXTENSION_KEY, SCENE_TIME_EXTENSION_KEY, sceneClockSunAngles } from '@simforge-oss/scenario/contracts';

import {
  nativeLightingSiteFromOpenDrive, resolveNativeLighting, sceneMinutes, solarPosition, weatherPreset,
  type NativeLightingSite,
} from './lighting.js';

const BASE: Environment = { weather: 'clear', timeOfDay: 'dawn', surfacePatches: [] };
/** The Lookdev Lab's corpus site, `lab/server/settings.py::SITE_*`. */
const LAB_SITE: NativeLightingSite = { latitudeDeg: 37.44, longitudeDeg: -122.14, utcOffsetHours: -7, timeZone: 'America/Los_Angeles (PDT)' };
const at = (environment: Environment) => resolveNativeLighting(environment, { site: LAB_SITE });

function xodr(geoReference: string): string {
  return `<?xml version="1.0"?><OpenDRIVE><header revMajor="1" revMinor="6"><geoReference><![CDATA[${geoReference}]]></geoReference></header></OpenDRIVE>`;
}

describe('native lighting', () => {
  it('matches the lab solar model at the canonical hours', () => {
    // lab/server/settings.py::solar_position on day 172.
    expect(solarPosition(385, 172, LAB_SITE)).toEqual({ elevationDeg: 5.758, azimuthDeg: 115.248 });
    expect(solarPosition(720, 172, LAB_SITE)).toEqual({ elevationDeg: 69.511, azimuthDeg: 51.898 });
    expect(solarPosition(1195, 172, LAB_SITE)).toEqual({ elevationDeg: 5.724, azimuthDeg: 244.72 });
    expect(solarPosition(0, 172, LAB_SITE)).toEqual({ elevationDeg: -26.938, azimuthDeg: 162.031 });
  });

  it('reads the exact scene clock, else the preset hour', () => {
    expect(sceneMinutes(BASE)).toBe(6 * 60);
    expect(sceneMinutes({ ...BASE, extensions: { [SCENE_TIME_EXTENSION_KEY]: { minutes: 1195 } } })).toBe(1195);
    expect(sceneMinutes({ ...BASE, timeOfDay: 'night_lit' })).toBe(21 * 60);
  });

  it('refuses a malformed scene clock instead of reading the preset hour', () => {
    expect(() => sceneMinutes({ ...BASE, extensions: { [SCENE_TIME_EXTENSION_KEY]: { minutes: 'noon' } } }))
      .toThrow(expect.objectContaining({ code: 'render_environment_extension_invalid' }));
    expect(() => sceneMinutes({ ...BASE, extensions: { [SCENE_TIME_EXTENSION_KEY]: 385 } }))
      .toThrow(expect.objectContaining({ code: 'render_environment_extension_invalid' }));
  });

  it('is the lab default for a fresh scenario', () => {
    const { lighting, provenance } = at({ ...BASE, extensions: { [SCENE_TIME_EXTENSION_KEY]: { minutes: 385 } } });
    expect(lighting).toMatchObject({
      sun_elev_deg: 5.758, sun_azim_deg: 115.248, weather: 'clear', atmosphere: true,
      visibility_m: 80_000, turbidity: 2.4, cloud_cover: 0, haze: 0, wetness: 0,
      sun_scale: 1, ambient_scale: 1, ev100_bias: 0,
    });
    expect(lighting.night).toMatchObject({
      utc_minutes: 805, utc_day_of_year: 172, cloud_type: 0.85, cloud_base_m: 1200, cloud_top_m: 2800,
      latitude_deg: 37.44, longitude_deg: -122.14,
      window_mode: 'synthetic_facade', cloud_quality: 'scalable', sky_display_lift: 120,
    });
    expect(provenance.site).toEqual(LAB_SITE);
  });

  it('maps every drawable scenario weather onto a renderer air mass', () => {
    expect(weatherPreset('cloudy')).toMatchObject({ weather: 'cloudy', cloudCover: 0.45, visibilityM: 30_000 });
    expect(weatherPreset('heavy_rain')).toMatchObject({ weather: 'rain', wetness: 1, visibilityM: 1_500 });
    expect(weatherPreset('fog_dense')).toMatchObject({ weather: 'fog', visibilityM: 150 });
  });

  it('refuses snow and sleet instead of drawing an overcast sky', () => {
    expect(() => weatherPreset('snow')).toThrow(expect.objectContaining({ code: 'native_weather_unsupported' }));
    expect(() => at({ ...BASE, weather: 'sleet' })).toThrow(expect.objectContaining({ code: 'native_weather_unsupported' }));
  });

  it('honours the Studio lighting block as the lab knobs', () => {
    const { lighting, provenance } = at({
      ...BASE,
      weather: 'cloudy',
      extensions: {
        [LIGHTING_EXTENSION_KEY]: { scaleRevision: 2, sun: 1.5, ambient: 0.5, exposure: 2, visibilityM: 4_000, haze: 0.2 },
      },
    });
    expect(lighting).toMatchObject({
      sun_scale: 1.5, ambient_scale: 0.5, ev100_bias: -1, visibility_m: 4_000, haze: 0.2, weather: 'cloudy',
    });
    expect(provenance.overrides).toEqual({ sun: 1.5, ambient: 0.5, exposure: 2, visibilityM: 4_000, haze: 0.2 });
  });

  it('refuses a lighting block it would otherwise drop or clamp', () => {
    const block = (value: unknown): Environment => ({ ...BASE, extensions: { [LIGHTING_EXTENSION_KEY]: value } });
    for (const invalid of [
      { sun: 1.5 }, // no scale revision: a pre-rev23 block
      { scaleRevision: 1, sun: 1.5 },
      { scaleRevision: 2, sun: 'bright' },
      { scaleRevision: 2, sun: 9 }, // above LIGHTING_RANGES.sun.max
      { scaleRevision: 2, exposre: 2 },
      'sunny',
    ]) {
      expect(() => at(block(invalid)), JSON.stringify(invalid)).toThrow(expect.objectContaining({ code: 'render_environment_extension_invalid' }));
    }
  });

  it('refuses a non-neutral sunWarmth it cannot apply', () => {
    expect(() => at({ ...BASE, extensions: { [LIGHTING_EXTENSION_KEY]: { scaleRevision: 2, sunWarmth: 0.4 } } }))
      .toThrow(expect.objectContaining({ code: 'native_lighting_sun_warmth_unsupported' }));
    expect(at({ ...BASE, extensions: { [LIGHTING_EXTENSION_KEY]: { scaleRevision: 2, sunWarmth: 0 } } }).lighting.sun_scale).toBe(1);
  });

  it('places the clock sun when the authored angles are the clock\'s own, and refuses an explicit sun', () => {
    const clock = { [SCENE_TIME_EXTENSION_KEY]: { minutes: 385 } };
    const derived = sceneClockSunAngles(385);
    const shadowed = at({ ...BASE, sunAzimuthDeg: derived.azimuthDeg, sunElevationDeg: derived.elevationDeg, extensions: clock });
    expect(shadowed.lighting.sun_elev_deg).toBe(5.758);
    expect(() => at({ ...BASE, sunAzimuthDeg: 90, sunElevationDeg: 4, extensions: clock }))
      .toThrow(expect.objectContaining({ code: 'native_lighting_sun_override_unsupported' }));
    expect(() => at({ ...BASE, sunElevationDeg: 4 }))
      .toThrow(expect.objectContaining({ code: 'native_lighting_sun_override_unsupported' }));
  });

  it('rolls the UTC day past midnight PDT', () => {
    const { lighting } = at({ ...BASE, extensions: { [SCENE_TIME_EXTENSION_KEY]: { minutes: 1380 } } });
    expect(lighting.night.utc_minutes).toBe(360);
    expect(lighting.night.utc_day_of_year).toBe(173);
  });

  it('rolls the UTC day back before midnight in a zone east of Greenwich', () => {
    const berlin: NativeLightingSite = { latitudeDeg: 48.26, longitudeDeg: 11.65, utcOffsetHours: 2, timeZone: 'Europe/Berlin (CEST)' };
    const { lighting } = resolveNativeLighting({ ...BASE, extensions: { [SCENE_TIME_EXTENSION_KEY]: { minutes: 60 } } }, { site: berlin });
    expect(lighting.night.utc_minutes).toBe(1380);
    expect(lighting.night.utc_day_of_year).toBe(171);
  });

  it('takes the site from the map georeference, never a fixed corpus site', () => {
    const richmond = nativeLightingSiteFromOpenDrive(xodr('+proj=tmerc +lat_0=37.9150891287087 +lon_0=-122.333308830857 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +vunits=m +no_defs'), 'richmond');
    expect(richmond).toEqual({ latitudeDeg: 37.9150891287087, longitudeDeg: -122.333308830857, utcOffsetHours: -7, timeZone: 'America/Los_Angeles (PDT)' });
    const garching = nativeLightingSiteFromOpenDrive(xodr('+proj=tmerc +lat_0=48.2554688997943 +lon_0=11.6522926105154 +k=1 +x_0=0 +y_0=0 +datum=WGS84'), 'garching');
    expect(garching).toMatchObject({ latitudeDeg: 48.2554688997943, utcOffsetHours: 2 });
    // Near local solar noon, Garching (48 N) sees a lower sun than Richmond (38 N).
    expect(solarPosition(13 * 60 + 15, 172, garching).elevationDeg).toBeLessThan(solarPosition(13 * 60 + 15, 172, richmond).elevationDeg);
  });

  it('refuses a map whose site or civil time it cannot resolve', () => {
    expect(() => nativeLightingSiteFromOpenDrive('<OpenDRIVE><header/></OpenDRIVE>', 'm'))
      .toThrow(expect.objectContaining({ code: 'native_lighting_site_unknown' }));
    expect(() => nativeLightingSiteFromOpenDrive(xodr('+proj=utm +zone=10 +datum=WGS84'), 'm'))
      .toThrow(expect.objectContaining({ code: 'native_lighting_site_unknown' }));
    expect(() => nativeLightingSiteFromOpenDrive(xodr('+proj=tmerc +lat_0=35.68 +lon_0=139.69'), 'tokyo'))
      .toThrow(expect.objectContaining({ code: 'native_lighting_site_unknown' }));
  });
});
