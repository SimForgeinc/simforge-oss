import { describe, expect, it } from 'vitest';

import { simContentHash, simulationRelevantContent } from '../sim-content-hash.js';
import { ltapTemplate } from './v2-fixtures.js';

const withMeta = (patch: Record<string, unknown>) => {
  const template = ltapTemplate();
  return { ...template, meta: { ...template.meta, ...patch } };
};

describe('simContentHash', () => {
  it('is a sha256 hex digest and stable', () => {
    const hash = simContentHash(ltapTemplate());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(simContentHash(ltapTemplate())).toBe(hash);
  });

  it('ignores timestamps, app version, description, tags and author', () => {
    const base = simContentHash(ltapTemplate());
    expect(simContentHash(withMeta({ modifiedAt: '2027-01-01T00:00:00.000Z', createdAt: '2020-01-01T00:00:00.000Z' }))).toBe(base);
    expect(simContentHash(withMeta({ appVersion: '9.9.9', description: 'new words', tags: ['x'], author: 'someone' }))).toBe(base);
  });

  it('keeps the name while the seed is derived from it, drops it once the seed is pinned', () => {
    // Unpinned: the compiler seeds from the template id, which falls back to meta.name.
    expect(simContentHash(withMeta({ name: 'Renamed' }))).not.toBe(simContentHash(ltapTemplate()));
    const pinned = (name: string) => ({ ...withMeta({ name }), simulation: { seed: 'seed-1', dtS: 0.02 } });
    expect(simContentHash(pinned('A'))).toBe(simContentHash(pinned('B')));
    expect(simContentHash({ ...pinned('A'), simulation: { seed: 'seed-2', dtS: 0.02 } })).not.toBe(simContentHash(pinned('A')));
  });

  it('ignores top-level presentation extensions but not simulation extensions', () => {
    const template = ltapTemplate();
    const base = simContentHash(template);
    expect(simContentHash({ ...template, extensions: { 'studio.presentation.cameras.v1': { a: 1 } } })).toBe(base);
    expect(simContentHash({ ...template, extensions: { 'studio.ambientTraffic.profile.v1': { preset: 'city' } } })).not.toBe(base);
  });

  it('changes when simulation content changes', () => {
    const template = ltapTemplate();
    expect(simContentHash({ ...template, roles: template.roles.slice(1) })).not.toBe(simContentHash(template));
  });

  it('hashes values on the storage grid, so a saved-and-reloaded document hashes the same', () => {
    const template = ltapTemplate();
    const noisy = { ...template, extensions: { 'x.value': 0.1 + 0.2 } };
    const saved = { ...template, extensions: { 'x.value': 0.3 } };
    expect(simContentHash(noisy)).toBe(simContentHash(saved));
  });

  it('does not mutate its input', () => {
    const template = withMeta({ name: 'Keep' });
    const snapshot = JSON.stringify(template);
    simulationRelevantContent({ ...template, simulation: { seed: 's', dtS: 0.02 } });
    expect(JSON.stringify(template)).toBe(snapshot);
  });
});
