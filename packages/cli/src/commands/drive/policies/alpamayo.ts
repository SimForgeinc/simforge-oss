import path from 'node:path';

import { modelError, openModelEndpoint, repositoryRoot, type ModelEndpoint } from '../model-socket.js';
import { getProfile } from '../profiles.js';
import type { Policy, PolicyDecision, PolicyObservation } from '../policy.js';
import type { ReasoningRecord } from '@simforge-oss/evaluation/drive-evidence';
import { followPlan, planFromSamples, planToWorld, worldToLocal } from './trajectory.js';

export type AlpamayoOptions = {
  readonly modelSocket: string;
  readonly quant: string;
  readonly noStartModel: boolean;
  readonly modelScript?: string;
};

const HISTORY_POINTS = 16;
const LIMITS = { speedMps: [-4, 25], accelMps2: [-8, 4] } as const;

function reasoning(value: unknown): ReasoningRecord {
  // Alpamayo returns one chain-of-thought string per trajectory sample.
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === 'string' && text.trim() ? { kind: 'text', text } : { kind: 'none' };
}

export function createAlpamayoPolicy(options: AlpamayoOptions): Policy {
  let endpoint: ModelEndpoint | undefined;
  const profile = 'alpamayo-2cam';
  const cameras = getProfile(profile);
  return {
    id: 'alpamayo-1.5',
    cameraProfile: profile,
    historyFrames: 4,
    async start(ctx) {
      endpoint = await openModelEndpoint({
        label: 'Alpamayo',
        socketPath: options.modelSocket,
        log: ctx.log,
        server: options.noStartModel ? undefined : {
          script: options.modelScript ?? path.join(repositoryRoot(), 'adapters', 'alpamayo', 'scripts', 'run_server.sh'),
          args: ['--family', 'alpamayo-1.5', '--quant', options.quant, '--socket', options.modelSocket],
          env: { SIMFORGE_DRIVE_OUT: ctx.out },
        },
      });
      return { hello: endpoint.hello };
    },
    async act(obs: PolicyObservation, seed: number): Promise<PolicyDecision> {
      if (!endpoint) throw new Error('Alpamayo policy has not started');
      const started = performance.now();
      const history = obs.egoHistory.slice(-HISTORY_POINTS);
      const response = await endpoint.client.act({
        cameras: cameras.map((spec) => ({
          camera_id: spec.cameraId,
          frames: obs.frames[spec.sensorId] ?? [],
          encoding: 'raw',
          width: obs.frameSize.width,
          height: obs.frameSize.height,
        })),
        ego_history_xyz: history.map((row) => [...worldToLocal(row, obs.pose), 0]),
        ego_history_rot: history.map((row) => {
          const yaw = (row[2] ?? obs.pose.yawRad) - obs.pose.yawRad;
          const cos = Math.cos(yaw);
          const sin = Math.sin(yaw);
          return [[cos, -sin, 0], [sin, cos, 0], [0, 0, 1]];
        }),
        ego_history_t_s: history.map((row) => (row[4] ?? obs.tS) - obs.tS),
        route: obs.route,
      }, seed, { num_traj_samples: 1 }, { observation: obs, cameras });
      const error = modelError(response, 'Alpamayo', 'act');
      if (error) throw error;
      const raw = response.result?.trajectories?.[0];
      if (!raw || raw.length < 2) throw new Error('Alpamayo returned fewer than two trajectory points');
      const world = planToWorld(planFromSamples(raw, 0.1, 'tangent', 'Alpamayo'), obs.pose);
      return {
        action: followPlan(world, obs.pose, LIMITS),
        tracking: { points: world, limits: LIMITS, issuedTS: obs.tS },
        reasoning: reasoning(response.result?.reasoning),
        trajectory: world.map((point) => [point.x, point.y]),
        latencyMs: performance.now() - started,
        extras: { ...(response.result?.['extras'] as Record<string, unknown> | undefined), timings: response.result?.timings ?? {}, vram: response.result?.vram ?? {}, rawTrajectoryPoints: raw.length },
      };
    },
    async stop() {
      await endpoint?.stop();
      endpoint = undefined;
    },
  };
}
