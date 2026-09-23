/**
 * Render timeline → native `load_scene_state` frames.
 *
 * The native (Bevy) renderer replays the authoritative trace: every camera
 * frame time is sampled through the shared sampler (`sceneFramesArray`, the
 * same Rust `pose(timeline, actorId, t)` CARLA and the editor use) and sent
 * as one scene-state.v1 frame. Height is the timeline's baked ground-contact
 * `z` (scene `y`); every frame carries `groundY: 0` so the baked height is
 * authoritative even where it is exactly 0 and the service never falls back
 * to its own mesh sampling. Contract: `docs/engineering/render-timeline.md`.
 */

import { createHash } from 'node:crypto';

import { unionFrameMicros, type FixedSchedule } from '../schedule.js';
import { SCENE_FRAME_RECORD_LEN, openRenderTimeline, type RenderTimelineHandle } from '../timeline/index.js';
import { canonicalSceneJson, nativeActorClass, type NativeActorAppearance, type NativeSceneLowering, type NativeSceneState } from './lowering.js';

interface TimelineActorDesc {
  readonly id: string;
  readonly kind: string;
  readonly catalogId: string;
  readonly catalogAuthored: boolean;
  readonly dims: { readonly l: number; readonly w: number; readonly h: number };
  readonly color?: string;
}

interface TimelineHeader {
  readonly mapId: string;
  readonly dtS: number;
  readonly identity: { readonly timelineKey: string };
  readonly environment: { readonly weather: { readonly preset: 'clear' | 'rain' | 'fog' | 'night' }; readonly timeOfDay: number };
}

export interface TimelineLoweringOptions {
  /**
   * Send road + body pitch/roll in the actor rotation. The released native
   * service applies yaw only (`apply_scene_tick` rebuilds a yaw quaternion),
   * so the default sends yaw-only rotations whose yaw is exact.
   */
  readonly attitude?: boolean;
}

export interface NativeTimelineLowering extends NativeSceneLowering {
  readonly source: 'render-timeline';
  readonly timelineSha256: string;
  readonly timelineKey: string;
}

function q(value: number): number {
  return Number(value.toFixed(6));
}

/** Lower an opened timeline at the union of the RGB schedules' frame times. */
export function lowerRenderTimelineToNative(
  timeline: RenderTimelineHandle,
  schedules: readonly FixedSchedule[],
  options: TimelineLoweringOptions = {},
): NativeTimelineLowering {
  if (schedules.length === 0) throw new Error('native render requires at least one RGB schedule');
  const header = JSON.parse(timeline.headerJson()) as TimelineHeader;
  const actors = JSON.parse(timeline.actorsJson()) as TimelineActorDesc[];
  const frameTimes = unionFrameMicros(schedules).map((value) => value / 1_000_000);
  const end = timeline.clipEndS;
  const beyond = frameTimes.findIndex((t) => t > end + 1e-9);
  if (beyond >= 0) {
    throw new Error(`render frame ${beyond} at ${frameTimes[beyond]}s exceeds the timeline clip end ${end}s`);
  }
  const values = timeline.sceneFramesArray(Float64Array.from(frameTimes), options.attitude !== true);
  const stride = actors.length * SCENE_FRAME_RECORD_LEN;
  const previous = new Array<boolean>(actors.length).fill(false);
  const rendered = new Set<string>();
  const classes = actors.map((actor) => nativeActorClass(actor.kind, `actor ${actor.id}`));
  const states = frameTimes.map((clipTime, tick): NativeSceneState => {
    const out: NativeSceneState['actors'][number][] = [];
    actors.forEach((actor, index) => {
      const o = tick * stride + index * SCENE_FRAME_RECORD_LEN;
      const present = values[o] === 1;
      const was = previous[index]!;
      previous[index] = present;
      if (!present && !was) return;
      rendered.add(actor.id);
      out.push({
        id: actor.id,
        kind: present ? (was ? 'update' : 'spawn') : 'despawn',
        catalogId: actor.catalogId,
        actorClass: classes[index]!,
        dims: actor.dims,
        ...(actor.color ? { color: actor.color } : {}),
        transform: {
          // Absent (despawn) records carry no pose of their own; the service
          // removes the instance without reading it.
          position: [q(values[o + 1]!), q(values[o + 2]!), q(values[o + 3]!)],
          rotation: [q(values[o + 4]!), q(values[o + 5]!), q(values[o + 6]!), q(values[o + 7]!)],
        },
        velocity: [q(values[o + 8]!), q(values[o + 9]!), q(values[o + 10]!)],
      });
    });
    const previousTime = tick === 0 ? frameTimes[1] ?? clipTime + header.dtS : frameTimes[tick - 1]!;
    const tickHz = q(1 / Math.max(1e-9, Math.abs(clipTime - previousTime)));
    return {
      version: 'simforge.scene-state.v1', mapId: header.mapId, tick, tickHz,
      weather: { preset: header.environment.weather.preset }, timeOfDay: header.environment.timeOfDay,
      groundY: 0, actors: out,
    };
  });
  const appearances = actors
    .filter((actor) => rendered.has(actor.id))
    .map((actor): NativeActorAppearance => ({ actorId: actor.id, kind: actor.kind, catalogId: actor.catalogId, authored: actor.catalogAuthored }));
  const timelineSha256 = timeline.sha256;
  const sha256 = createHash('sha256').update(canonicalSceneJson({ timelineSha256, states })).digest('hex');
  return {
    source: 'render-timeline', mapId: header.mapId, fixedTimestepSeconds: header.dtS,
    states, frameTimes, appearances, sha256, timelineSha256, timelineKey: header.identity.timelineKey,
  };
}

/** Open timeline bytes (plain or gzipped canonical JSON) and lower them. */
export async function lowerTimelineToNative(
  timelineBytes: Uint8Array,
  schedules: readonly FixedSchedule[],
  options: TimelineLoweringOptions = {},
): Promise<NativeTimelineLowering> {
  const timeline = await openRenderTimeline(timelineBytes);
  try {
    return lowerRenderTimelineToNative(timeline, schedules, options);
  } finally {
    timeline.free();
  }
}
