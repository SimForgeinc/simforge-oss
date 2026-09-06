import { describe, expect, it, vi } from 'vitest';

import {
  actionsForActor,
  interactionForAction,
} from '@simforge-oss/editor';
import { configureCustomRouteAtClipStart } from '../../../../src/scenario/editor/custom-route-configuration';

describe('custom route timeline action', () => {
  it.each([
    ['car', undefined],
    ['pedestrian', undefined],
    ['animal', undefined],
    ['sidewalk_robot', undefined],
    ['bicycle', 'vehicle.bicycle'],
    ['scooter', undefined],
    ['drone', undefined],
  ] as const)('is available to moving %s actors', (actorClass, catalogId) => {
    expect(
      actionsForActor(actorClass, catalogId).some((candidate) => candidate.id === 'custom_route'),
    ).toBe(true);
  });

  it('is a topology-only vehicle action and never authors speed dynamics', () => {
    const action = actionsForActor('car').find((candidate) => candidate.id === 'custom_route');
    expect(action).toMatchObject({
      label: 'Custom route',
      group: 'Routes',
      verb: 'route',
      resource: 'topology',
      target: { mode: 'customRoute' },
    });

    const interaction = interactionForAction(action!, 'ego', 4, 1);
    expect(interaction).toMatchObject({
      actor: 'ego',
      trigger: { kind: 'at', t: 4 },
      verb: 'route',
      target: { mode: 'customRoute' },
    });
    expect('dynamics' in interaction).toBe(false);
  });

  // A route the author actually drew: it covers ground, so opening it keeps the
  // geometry and drops the user straight into move mode.
  it('seeks to clip start and preserves an existing editable route', () => {
    const placeholder = interactionForAction(
      actionsForActor('car').find((candidate) => candidate.id === 'custom_route')!,
      'ego',
      6,
      1,
    );
    const interaction = {
      ...placeholder,
      target: { mode: 'customRoute', points: [{ x: 10, z: 4 }, { x: 38, z: 21 }] },
    } as typeof placeholder;
    const document = {
      data: {
        choreography: { clipSeconds: 20, warmupSeconds: 0, interactions: [interaction] },
        roles: [],
      },
      actor: vi.fn(() => ({ id: 'ego', x: 1, y: 0, z: 2, headingRad: 0 })),
    };
    const beginCustomRouteAuthoring = vi.fn(() => true);
    const setPlaybackInspection = vi.fn();
    const controller = { beginCustomRouteAuthoring, setPlaybackInspection };
    const pause = vi.fn();
    const seek = vi.fn();
    const playback = {
      pause,
      seek,
      currentActors: [{ id: 'ego', x: 42, z: -7, headingRad: 1.2 }],
    };
    const setInspecting = vi.fn();

    const result = configureCustomRouteAtClipStart({
      document: document as never,
      controller: controller as never,
      playback: playback as never,
      setInspecting,
      interactionId: interaction.id,
    });

    expect(result).toEqual({ configured: true, startS: 6 });
    expect(pause).toHaveBeenCalledOnce();
    expect(seek).toHaveBeenCalledWith(6);
    expect(setInspecting).toHaveBeenCalledWith(false);
    expect(setPlaybackInspection).toHaveBeenCalledWith(false);
    expect(beginCustomRouteAuthoring).toHaveBeenCalledWith(interaction.id, {});
  });

  // The counterpart, and the regression that matters: an undrawn catalog route
  // must arm drawing from the actor's live pose rather than be preserved as if
  // the author had placed it. Preserving it is what put the route at the map
  // origin and teleported the actor there on playback.
  it('arms drawing from the actor pose when the route is still a placeholder', () => {
    const interaction = interactionForAction(
      actionsForActor('car').find((candidate) => candidate.id === 'custom_route')!,
      'ego',
      6,
      1,
    );
    const beginCustomRouteAuthoring = vi.fn(() => true);
    const document = {
      data: {
        choreography: { clipSeconds: 20, warmupSeconds: 0, interactions: [interaction] },
        roles: [],
      },
      actor: vi.fn(() => ({ id: 'ego', x: 1, y: 0, z: 2, headingRad: 0 })),
    };

    configureCustomRouteAtClipStart({
      document: document as never,
      controller: { beginCustomRouteAuthoring, setPlaybackInspection: vi.fn() } as never,
      playback: {
        pause: vi.fn(),
        seek: vi.fn(),
        currentActors: [{ id: 'ego', x: 42, z: -7, headingRad: 1.2 }],
      } as never,
      setInspecting: vi.fn(),
      interactionId: interaction.id,
    });

    expect(beginCustomRouteAuthoring).toHaveBeenCalledWith(interaction.id, {
      reset: true,
      startPose: { x: 42, z: -7, headingRad: 1.2 },
    });
  });

  it.each([
    [
      'short custom route',
      { mode: 'customRoute' as const, points: [{ x: 0, z: 0 }, { x: 0.04, z: 0 }] },
    ],
    [
      'stationary timed wait',
      { mode: 'customTimedRoute' as const, points: [{ timeS: 0, x: 0, z: 0 }, { timeS: 8, x: 0, z: 0 }] },
    ],
    [
      'single-keyframe timed hold',
      { mode: 'customTimedRoute' as const, points: [{ timeS: 8, x: 40, z: 5 }] },
    ],
    [
      'timed route with generated coordinates but authored timing',
      { mode: 'customTimedRoute' as const, points: [{ timeS: 0, x: 0, z: 0 }, { timeS: 8, x: 1, z: 0 }] },
    ],
  ])('preserves an authored %s', (_label, target) => {
    const interaction = {
      ...interactionForAction(
        actionsForActor('car').find((candidate) => candidate.id === 'custom_route')!,
        'ego',
        6,
        1,
      ),
      target,
    };
    const beginCustomRouteAuthoring = vi.fn(() => true);
    configureCustomRouteAtClipStart({
      document: {
        data: {
          choreography: { clipSeconds: 20, warmupSeconds: 0, interactions: [interaction] },
          roles: [],
        },
        actor: vi.fn(() => ({ id: 'ego', x: 125, y: 0, z: -60, headingRad: 0 })),
      } as never,
      controller: { beginCustomRouteAuthoring, setPlaybackInspection: vi.fn() } as never,
      playback: { pause: vi.fn(), seek: vi.fn(), currentActors: [] },
      setInspecting: vi.fn(),
      interactionId: interaction.id,
    });

    expect(beginCustomRouteAuthoring).toHaveBeenCalledWith(interaction.id, {});
  });
});
