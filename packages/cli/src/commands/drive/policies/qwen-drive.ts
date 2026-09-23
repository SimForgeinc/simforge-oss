import path from 'node:path';

import { modelError, openModelEndpoint, repositoryRoot, type ModelEndpoint } from '../model-socket.js';
import { getProfile, type CameraSpec } from '../profiles.js';
import type { Policy, PolicyDecision, PolicyObservation } from '../policy.js';
import { followPlan, planFromSamples, planToWorld, worldToLocal, wrapAngle } from './trajectory.js';

export type QwenDriveOptions = {
  readonly modelSocket: string;
  readonly noStartModel: boolean;
  /** `sft`, `rl`, or a planner-head directory. */
  readonly planner?: string;
  readonly mode?: 'direct' | 'reasoning';
  readonly precision?: 'bf16' | 'float16' | 'float32';
  readonly quant?: 'none' | 'nf4';
  /** Load Qwen's perception head for the `extras.bev` inset; defaults to `SIMFORGE_QWEN_BEV=1`. */
  readonly bev?: boolean;
  readonly modelScript?: string;
  readonly model?: string;
  readonly maxReasoningTokens?: number;
};

const HISTORY_POINTS = 16;
const FRAMES_PER_CAMERA = 4;
const LIMITS = { speedMps: [-4, 25], accelMps2: [-8, 4] } as const;

/** Qwen-Drive was trained on 50 (x, y, heading) waypoints at 10 Hz. */
const WAYPOINTS = 50;

function egoHistory(obs: PolicyObservation): number[][] {
  const rows = obs.egoHistory.slice(-HISTORY_POINTS);
  if (rows.length < HISTORY_POINTS) throw new Error(`Qwen-Drive needs ${HISTORY_POINTS} warm ego poses, got ${rows.length}`);
  return rows.map((row) => [...worldToLocal(row, obs.pose), wrapAngle((row[2] ?? obs.pose.yawRad) - obs.pose.yawRad), row[3] ?? obs.pose.speedMps, row[4] ?? obs.tS]);
}

function egoRoute(obs: PolicyObservation): number[][] {
  const points = obs.route.points.length ? obs.route.points : [[obs.pose.x, obs.pose.y]];
  const local: number[][] = points.map((point) => worldToLocal(point, obs.pose));
  if (Math.hypot(local[0]![0]!, local[0]![1]!) > 0.5) local.unshift([0, 0]);
  return local;
}

/** Frames at −1.5, −1.0, −0.5 and 0 s from a 10 Hz history; the newest four while the history is short. */
function frameHistory(frames: readonly Buffer[]): Buffer[] {
  if (frames.length < FRAMES_PER_CAMERA) throw new Error(`Qwen-Drive needs four frames per camera, got ${frames.length}`);
  if (frames.length >= 16) return [frames[frames.length - 16]!, frames[frames.length - 11]!, frames[frames.length - 6]!, frames[frames.length - 1]!];
  return frames.slice(-FRAMES_PER_CAMERA);
}

/** Pinhole intrinsics and optical-camera-to-ego transform of a native rig camera for the perception head. */
function calibration(spec: CameraSpec, frameSize: PolicyObservation['frameSize']): Record<string, number[][]> {
  const focal = frameSize.width / (2 * Math.tan(spec.hfov * Math.PI / 360));
  // Native mounts use clockwise yaw; the head uses X forward/Y left.
  // Columns are optical right, down, forward in that ego frame.
  const yaw = -spec.yawDeg * Math.PI / 180;
  const pitch = (spec.pitchDeg ?? 0) * Math.PI / 180;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  return {
    intrinsic: [[focal, 0, frameSize.width / 2], [0, focal, frameSize.height / 2], [0, 0, 1]],
    camera_to_ego: [[s, c * sp, c * cp, spec.fwd], [-c, s * sp, s * cp, spec.left], [0, -cp, sp, spec.up], [0, 0, 0, 1]],
  };
}

export function createQwenDrivePolicy(options: QwenDriveOptions): Policy {
  let endpoint: ModelEndpoint | undefined;
  const profile = 'qwen-drive-3cam';
  const cameras = getProfile(profile);
  const mode = options.mode ?? 'direct';
  const planner = options.planner ?? 'sft';
  return {
    id: 'qwen-drive',
    cameraProfile: profile,
    historyFrames: 16,
    async start(ctx) {
      endpoint = await openModelEndpoint({
        label: 'Qwen-Drive',
        socketPath: options.modelSocket,
        log: ctx.log,
        server: options.noStartModel ? undefined : {
          script: options.modelScript ?? path.join(repositoryRoot(), 'adapters', 'qwen-drive', 'scripts', 'run_server.sh'),
          args: [
            '--planner', planner,
            '--mode', mode,
            '--socket', options.modelSocket,
            '--precision', options.precision ?? 'bf16',
            '--quant', options.quant ?? 'none',
            ...(options.model ? ['--model', options.model] : []),
            ...(options.maxReasoningTokens === undefined ? [] : ['--max-reasoning-tokens', String(options.maxReasoningTokens)]),
            ...((options.bev ?? process.env['SIMFORGE_QWEN_BEV'] === '1') ? ['--bev'] : []),
          ],
          env: { SIMFORGE_DRIVE_OUT: ctx.out },
        },
      });
      return { hello: endpoint.hello };
    },
    async act(obs: PolicyObservation, seed: number): Promise<PolicyDecision> {
      if (!endpoint) throw new Error('Qwen-Drive policy has not started');
      const started = performance.now();
      const response = await endpoint.client.act({
        cameras: cameras.map((spec) => ({
          camera_id: spec.cameraId,
          frames: frameHistory(obs.frames[spec.sensorId] ?? []),
          encoding: 'raw',
          width: obs.frameSize.width,
          height: obs.frameSize.height,
          calibration: calibration(spec, obs.frameSize),
        })),
        frame_size: obs.frameSize,
        ego_history_xyz: egoHistory(obs),
        ego_velocity: [obs.pose.speedMps, 0],
        route: { points: egoRoute(obs), remainingM: obs.route.remainingM },
      }, seed, { mode, num_samples: 1 }, { observation: obs, cameras });
      const error = modelError(response, 'Qwen-Drive', 'act');
      if (error) throw error;
      const raw = response.result?.trajectories?.[0];
      if (!raw) throw new Error('Qwen-Drive response contained no trajectory');
      if (raw.length !== WAYPOINTS) throw new Error(`Qwen-Drive returned ${raw.length} waypoints; expected ${WAYPOINTS}`);
      const world = planToWorld(planFromSamples(raw, 0.1, 'column', 'Qwen-Drive'), obs.pose);
      const reasoning = response.result?.reasoning;
      const modelExtras = response.result?.['extras'];
      const extras = modelExtras && typeof modelExtras === 'object' ? modelExtras as Record<string, unknown> : {};
      const bev = extras['bev'];
      return {
        action: followPlan(world, obs.pose, LIMITS),
        tracking: { points: world, limits: LIMITS, issuedTS: obs.tS },
        reasoning: typeof reasoning === 'string' && reasoning.trim() ? { kind: 'text', text: reasoning.trim() } : { kind: 'none' },
        trajectory: world.map((point) => [point.x, point.y]),
        latencyMs: performance.now() - started,
        extras: {
          ...extras,
          ...(bev && typeof bev === 'object' ? { bev: { ...bev, observationTS: obs.tS, trajectory: raw.map((point) => [point[0]!, point[1]!]) } } : {}),
          planner,
          mode,
          timings: response.result?.timings ?? {},
          vram: response.result?.vram ?? {},
          rawTrajectoryShape: [1, raw.length, raw[0]?.length ?? 0],
          navRouteRemainingM: obs.route.remainingM,
        },
      };
    },
    async stop() {
      await endpoint?.stop();
      endpoint = undefined;
    },
  };
}
