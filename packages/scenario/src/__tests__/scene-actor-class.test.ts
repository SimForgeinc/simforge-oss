import { describe, expect, it } from 'vitest';

import { SCENE_ACTOR_CLASSES, SceneActorClassError, sceneActorClassOfKind } from '../scene-actor-class.js';

describe('scene actor classes', () => {
  it('maps every engine kind onto the render service vocabulary', () => {
    const kinds = ['vehicle', 'car', 'van', 'truck', 'bus', 'motorcycle', 'bicycle', 'scooter', 'pedestrian', 'sidewalk_robot', 'drone', 'animal', 'static_object'];
    for (const kind of kinds) expect(SCENE_ACTOR_CLASSES).toContain(sceneActorClassOfKind(kind));
    expect(sceneActorClassOfKind('bicycle')).toBe('cyclist');
    expect(sceneActorClassOfKind('scooter')).toBe('cyclist');
    expect(sceneActorClassOfKind('van')).toBe('van');
    expect(SCENE_ACTOR_CLASSES).not.toContain('bicycle');
  });

  it('refuses an unknown kind by name', () => {
    expect(() => sceneActorClassOfKind('hovercraft')).toThrow(SceneActorClassError);
  });
});
