import type { Policy, PolicyDecision } from '../policy.js';
import { followPlan } from './trajectory.js';

import { createAlpamayoPolicy } from './alpamayo.js';
import { createAutoE2EPolicy } from './auto-e2e.js';
import { JevPolicy } from './jev.js';
import { createQwenDrivePolicy } from './qwen-drive.js';
import { scriptedPolicy } from './scripted.js';
import { createTorchPolicy } from './torch.js';

export interface PolicyFactoryOptions {
  readonly modelSocket: string;
  /** VLA weight quantization requested on the CLI; policies without a VLA ignore it. */
  readonly quant: string;
  readonly noStartModel: boolean;
  /** Matched comparisons: inference period must be an integer number of 10 Hz barriers. */
  readonly replanHz?: number;
}

type PolicyFactory = (options: PolicyFactoryOptions) => Policy;

/** `torch:<checkpoint>` drives a trained gym checkpoint served by `adapters/gym`. */
const TORCH_PREFIX = 'torch:';

function qwenQuant(quant: string): 'none' | 'nf4' {
  if (quant === 'nf4') return 'nf4';
  if (quant === 'bf16' || quant === 'none') return 'none';
  throw new Error(`qwen-drive supports --quant bf16 or nf4, not ${quant}`);
}

const factories: Readonly<Record<string, PolicyFactory>> = {
  scripted: () => scriptedPolicy,
  jev: (options) => new JevPolicy(options.replanHz),
  'auto-e2e': createAutoE2EPolicy,
  'alpamayo-1.5': createAlpamayoPolicy,
  'qwen-drive': (options) => createQwenDrivePolicy({ ...options, mode: 'reasoning', quant: qwenQuant(options.quant) }),
};

/** Policies that hold a VLA checkpoint on the GPU; the local 16 GiB card fits one beside the renderer. */
const EXCLUSIVE_GPU: Readonly<Record<string, true>> = { 'alpamayo-1.5': true, 'qwen-drive': true };

export function policyIds(): string[] {
  return [...Object.keys(factories).sort(), `${TORCH_PREFIX}<checkpoint>`];
}

export function isPolicyId(id: string): boolean {
  return id.startsWith(TORCH_PREFIX) || id in factories;
}

/** Heat scheduling: `exclusive` policies run one at a time, after every `shared` policy. */
export function policyGpuClass(id: string): 'exclusive' | 'shared' {
  return EXCLUSIVE_GPU[id] ? 'exclusive' : 'shared';
}

export async function createPolicy(id: string, options: PolicyFactoryOptions): Promise<Policy> {
  const factory = factories[id];
  if (!id.startsWith(TORCH_PREFIX) && !factory) throw new Error(`unknown policy ${id}; known policies: ${policyIds().join(', ')}`);
  const policy = id.startsWith(TORCH_PREFIX)
    ? await createTorchPolicy({ ...options, checkpoint: id.slice(TORCH_PREFIX.length) })
    : factory!(options);
  if (options.replanHz === undefined) return policy;
  const interval = 10 / options.replanHz;
  if (!Number.isInteger(interval) || interval < 1) throw new Error('--replan-hz must divide the 10 Hz decision clock');
  if (policy.replanHz !== undefined) {
    if (policy.replanHz !== options.replanHz) throw new Error('policy-owned replan cadence differs from requested comparison');
    return policy;
  }
  let held: PolicyDecision | undefined;
  let nextStep = 0;
  return {
    id: policy.id, cameraProfile: policy.cameraProfile, historyFrames: policy.historyFrames,
    egoHistorySteps: policy.egoHistorySteps, obsPreset: policy.obsPreset,
    replanHz: options.replanHz,
    async start(ctx) { held = undefined; nextStep = 0; return policy.start(ctx); },
    async act(obs, seed) {
      if (!held || obs.step >= nextStep) {
        held = await policy.act(obs, seed);
        nextStep = obs.step + interval;
        return held;
      }
      return {
        ...held,
        action: held.tracking ? followPlan(held.tracking.points, obs.pose, held.tracking.limits, obs.tS - held.tracking.issuedTS) : held.action,
        latencyMs: 0, extras: { ...held.extras, latched: true },
      };
    },
    async stop() { held = undefined; await policy.stop(); },
  };
}
