import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolvePolicyCheckpoint } from '@simforge-oss/model-store';
import type { EnvAction } from '@simforge-oss/training-env';

import { ModelSocketClient, repositoryRoot, stopProcess } from '../model-socket.js';
import { getProfile } from '../profiles.js';
import type { Policy } from '../policy.js';

export interface TorchOptions {
  readonly checkpoint: string;
  readonly modelSocket: string;
  readonly noStartModel: boolean;
}

export async function createTorchPolicy(options: TorchOptions): Promise<Policy> {
  if (!options.checkpoint) throw new Error('torch requires a checkpoint: --policy torch:<run>/<update>');
  const { checkpoint, entry } = await resolvePolicyCheckpoint(options.checkpoint);
  const student = entry?.actionHead === 'control';
  const profile = student ? 'student-front' : 'none';
  const cameras = getProfile(profile);
  let client: ModelSocketClient | undefined;
  let server: ChildProcess | undefined;
  let checkpointInfo: Record<string, unknown> = {};
  return {
    id: 'torch',
    cameraProfile: profile,
    historyFrames: student ? 1 : 0,
    egoHistorySteps: student ? 2 : 0,
    obsPreset: student ? undefined : 'visible',
    async start(ctx) {
      if (!options.noStartModel) {
        const root = repositoryRoot();
        const python = process.env['SIMFORGE_TORCH_PYTHON'] ?? path.join(root, 'adapters/gym/.venv/bin/python');
        await fs.rm(options.modelSocket, { force: true });
        server = spawn(python, ['-m', 'simforge_oss_gym.train.serve', '--socket', options.modelSocket, '--checkpoint', entry?.revision ?? checkpoint, '--device', 'cpu'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, CUDA_VISIBLE_DEVICES: '', PYTHONPATH: [process.env['PYTHONPATH'], path.join(root, 'adapters/gym'), path.join(root, 'adapters/policy-endpoint')].filter(Boolean).join(path.delimiter) },
        });
        const child = server;
        await new Promise<void>((resolve, reject) => {
          let pending = '';
          const timer = setTimeout(() => reject(new Error('torch checkpoint readiness timed out')), 60_000);
          child.once('error', (error) => { clearTimeout(timer); reject(error); });
          child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`torch server exited before readiness (${code})`)); });
          child.stdout?.on('data', (chunk) => {
            pending += String(chunk);
            ctx.log(`torch: ${String(chunk).trim()}`);
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() ?? '';
            if (lines.some((line) => line.startsWith('READY '))) { clearTimeout(timer); resolve(); }
          });
          child.stderr?.on('data', (chunk) => ctx.log(`torch stderr: ${String(chunk).trim()}`));
        });
      }
      client = await ModelSocketClient.connect(options.modelSocket);
      const hello = await client.hello();
      if (!hello.ok) throw new Error(`torch hello failed: ${hello.error}`);
      checkpointInfo = hello.result ?? {};
      if ((checkpointInfo['actionHead'] === 'control') !== student) throw new Error('camera student requires its registered model-store ref, not an untyped checkpoint path');
      if (entry && checkpointInfo['checkpoint_digest'] !== entry.sha256) throw new Error('torch endpoint checkpoint differs from requested store ref');
      return { hello: checkpointInfo };
    },
    async act(obs, seed) {
      if (!client) throw new Error('torch policy has not started');
      if (!student && !obs.nativeObservation) throw new Error('teacher requires the real native observation');
      const previous = obs.egoHistory.at(-2);
      const dt = previous ? obs.tS - previous[4]! : 0;
      const yawRate = dt > 0 ? Math.atan2(Math.sin(obs.pose.yawRad - previous![2]!), Math.cos(obs.pose.yawRad - previous![2]!)) / dt : 0;
      const began = performance.now();
      const response = await client.act({
        ...(student ? {} : { state_vector: obs.nativeObservation!.stateVector, objects: obs.nativeObservation!.objects }),
        pose: obs.pose, motion: [obs.pose.speedMps, yawRate], route: obs.route,
        ...(student ? { cameras: cameras.map((spec) => ({ camera_id: spec.cameraId, frames: (obs.frames[spec.sensorId] ?? []).slice(-1), encoding: 'raw', width: spec.width, height: spec.height })) } : {}),
      }, seed, undefined, { observation: obs, cameras });
      if (!response.ok) throw new Error(`torch act failed: ${response.error}`);
      const result = response.result ?? {};
      const action = result['action'] as EnvAction | undefined;
      if (!action) throw new Error('checkpoint omitted action');
      if (student) {
        const control = action.control;
        if (!control || ![control.throttle, control.brake, control.steer].every(Number.isFinite) || control.throttle < 0 || control.throttle > 1 || control.brake < 0 || control.brake > 1 || Math.abs(control.steer) > 1) throw new Error('student returned invalid controls');
      } else if (typeof action.targetSpeedMps !== 'number' || typeof action.targetAccelerationMps2 !== 'number' || !Number.isFinite(action.targetSpeedMps) || !Number.isFinite(action.targetAccelerationMps2)) {
        throw new Error('teacher returned invalid native setpoints');
      }
      return {
        action,
        reasoning: { kind: 'text', text: `${student ? 'ResNet18+GRU student' : 'PPO teacher'} checkpoint telemetry (not language reasoning): update ${checkpointInfo['update']}.` },
        trajectory: null,
        latencyMs: performance.now() - began,
        extras: { checkpoint, checkpointInfo, ...(result['extras'] as Record<string, unknown> | undefined), modelTimings: result.timings ?? {} },
      };
    },
    async stop() {
      await client?.close().catch(() => undefined);
      client = undefined;
      server?.stdout?.removeAllListeners('data');
      server?.stderr?.removeAllListeners('data');
      await stopProcess(server);
      server = undefined;
    },
  };
}
