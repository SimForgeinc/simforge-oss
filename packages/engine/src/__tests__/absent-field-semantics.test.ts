/**
 * The ambient rules in SCENARIO_ABSENT_FIELD_SEMANTICS (@simforge-oss/scenario)
 * are what this package implements. Changing either side alone fails here;
 * changing the registry's meaning also fails `pnpm scenario:contract:check`
 * unless scenarioVersion is bumped.
 */

import { describe, expect, it } from 'vitest';

import { SCENARIO_ABSENT_FIELD_SEMANTICS } from '@simforge-oss/scenario';

import {
  AMBIENT_TRAFFIC_EXTENSION_KEY,
  ambientProfileMissingDefault,
  ambientTrafficProfileForDocument,
  resolveAmbientTrafficProfile,
  type AmbientTrafficProfile,
} from '../ambient/profile.js';

function meaning(id: string): { profile: AmbientTrafficProfile } {
  const entry = SCENARIO_ABSENT_FIELD_SEMANTICS.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`no absent-field semantic ${id}`);
  return entry.meaning as unknown as { profile: AmbientTrafficProfile };
}

describe('absent ambient profile semantics', () => {
  it('names the extension key the engine reads', () => {
    for (const id of ['ambient.profile.legacy', 'ambient.profile.pinned']) {
      const entry = SCENARIO_ABSENT_FIELD_SEMANTICS.find((candidate) => candidate.id === id)!;
      expect(entry.field).toBe(`extensions["${AMBIENT_TRAFFIC_EXTENSION_KEY}"]`);
    }
  });

  it('no simulation block: the legacy City profile', () => {
    expect(ambientProfileMissingDefault({})).toBe('legacy-city');
    expect(ambientTrafficProfileForDocument({})).toEqual(resolveAmbientTrafficProfile(meaning('ambient.profile.legacy').profile));
  });

  it('a simulation block: off', () => {
    const pinned = { simulation: { seed: 's', dtS: 0.02 } };
    expect(ambientProfileMissingDefault(pinned)).toBe('off');
    expect(ambientTrafficProfileForDocument(pinned)).toEqual(resolveAmbientTrafficProfile(meaning('ambient.profile.pinned').profile));
  });
});
