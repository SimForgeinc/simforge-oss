import { describe, expect, it } from 'vitest';
import { buildMapIntel } from '../build/build.js';
import { straightRoadSources } from './helpers.js';

describe('parked-row occlusion supply', () => {
  it('admits dimensioned XODR parking rows but never remote parking or dimensionless points', () => {
    const sources = straightRoadSources();
    sources.mapGeojson = { type: 'FeatureCollection', features: [0, 6, 12].map((x) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: sources.frame.localToWgs84(x, -5) },
      properties: { Type: 'parkingSpace', Id: `bay-${x}`, hdg: 0, length: 5, width: 2 },
    })) };
    const locations = buildMapIntel(sources).catalog.locations;
    const zones = locations.filter((location) => location.type === 'occlusion_zone');
    for (const bay of locations.filter((location) => location.type === 'parking_space')) expect(bay.facts).not.toHaveProperty('entry_heading_deg');
    expect(zones).toHaveLength(1);
    expect(zones[0]!.anchor.road?.rsl).toBe('1:0:-1');
    expect(zones[0]!.facts.sightline_blocked).toBe(true);
    expect(zones[0]!.facts.row_exit_sightline_clear).toBe(true);
    const reversed = structuredClone(sources.mapGeojson);
    reversed.features.reverse();
    expect(buildMapIntel({ ...sources, mapGeojson: reversed }).catalog.locations.filter((location) => location.type === 'occlusion_zone').map((location) => location.id)).toEqual(zones.map((zone) => zone.id));
    for (const feature of sources.mapGeojson.features) feature.geometry.coordinates = sources.frame.localToWgs84(0, -50);
    expect(buildMapIntel(sources).catalog.locations.some((location) => location.type === 'occlusion_zone')).toBe(false);
    for (const feature of reversed.features) delete feature.properties.length;
    expect(buildMapIntel({ ...sources, mapGeojson: reversed }).catalog.locations.some((location) => location.type === 'occlusion_zone')).toBe(false);
  });
});
