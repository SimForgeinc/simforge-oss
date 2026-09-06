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

  it('migrates an editable kinematic pin to dynamic-v1', () => {
    const pinned = { ...legacy, physics: { mode: 'kinematic-v1' as const } };
    expect(withEditablePhysicsDefault(pinned)).toEqual({ ...pinned, physics: { mode: 'dynamic-v1' } });
  });

  it('classifies authored actors without changing authored data', () => {
    const actors = [
      { id: 'car', simulationKind: 'car', static: false, reverse: false },
      { id: 'ped', simulationKind: 'pedestrian', static: false, reverse: false },
      { id: 'parked', simulationKind: 'static_object', static: true, reverse: false },
      { id: 'reverse', simulationKind: 'car', static: false, reverse: true },
    ] as const;
    const before = JSON.stringify(actors);
    const summary = physicsSummaryForAuthoredActors(actors);
    expect(JSON.stringify(actors)).toBe(before);
    expect(summary).toMatchObject({ mode: 'dynamic-v1', dynamicCount: 3, staticCount: 1, fallbackCount: 0, unknownCount: 0 });
    expect(summary.actors.map(({ id, mode, reason }) => ({ id, mode, reason }))).toEqual([
      { id: 'car', mode: 'dynamic-v1', reason: 'selected' },
      { id: 'ped', mode: 'dynamic-v1', reason: 'selected' },
      { id: 'parked', mode: 'fixed-static-v1', reason: 'static-actor' },
      { id: 'reverse', mode: 'dynamic-v1', reason: 'selected' },
    ]);
  });
});
