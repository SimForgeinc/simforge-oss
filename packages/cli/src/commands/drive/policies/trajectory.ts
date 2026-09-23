import type { EnvAction } from '@simforge-oss/training-env';

import type { PolicyObservation } from '../policy.js';

/** One timed plan sample. Local plans are ego-frame (x forward, y left); world plans are map-frame. */
export interface PlanPoint {
  readonly x: number;
  readonly y: number;
  readonly headingRad: number;
  readonly speedMps: number;
  readonly tS: number;
}

export type Pose = PolicyObservation['pose'];

export function wrapAngle(value: number): number {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

/** Rotate ego-frame `[x, y]` into the world frame at `pose`. */
export function localToWorld(point: readonly number[], pose: Pose): [number, number] {
  const cos = Math.cos(pose.yawRad);
  const sin = Math.sin(pose.yawRad);
  const x = point[0] ?? 0;
  const y = point[1] ?? 0;
  return [pose.x + x * cos - y * sin, pose.y + x * sin + y * cos];
}

/** Rotate world `[x, y]` into the ego frame at `pose`. */
export function worldToLocal(point: readonly number[], pose: Pose): [number, number] {
  const cos = Math.cos(pose.yawRad);
  const sin = Math.sin(pose.yawRad);
  const dx = (point[0] ?? pose.x) - pose.x;
  const dy = (point[1] ?? pose.y) - pose.y;
  return [dx * cos + dy * sin, -dx * sin + dy * cos];
}

/**
 * Model waypoints sampled every `dtS` seconds in the ego frame. Speed is the
 * finite difference between consecutive samples; the heading is either the
 * sample's third column or the tangent of the motion.
 */
export function planFromSamples(raw: readonly number[][], dtS: number, heading: 'column' | 'tangent', label: string): PlanPoint[] {
  return raw.map((point, index) => {
    if (point.length < (heading === 'column' ? 3 : 2) || point.some((value) => !Number.isFinite(value))) throw new Error(`${label} returned a non-finite trajectory`);
    const previous = raw[Math.max(0, index - 1)]!;
    const dx = point[0]! - previous[0]!;
    const dy = point[1]! - previous[1]!;
    return {
      x: point[0]!,
      y: point[1]!,
      headingRad: heading === 'column' ? point[2]! : Math.atan2(dy, dx),
      speedMps: Math.hypot(dx, dy) / dtS,
      tS: (index + 1) * dtS,
    };
  });
}

/** Anchor an ego-frame plan at the current pose. */
export function planToWorld(local: readonly PlanPoint[], pose: Pose): PlanPoint[] {
  return local.map((point) => {
    const [x, y] = localToWorld([point.x, point.y], pose);
    return { ...point, x, y, headingRad: wrapAngle(pose.yawRad + point.headingRad) };
  });
}

export interface FollowLimits {
  /** Inclusive target-speed range; a negative minimum permits reversing. */
  readonly speedMps: readonly [number, number];
  readonly accelMps2: readonly [number, number];
}

/** Preview horizon every trajectory policy steers toward: the first sample at or beyond 0.35 s. */
const PREVIEW_S = 0.35;

/**
 * Turn a world-frame plan into the engine setpoint: speed and acceleration
 * toward the preview sample, steering through its position and heading.
 */
export function followPlan(world: readonly PlanPoint[], pose: Pose, limits: FollowLimits, ageS = 0): EnvAction {
  const preview = world.find((point) => point.tS >= ageS + PREVIEW_S) ?? world.at(-1);
  if (!preview) throw new Error('cannot follow an empty plan');
  const targetSpeedMps = Math.max(limits.speedMps[0], Math.min(limits.speedMps[1], preview.speedMps));
  return {
    targetSpeedMps,
    targetAccelerationMps2: Math.max(limits.accelMps2[0], Math.min(limits.accelMps2[1], (targetSpeedMps - pose.speedMps) / Math.max(0.1, preview.tS - ageS))),
    motionDirection: targetSpeedMps < 0 ? -1 : 1,
    previewPoint: { x: preview.x, y: preview.y },
    previewHeadingRad: preview.headingRad,
  };
}
