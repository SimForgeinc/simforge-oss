/**
 * Evaluation job parameters — `simforge.openloop-params/v2` and
 * `simforge.policy-episode-params/v1`.
 *
 * This module is deliberately dependency-free apart from zod: it is imported
 * by the studio registry contracts, which are also loaded in the browser
 * bundle. Nothing here may reach for `node:*`. The result documents, endpoint
 * client and execution cores (which do) live in their own modules.
 */

import { z } from 'zod';

/** Canonical reported horizons in seconds. */
export const OPENLOOP_HORIZONS_S = [1.0, 3.0, 6.4] as const;
export type OpenloopHorizonS = (typeof OPENLOOP_HORIZONS_S)[number];

export const OPENLOOP_PARAMS_SCHEMA = 'simforge.openloop-params/v2';
export const POLICY_EPISODE_PARAMS_SCHEMA = 'simforge.policy-episode-params/v1';

/** Where the evaluated observations came from. */
export const INPUT_KINDS = ['scenario', 'dataset-clip', 'user-clip', 'replay-context', 'trace'] as const;
export type InputKind = (typeof INPUT_KINDS)[number];

/** Why an item was not evaluated as driving prediction. */
export const REFUSAL_CODES = [
  'missing_fields',
  'camera_set_invalid',
  'calibration_invalid',
  'reference_missing',
  'unsupported_op',
  'input_error',
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

/** Closed-loop timing modes; a run carries exactly one. */
export const EPISODE_MODES = ['offline-simtime', 'realtime'] as const;
export type EpisodeMode = (typeof EPISODE_MODES)[number];

/**
 * Every authored `alpamayo-*` rig preset has APPROXIMATED extrinsics and a
 * wider vertical FoV than the calibrated dataset rig: the presets reproduce
 * the horizontal FoV but render 4:3 where the dataset cameras are 1920x1208,
 * so frames show more sky and hood than the training distribution. The real
 * per-vehicle calibration lives inside the gated dataset and the policy wire
 * carries no intrinsics or extrinsics at all (cameras are identified by index
 * only) \u2014 see the comment above `ALPAMAYO_CAMERA_TEMPLATES` in
 * packages/scenario/src/schema/v2/sensor-rigs.ts.
 *
 * An episode rendered from these mounts is therefore a valid engineering run
 * and never upstream parity, and every result stamps it as such. The test is
 * a prefix rather than a fixed id list because a future authored preset is
 * approximated too, unless someone lands real calibration.
 */
export const APPROXIMATED_EXTRINSICS_OOD = 'approximated_extrinsics';

export function rigHasApproximatedExtrinsics(cameraProfile: string | null | undefined): boolean {
  return typeof cameraProfile === 'string' && cameraProfile.startsWith('alpamayo-');
}

export const OpenloopSamplingSchema = z.object({
  numTrajSamples: z.number().int().min(1).max(64).default(1),
  topP: z.number().min(0).max(1).default(0.98),
  temperature: z.number().min(0).max(4).default(0.6),
  diffusionSteps: z.number().int().min(1).max(200).nullable().default(null),
  navText: z.string().max(2_000).nullable().default(null),
});

export const OpenloopInputSchema = z
  .object({
    kind: z.enum(INPUT_KINDS),
    /** Instance id, `clipId:t0Us` or a local bundle path (host runs). */
    ref: z.string().min(1).optional(),
    /** Name of the job's `inputs[]` entry holding this input (cloud runs). */
    role: z.string().min(1).optional(),
    /** Authored rig preset that produced (or must produce) the camera set. */
    cameraProfile: z.string().min(1).default('alpamayo-4cam'),
    /** Explicit clip origin for dataset/user clips. */
    t0Us: z.number().int().nonnegative().nullable().default(null),
  })
  .refine((value) => Boolean(value.ref ?? value.role), { message: 'input needs `ref` or `role`' });

/**
 * Out-of-distribution opt-ins. Every field is off by default; enabling one
 * stamps the run `exploratory` and forbids metrics, promotion and comparison.
 */
export const OpenloopOodSchema = z.object({
  exploratory: z.boolean().default(false),
  assumedStationaryEgo: z.boolean().default(false),
  assumedIntrinsics: z.record(z.string(), z.unknown()).nullable().default(null),
});

export const OpenloopParamsSchema = z.object({
  schema: z.literal(OPENLOOP_PARAMS_SCHEMA).default(OPENLOOP_PARAMS_SCHEMA),
  /** One job carries N items so a cold start amortises. */
  items: z.array(OpenloopInputSchema).min(1).max(1_000),
  sampling: OpenloopSamplingSchema.default({}),
  /** `auto` scores when the input carries a reference future; `none` never scores. */
  reference: z.enum(['auto', 'none']).default('auto'),
  /** `act` = trajectory prediction, `text` = VQA/meta-actions/auto-labelling. */
  task: z.enum(['act', 'text']).default('act'),
  textTask: z.enum(['vqa', 'meta_actions', 'autolabel', 'grounding']).nullable().default(null),
  prompt: z.string().max(8_000).nullable().default(null),
  horizonsS: z.array(z.number().positive()).default([...OPENLOOP_HORIZONS_S]),
  seed: z.number().int().nonnegative().default(0),
  ood: OpenloopOodSchema.default({}),
});
export type OpenloopParams = z.infer<typeof OpenloopParamsSchema>;

/**
 * One closed-loop episode. `spec`/`replayContext` are local paths (host runs);
 * `specRole`/`replayContextRole` name a cloud job's resolved inputs.
 *
 * The refinements are the honest-mode rules: a deadline exists only in
 * `realtime`, forced misses are meaningless without one, and a model episode
 * cannot run without a real camera frame source.
 */
export const PolicyEpisodeParamsSchema = z
  .object({
    schema: z.literal(POLICY_EPISODE_PARAMS_SCHEMA).default(POLICY_EPISODE_PARAMS_SCHEMA),
    spec: z.string().min(1).optional(),
    specRole: z.string().min(1).optional(),
    session: z.number().int().nonnegative().default(0),
    steps: z.number().int().positive().max(100_000),
    seed: z.union([z.number().int(), z.string()]).default(0),
    decisionHz: z.number().int().positive().default(10),
    mode: z.enum(EPISODE_MODES).default('offline-simtime'),
    /** Required in `realtime`; forbidden in `offline-simtime`. */
    deadlineMs: z.number().positive().nullable().default(null),
    fallback: z.enum(['repeat-last', 'zero-control', 'scripted']).default('zero-control'),
    forceMissAt: z.array(z.number().int().nonnegative()).default([]),
    execution: z.enum(['pure-pursuit', 'speed-setpoint']).default('pure-pursuit'),
    /** `endpoint` runs the model; scripted/trajectory/torch are references. */
    runnerPolicy: z.enum(['scripted', 'trajectory', 'torch', 'endpoint']).default('scripted'),
    policySeed: z.number().int().nonnegative().default(0),
    cameraProfile: z.string().min(1).default('alpamayo-4cam'),
    /** Model replan cadence; the executor holds the plan in between (ZOH). */
    replanHz: z.number().positive().nullable().default(null),
    numTrajSamples: z.number().int().min(1).max(64).nullable().default(null),
    navText: z.string().max(2_000).nullable().default(null),
    /** `dir:<path>` | `bevy:<rig.json>`; required for `endpoint`. */
    frameSource: z.string().min(1).nullable().default(null),
    warmupPolicy: z.enum(['scripted', 'trajectory', 'torch']).nullable().default(null),
    warmupSteps: z.number().int().nonnegative().nullable().default(null),
    /** `simforge.replay-context/v1` bundle; enables envelope enforcement. */
    replayContext: z.string().min(1).nullable().default(null),
    replayContextRole: z.string().min(1).nullable().default(null),
    scoring: z.record(z.string(), z.unknown()).default({}),
    expectedRouteM: z.number().positive().nullable().default(null),
    speedLimitMps: z.number().positive().nullable().default(null),
    allowColdStart: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'realtime' && !value.deadlineMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deadlineMs'],
        message: 'realtime mode requires an explicit deadlineMs',
      });
    }
    if (value.mode === 'offline-simtime' && value.deadlineMs !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deadlineMs'],
        message: 'offline-simtime has no deadline (the barrier is the loop); use mode "realtime" to enforce one',
      });
    }
    if (value.mode === 'offline-simtime' && value.forceMissAt.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['forceMissAt'],
        message: 'forceMissAt is meaningless without a deadline',
      });
    }
    if (value.runnerPolicy === 'endpoint' && !value.frameSource) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['frameSource'],
        message: 'the endpoint policy needs a real frame source; camera views are never synthesized',
      });
    }
    if (!value.spec && !value.specRole) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['spec'], message: 'episode needs `spec` or `specRole`' });
    }
  });
export type PolicyEpisodeParams = z.infer<typeof PolicyEpisodeParamsSchema>;
