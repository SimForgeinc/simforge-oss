/** Behaviour of the native execution refinements (`simforge_compiler::studio_refinements`). */
import { describe, expect, it } from 'vitest';

import { parseSimScenarioInput, type SimScenarioInput } from '@simforge-oss/engine';
import { engine } from '@simforge-oss/engine/node';

function refined(input: SimScenarioInput): SimScenarioInput {
  return JSON.parse(engine().executionRefinements(input).toJson()) as SimScenarioInput;
}

describe('execution refinements', () => {
  it('restores cruise speed after a bounded speed interaction', () => {
    const input = parseSimScenarioInput({
      mapId: 'test',
      clipSeconds: 5,
      actors: [{
        id: 'car',
        kind: 'car',
        dims: { l: 4.5, w: 1.8, h: 1.5 },
        initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 8 },
        behavior: {
          cruiseSpeedMps: 8,
          route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 50, z: 0 }] },
        },
        tags: [],
      }],
      interactions: [{
        id: 'slow',
        actorId: 'car',
        trigger: { kind: 'at', t: 1 },
        window: { startS: 1, endS: 2 },
        verb: 'speed',
        target: { mode: 'absolute', value: 0 },
        dynamics: { shape: 'linear', constraint: 'rate', value: 3 },
      }],
    });
    const restored = refined(input);
    expect(restored.interactions).toContainEqual(expect.objectContaining({
      id: 'restore-cruise-slow',
      trigger: { kind: 'at', t: 2 },
      target: { mode: 'absolute', value: 8 },
    }));
  });

  it('applies speed-feasible yaw limits to high-speed world routes', () => {
    const input = parseSimScenarioInput({
      mapId: 'test',
      clipSeconds: 3,
      physics: { mode: 'dynamic-v1' },
      actors: [{
        id: 'car',
        kind: 'car',
        dims: { l: 4.5, w: 1.8, h: 1.5 },
        initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 40 },
        behavior: {
          cruiseSpeedMps: 40,
          route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 100, z: 0 }] },
        },
        tags: [],
      }],
      interactions: [{
        id: 'route',
        actorId: 'car',
        trigger: { kind: 'at', t: 0.5 },
        verb: 'route',
        target: { kind: 'polyline', points: [{ x: 10, z: 0 }, { x: 100, z: -20 }] },
        joinFromCurrentPose: true,
        bestEffortWorldPath: true,
      }],
    });
    const stable = refined(input);
    expect(stable.physics?.vehicleProfiles?.car?.maxYawRateRadps).toBeCloseTo(7 / 40);
    expect(stable.interactions.find((interaction) => interaction.id === 'route')).toEqual(expect.objectContaining({ joinFromCurrentPose: false }));
  });

});
