// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { ActorRenderer, disposePropTemplates, type ActorView } from './actorRenderer';

afterEach(() => disposePropTemplates());

function view(id: string, x: number): ActorView {
  return { id, catalogId: 'vehicle.sedan', x, y: 0, z: 0, headingRad: 0.5, speedMps: 4, dims: { l: 4.6, w: 1.9, h: 1.5 } };
}

describe('actor views by id', () => {
  it('returns the pose a visible layer last drew for an actor', () => {
    const renderer = new ActorRenderer();
    renderer.syncLayer('playback', [view('ego', 3)]);
    renderer.syncLayer('sumo-traffic', [view('sumo:0a1b2c3d', 9)]);
    expect(renderer.actorView('ego')).toMatchObject({ x: 3, headingRad: 0.5 });
    expect(renderer.actorView('sumo:0a1b2c3d')).toMatchObject({ x: 9 });
    expect(renderer.actorView('nobody')).toBeNull();
    renderer.dispose();
  });

  it('never answers from a hidden layer', () => {
    const renderer = new ActorRenderer();
    renderer.syncLayer('editor', [view('ego', 1)]);
    renderer.syncLayer('playback', [view('ego', 5)]);
    renderer.setLayerVisible('editor', false);
    expect(renderer.actorView('ego')).toMatchObject({ x: 5 });
    renderer.setLayerVisible('playback', false);
    expect(renderer.actorView('ego')).toBeNull();
    renderer.dispose();
  });
});
