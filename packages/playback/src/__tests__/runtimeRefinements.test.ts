import { describe, expect, it, vi } from 'vitest';
import type { ActorRenderer, ActorView } from '@simforge-oss/viewer';
import {
  CollisionActorOverrides,
  withCollisionActorOverrides,
} from '../runtimeRefinements';

function actor(id: string, x: number): ActorView {
  return {
    id,
    catalogId: 'vehicle.sedan',
    kind: 'car',
    x,
    y: 0,
    z: 0,
    headingRad: 0,
    speedMps: 4,
    dims: { l: 4.5, w: 1.8, h: 1.5 },
  };
}

describe('playback renderer refinements', () => {
  it('replaces playback actors without changing other renderer layers', () => {
    const syncLayer = vi.fn();
    const renderer = { syncLayer } as unknown as ActorRenderer;
    const overrides = new CollisionActorOverrides();
    overrides.replace([actor('ego', 8)]);
    const wrapped = withCollisionActorOverrides(renderer, overrides);

    wrapped.syncLayer('playback', [actor('ego', 100), actor('other', 5)]);
    wrapped.syncLayer('sumo-traffic', [actor('ego', 20)]);

    expect(syncLayer.mock.calls[0]?.[1]).toEqual([actor('ego', 8), actor('other', 5)]);
    expect(syncLayer.mock.calls[1]?.[1]).toEqual([actor('ego', 20)]);
  });
});
