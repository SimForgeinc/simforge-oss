import type { EnvAction } from '@simforge-oss/training-env';

import type { Policy, PolicyDecision, PolicyObservation } from '../policy.js';

/** Authored-route reference driver used for warm-up and reproducible baselines. */
export const scriptedPolicy: Policy = {
  id: 'scripted',
  cameraProfile: 'none',
  historyFrames: 0,
  async start(ctx) {
    ctx.log(`scripted policy started on ${ctx.mapId}`);
    return { hello: { policy: 'scripted', route: 'native-authored-lane' } };
  },
  async act(obs: PolicyObservation): Promise<PolicyDecision> {
    const started = performance.now();
    const preview = obs.route.points.find((point) => {
      const dx = (point[0] ?? 0) - obs.pose.x;
      const dy = (point[1] ?? 0) - obs.pose.y;
      return dx * Math.cos(obs.pose.yawRad) + dy * Math.sin(obs.pose.yawRad) > 3;
    }) ?? obs.route.points.at(-1);
    const targetSpeed = Math.max(0.5, Math.min(13.4, obs.pose.speedMps + (obs.pose.speedMps < 1 ? 1.5 : 0.25)));
    const action: EnvAction = {
      targetSpeedMps: targetSpeed,
      targetAccelerationMps2: Math.max(-3.5, Math.min(2.5, (targetSpeed - obs.pose.speedMps) / 0.5)),
      motionDirection: 1,
      ...(preview ? {
        previewPoint: { x: preview[0] ?? obs.pose.x, y: preview[1] ?? obs.pose.y },
        previewHeadingRad: obs.pose.yawRad,
      } : {}),
    };
    const trajectory = obs.route.points.slice(0, 24).map((point) => [point[0] ?? obs.pose.x, point[1] ?? obs.pose.y]);
    return {
      action,
      reasoning: { kind: 'text', text: `native lane-following route, ${obs.route.remainingM.toFixed(1)}m remaining` },
      trajectory,
      tracking: {
        points: trajectory.map(([x, y]) => ({ x: x!, y: y!, headingRad: obs.pose.yawRad, speedMps: targetSpeed, tS: Math.hypot(x! - obs.pose.x, y! - obs.pose.y) / targetSpeed })),
        limits: { speedMps: [0, 13.4], accelMps2: [-3.5, 2.5] }, issuedTS: obs.tS,
      },
      latencyMs: performance.now() - started,
      extras: { routeRemainingM: obs.route.remainingM, reference: 'authored-route' },
    };
  },
  async stop() {},
};
