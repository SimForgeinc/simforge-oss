import { describe, expect, it } from 'vitest';

import { applyRenderLowBeams, type NativeSceneState } from './lowering.js';

const actor = (id: string, actorClass: string, lights: Record<string, true> | undefined, kind: 'spawn' | 'update' | 'despawn' = 'update') => ({
  id, kind, catalogId: 'vehicle.sedan', actorClass,
  transform: { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] },
  velocity: [0, 0, 0] as [number, number, number],
  ...(lights ? { lights } : {}),
});

describe('render-environment low beams', () => {
  it('turns on the low beams of dark vehicles only, keeping their other lamps', () => {
    const states = [{
      version: 'simforge.scene-state.v1', mapId: 'm', tick: 0, tickHz: 30, weather: { preset: 'clear' }, timeOfDay: 12, actors: [
        actor('car-b', 'car', { brake: true }),
        actor('car-a', 'car', {}),
        actor('lit', 'van', { lowBeam: true }),
        actor('walker', 'pedestrian', {}),
        actor('bike', 'cyclist', {}),
        actor('legacy', 'car', undefined),
        actor('gone', 'car', {}, 'despawn'),
      ],
    }] as unknown as NativeSceneState[];
    expect(applyRenderLowBeams(states)).toEqual(['car-a', 'car-b']);
    const lights = Object.fromEntries(states[0]!.actors.map((a) => [a.id, a.lights]));
    expect(lights['car-b']).toEqual({ brake: true, lowBeam: true });
    expect(lights['car-a']).toEqual({ lowBeam: true });
    expect(lights.lit).toEqual({ lowBeam: true });
    expect(lights.walker).toEqual({});
    expect(lights.legacy).toBeUndefined();
    expect(lights.gone).toEqual({});
  });
});
