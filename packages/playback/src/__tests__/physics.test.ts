import { describe, expect, it } from 'vitest';
import { parseSimScenarioInput } from '@simforge-oss/engine';
import { physicsSummaryForAuthoredActors, withEditablePhysicsDefault } from '../physics';

describe('Studio physics migration', () => {
  const legacy = parseSimScenarioInput({
    actors: [{
      id: 'car', kind: 'car',
      initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 0 },
      behavior: { route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 100, z: 0 }] } },
    }],
  });

  it('pins an omitted editable document to dynamic-v1 without mutating the source', () => {
    const migrated = withEditablePhysicsDefault(legacy);
    expect(legacy.physics).toBeUndefined();
    expect(migrated.physics).toEqual({ mode: 'dynamic-v1' });
    expect(withEditablePhysicsDefault(migrated)).toBe(migrated);
  });

  it('migrates a document that pinned the removed kinematic backend', () => {
    const pinned = parseSimScenarioInput({
      physics: { mode: 'kinematic-v1' },
      actors: [{
        id: 'car', kind: 'car',
        initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 0 },
        behavior: { route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 100, z: 0 }] } },
      }],
    });
    expect(pinned.physics).toEqual({ mode: 'dynamic-v1' });
    expect(withEditablePhysicsDefault(pinned)).toBe(pinned);
  });

  it('classifies authored actors without changing authored data', () => {
    const actors = [
      { id: 'car', simulationKind: 'car', static: false },
      { id: 'ped', simulationKind: 'pedestrian', static: false },
      { id: 'parked', simulationKind: 'static_object', static: true },
    ] as const;
    const before = JSON.stringify(actors);
    const summary = physicsSummaryForAuthoredActors(actors);
    expect(JSON.stringify(actors)).toBe(before);
    expect(summary).toMatchObject({ mode: 'dynamic-v1', dynamicCount: 2, staticCount: 1, unknownCount: 0 });
    expect(summary.actors.map(({ id, mode, reason }) => ({ id, mode, reason }))).toEqual([
      { id: 'car', mode: 'dynamic-v1', reason: 'selected' },
      { id: 'ped', mode: 'dynamic-v1', reason: 'selected' },
      { id: 'parked', mode: 'fixed-static-v1', reason: 'static-actor' },
    ]);
  });
});
