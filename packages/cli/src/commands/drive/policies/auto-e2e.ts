import os from 'node:os';
import path from 'node:path';

import type { LaneGraph } from '@simforge-oss/engine';

import { modelError, openModelEndpoint, repositoryRoot, type ModelEndpoint } from '../model-socket.js';
import { getProfile } from '../profiles.js';
import type { Policy, PolicyDecision, PolicyObservation } from '../policy.js';
import { followPlan, planToWorld, type PlanPoint } from './trajectory.js';

export type AutoE2EOptions = {
  readonly modelSocket: string;
  readonly noStartModel: boolean;
  readonly modelScript?: string;
  readonly checkpoint?: string;
  readonly device?: string;
};

const LIMITS = { speedMps: [0, 30], accelMps2: [-8, 4] } as const;

/** Native lane polylines the endpoint rasterises into its 256×256 BEV at every decision. */
function graphPayload(graph: LaneGraph): Record<string, unknown> {
  const lanes: Record<string, unknown>[] = [];
  for (const rsl of graph.laneIds) {
    try {
      const lane = JSON.parse(graph.laneJson(rsl)) as Record<string, unknown>;
      const polyline = Array.isArray(lane.polyline) ? lane.polyline : [];
      if (polyline.length < 2) continue;
      lanes.push({
        polyline,
        laneType: lane.laneType,
        isJunction: lane.isJunction,
        junctionId: lane.junctionId,
        widthM: lane.representativeWidthM ?? graph.laneWidthAt(rsl, 0),
      });
    } catch {
      // A malformed optional lane must not make the server infer geometry that
      // was not supplied. Other valid native lanes remain in the payload.
    }
  }
  return { lanes, source: 'native LaneGraph laneJson/polyline' };
}

function localPlan(trajectory: unknown, speeds: readonly number[], pose: PolicyObservation['pose']): PlanPoint[] {
  if (!Array.isArray(trajectory)) throw new Error('AutoE2E response contained no trajectory');
  return trajectory.map((raw, index) => {
    if (!Array.isArray(raw) || raw.length < 2 || raw.slice(0, 2).some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) {
      throw new Error('AutoE2E trajectory contains a non-finite point');
    }
    // The model emits controls; the endpoint integrates them into an ego-frame
    // path and speed profile. Heading stays the current yaw for the follower.
    return { x: raw[0] as number, y: raw[1] as number, headingRad: 0, speedMps: Math.max(0, speeds[index] ?? pose.speedMps), tS: (index + 1) * 0.1 };
  });
}

export function createAutoE2EPolicy(options: AutoE2EOptions): Policy {
  let endpoint: ModelEndpoint | undefined;
  const profile = 'auto-e2e-6view';
  const cameras = getProfile(profile);
  return {
    id: 'auto-e2e',
    cameraProfile: profile,
    historyFrames: 64,
    async start(ctx) {
      const checkpoint = options.checkpoint ?? path.join(process.env['SIMFORGE_ASSETS_ROOT'] ?? path.join(os.homedir(), 'simforge-assets'), 'models', 'auto-e2e', 'Best_Model.pt');
      endpoint = await openModelEndpoint({
        label: 'AutoE2E',
        socketPath: options.modelSocket,
        log: ctx.log,
        server: options.noStartModel ? undefined : {
          script: options.modelScript ?? path.join(repositoryRoot(), 'adapters', 'auto-e2e', 'scripts', 'run_server.sh'),
          args: ['--socket', options.modelSocket, '--checkpoint', checkpoint, ...(options.device ? ['--device', options.device] : [])],
          env: { SIMFORGE_DRIVE_OUT: ctx.out },
        },
        hello: { op: 'hello', config: { mapId: ctx.mapId, graph: graphPayload(ctx.graph) } },
      });
      return { hello: endpoint.hello };
    },
    async act(obs: PolicyObservation, seed: number): Promise<PolicyDecision> {
      if (!endpoint) throw new Error('AutoE2E policy has not started');
      const started = performance.now();
      const requestCameras = cameras.map((spec) => ({
        camera_id: spec.cameraId,
        frames: (obs.frames[spec.sensorId] ?? []).slice(-1),
        encoding: 'raw',
        width: obs.frameSize.width,
        height: obs.frameSize.height,
      }));
      if (requestCameras.some((camera) => camera.frames.length === 0)) {
        throw new Error('AutoE2E requires one real Bevy RGB frame for every six camera slots');
      }
      const signals = obs.nativeObservation?.signals ?? [];
      const trafficSignals: { points: number[][] }[] = [];
      const stopLines: { points: number[][] }[] = [];
      for (const signal of signals) {
        const [x, y, heading] = obs.graph.sampleLane(signal.laneRsl, signal.stopLineS);
        trafficSignals.push({ points: [[x!, y!]] });
        const halfWidth = obs.graph.laneWidthAt(signal.laneRsl, signal.stopLineS) / 2;
        const dx = -Math.sin(heading!) * halfWidth;
        const dy = Math.cos(heading!) * halfWidth;
        stopLines.push({ points: [[x! - dx, y! - dy], [x! + dx, y! + dy]] });
      }
      const response = await endpoint.client.act({
        cameras: requestCameras,
        frame_size: obs.frameSize,
        pose: obs.pose,
        ego_history: obs.egoHistory,
        route: obs.route,
        signals,
        trafficSignals,
        stopLines,
      }, seed, { num_samples: 1, map_id: obs.mapId }, { observation: obs, cameras });
      const error = modelError(response, 'AutoE2E', 'act');
      if (error) throw error;
      const result = response.result ?? {};
      const extras = (result.extras && typeof result.extras === 'object') ? result.extras as Record<string, unknown> : {};
      const rawSpeeds = extras['integratedSpeedProfileMps'];
      const speeds = Array.isArray(rawSpeeds) ? rawSpeeds.map((value) => Number(value)) : [];
      const world = planToWorld(localPlan(result.trajectory, speeds, obs.pose), obs.pose);
      if (world.length === 0) throw new Error('AutoE2E returned an empty integrated path');
      const hello = endpoint.hello as Record<string, unknown>;
      return {
        action: followPlan(world, obs.pose, LIMITS),
        tracking: { points: world, limits: LIMITS, issuedTS: obs.tS },
        reasoning: { kind: 'none' },
        trajectory: world.map((point) => [point.x, point.y]),
        latencyMs: performance.now() - started,
        extras: {
          ...extras,
          controls: result.controls ?? [],
          modelTimings: result.timings ?? {},
          modelVram: result.vram ?? {},
          raster: extras['raster'] ?? {},
          integratedSpeedProfileMps: speeds,
          checkpoint: hello['checkpoint'] ?? null,
          routePoints: obs.route.points,
          routeRemainingM: obs.route.remainingM,
        },
      };
    },
    async stop() {
      await endpoint?.stop();
      endpoint = undefined;
    },
  };
}
