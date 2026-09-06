/**
 * The declared-fact vocabulary assertion.
 *
 * The defect being guarded against: `is_t_intersection` was declared in the
 * prior system's tool schema, aliased in three query paths, and written by zero
 * code paths — so every query that filtered on it returned nothing, forever,
 * silently. A declared key with no producer is a build failure here, and this
 * suite is what stops that check from rotting into a warning.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildMapIntel, buildMapIntelFromDir } from '../build/build.js';
import {
  assertDeclaredFactsProduced,
  DECLARED_FACT_KEYS,
  summariseFactKeys,
} from '../build/facts.js';
import {
  ALL_MAPS,
  DEV_ASSETS,
  devAssetsAvailable,
  miniYaleSources,
  straightRoadSources,
} from './helpers.js';

const build = buildMapIntel(miniYaleSources());

describe('declared fact vocabulary', () => {
  it('declares no duplicate keys', () => {
    const keys = DECLARED_FACT_KEYS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('names a producer for every declared key', () => {
    for (const spec of DECLARED_FACT_KEYS) {
      expect(spec.producedBy.length).toBeGreaterThan(0);
      expect(spec.description.length).toBeGreaterThan(10);
    }
  });

  it('produces every `always` key on the fixture', () => {
    const audit = summariseFactKeys(build.catalog.locations);
    expect(audit.missingAlways).toEqual([]);
  });

  it('emits values of the declared type', () => {
    const declared = new Map(DECLARED_FACT_KEYS.map((s) => [s.key, s]));
    for (const loc of build.catalog.locations) {
      for (const [key, value] of Object.entries(loc.facts)) {
        const spec = declared.get(key);
        if (!spec) continue; // adopted from the search index; foreign data
        if (spec.type === 'string[]') {
          expect(Array.isArray(value), `${key} on ${loc.handle}`).toBe(true);
        } else {
          expect(typeof value, `${key} on ${loc.handle}`).toBe(spec.type);
        }
      }
    }
  });

  it('keeps every fact value flat', () => {
    for (const loc of build.catalog.locations) {
      for (const [key, value] of Object.entries(loc.facts)) {
        const ok =
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean' ||
          (Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number'));
        expect(ok, `${key} on ${loc.handle} is not a flat value`).toBe(true);
      }
    }
  });

  it('fails the build when a host exists but no producer wrote an `always` key', () => {
    const junction = { type: 'junction' as const, anchor: { road: null }, facts: {} };
    expect(() => assertDeclaredFactsProduced('test', [junction])).toThrow(
      /declared fact keys with no producer: .*\barm_count\b/,
    );
  });

  it('does not require a key its host type is absent for', () => {
    const audit = summariseFactKeys([
      { type: 'junction', anchor: { road: null }, facts: { arm_count: 4 } },
    ]);
    const otherJunctionKeys = DECLARED_FACT_KEYS.filter(
      (s) =>
        s.scope === 'always' &&
        s.hosts !== 'anchored' &&
        s.hosts.includes('junction') &&
        s.key !== 'arm_count',
    ).map((s) => s.key);
    expect(audit.missingAlways).toEqual(otherJunctionKeys.sort());
    expect(audit.inapplicableAlways).toContain('turn_relation');
    expect(audit.inapplicableAlways).toContain('lanes_same_dir');
    expect(audit.inapplicableAlways).toContain('anchor_distance_m');
  });

  it('emits fact keys in sorted order', () => {
    for (const loc of build.catalog.locations) {
      const keys = Object.keys(loc.facts);
      expect(keys).toEqual([...keys].sort());
    }
  });
});

describe('a valid map with no junction', () => {
  const straight = buildMapIntel(straightRoadSources());

  it('compiles real corridor topology instead of failing the fact audit', () => {
    expect(straight.derived.junctions).toEqual([]);
    expect(straight.derived.segments.length).toBeGreaterThan(0);
    const midblocks = straight.catalog.locations.filter((l) => l.type === 'midblock_segment');
    expect(midblocks.length).toBeGreaterThan(0);
    expect(straight.catalog.locations.some((l) => l.type === 'junction')).toBe(false);
    for (const loc of midblocks) {
      expect(loc.facts['lanes_same_dir']).toBe(1);
      expect(loc.facts['lanes_opposing']).toBe(1);
      expect(loc.facts['is_one_way']).toBe(false);
      expect(loc.facts['distance_to_junction_m']).toBe(-1);
      expect(loc.facts['segment_length_m']).toBe(200);
      expect(
        (loc.facts['runway_upstream_m'] as number) + (loc.facts['runway_downstream_m'] as number),
      ).toBeCloseTo(200, 1);
      expect(loc.facts['road_name']).toBe('Long Straight');
    }
    expect(straight.derived.factIndex.locationsByType['midblock_segment']).toHaveLength(
      midblocks.length,
    );
  });

  it('reports junction and movement keys as inapplicable, and corridor keys as produced', () => {
    expect(straight.audit.missingAlways).toEqual([]);
    expect(straight.audit.inapplicableAlways).toEqual(
      DECLARED_FACT_KEYS.filter(
        (s) =>
          s.scope === 'always' &&
          s.hosts !== 'anchored' &&
          !s.hosts.some((t) => t === 'midblock_segment' || t === 'work_zone_suitable'),
      )
        .map((s) => s.key)
        .sort(),
    );
    expect(straight.audit.produced).toContain('runway_downstream_m');
    expect(straight.audit.produced).toContain('anchor_heading_deg');
  });
});

describe.skipIf(!devAssetsAvailable())('declared facts across every real map', () => {
  // Builds all five real maps; ~4-6 s on this machine, over vitest's 5 s default.
  it('produces every declared key on at least one map, and every `always` key on all of them', { timeout: 30_000 }, async () => {
    const producedAnywhere = new Set<string>();
    for (const mapId of ALL_MAPS) {
      const built = await buildMapIntelFromDir(path.join(DEV_ASSETS, mapId));
      // `assertDeclaredFactsProduced` already ran inside the build; re-asserting
      // here documents the per-map contract explicitly.
      expect(built.audit.missingAlways, mapId).toEqual([]);
      for (const key of built.audit.produced) producedAnywhere.add(key);
    }
    const neverProduced = DECLARED_FACT_KEYS.filter((s) => !producedAnywhere.has(s.key)).map(
      (s) => s.key,
    );
    expect(neverProduced).toEqual([]);
  });
});
