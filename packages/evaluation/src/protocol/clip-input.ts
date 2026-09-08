/**
 * Input materialisation for open-loop evaluation.
 *
 * Every input kind — a user clip, an authorised dataset clip, a rendered
 * SimForge scenario observation, a reconstructed replay-context scene —
 * resolves to ONE on-disk shape, the `simforge.eval-observations/v1` observation
 * bundle, and is then evaluated by exactly the same code. There is no second
 * materialisation path and no per-kind special case in the executor.
 *
 * ```
 * <bundle>/clip.json            simforge.eval-observations/v1 manifest
 * <bundle>/frames/<sensor>/*    the real frames the manifest lists
 * <bundle>/video.mp4            optional source clip (presentation only)
 * ```
 *
 * What this module refuses to do:
 *
 * - It never invents a camera view, an ego pose, a timestamp or a
 *   calibration. A bundle that cannot supply the model's required camera set,
 *   4 frames per camera at 10 Hz, or 16 real ego-history poses produces a
 *   typed `missing_fields` refusal that names exactly what was absent.
 * - It never treats a scripted or reference-policy future as human ground
 *   truth: `reference.kind` is carried through to the result verbatim.
 * - It never scores a video-only bundle. Text tasks (VQA/meta-actions) are a
 *   separate task, explicitly not a driving evaluation.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { InvokeObservation } from './endpoint-client.js';

export const OBSERVATION_BUNDLE_SCHEMA = 'simforge.eval-observations/v1';

/** Frames per camera and ego-history steps the Alpamayo families require. */
export const FRAMES_PER_CAMERA = 4;
export const OBSERVATION_EGO_HISTORY_STEPS = 16;
export const HISTORY_DT_S = 0.1;

const FrameSchema = z.object({
  tUs: z.number(),
  path: z.string().min(1),
});

const CameraSchema = z.object({
  cameraId: z.number().int().min(0).max(6),
  sensorId: z.string().min(1).optional(),
  encoding: z.enum(['jpeg', 'png', 'raw']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Oldest → newest; the last frame is t0. */
  frames: z.array(FrameSchema).min(1),
  intrinsics: z.object({ model: z.string(), K: z.array(z.array(z.number())).length(3), coeffs: z.array(z.number()).default([]) }).optional(),
  extrinsicsRigFromCamera: z.array(z.array(z.number())).length(4).optional(),
});

const EgoPoseSchema = z.object({
  tUs: z.number(),
  x: z.number(),
  y: z.number(),
  headingRad: z.number(),
  speedMps: z.number().optional(),
});

export const ObservationBundleSchema = z.object({
  schema: z.literal(OBSERVATION_BUNDLE_SCHEMA),
  clipId: z.string().min(1),
  t0Us: z.number(),
  source: z.object({ kind: z.string().min(1) }).passthrough(),
  cameras: z.array(CameraSchema).default([]),
  ego: z.object({ poses: z.array(EgoPoseSchema).default([]) }).default({ poses: [] }),
  reference: z
    .object({
      kind: z.enum(['dataset', 'authored', 'reference-policy', 'recorded-replay', 'none']).default('none'),
      dtS: z.number().positive().default(HISTORY_DT_S),
      /** Ego frame at t0, FLU, strictly future, `dtS` cadence. */
      points: z.array(z.array(z.number())).default([]),
    })
    .default({ kind: 'none', dtS: HISTORY_DT_S, points: [] }),
  video: z.string().min(1).nullable().default(null),
  navText: z.string().nullable().default(null),
});
export type ObservationBundleDoc = z.infer<typeof ObservationBundleSchema>;

export interface ObservationBundle {
  readonly directory: string;
  readonly clip: ObservationBundleDoc;
  /** sha256 of the manifest bytes — the input digest recorded in provenance. */
  readonly digest: string;
}

export interface MaterializedItem {
  readonly obs: InvokeObservation;
  readonly cameraIds: readonly number[];
  readonly reference: ObservationBundleDoc['reference'];
  readonly projection: {
    cameraId: number;
    K: number[][];
    distortion: { model: string; coeffs: number[] };
    extrinsicsRigFromCamera: number[][];
    imageSize: [number, number];
    timestampsUs: number[];
  } | null;
  readonly digest: string;
  readonly video: string | null;
}

export interface InputRefusal {
  readonly code: 'missing_fields' | 'calibration_invalid' | 'input_error';
  readonly message: string;
  readonly missingFields: readonly string[];
}

export class ClipInputError extends Error {
  constructor(readonly refusal: InputRefusal) {
    super(refusal.message);
    this.name = 'ClipInputError';
  }
}

/** Load and validate `<dir>/clip.json`. */
export async function loadObservationBundle(target: string): Promise<ObservationBundle> {
  const manifestPath = target.endsWith('.json') ? target : path.join(target, 'clip.json');
  let bytes: Buffer;
  try {
    bytes = await readFile(manifestPath);
  } catch {
    throw new ClipInputError({
      code: 'input_error',
      message: `no ${OBSERVATION_BUNDLE_SCHEMA} manifest at ${manifestPath}`,
      missingFields: ['clip.json'],
    });
  }
  let document: unknown;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new ClipInputError({ code: 'input_error', message: `${manifestPath}: ${String(error)}`, missingFields: [] });
  }
  const parsed = ObservationBundleSchema.safeParse(document);
  if (!parsed.success) {
    throw new ClipInputError({
      code: 'input_error',
      message: `${manifestPath} is not a valid ${OBSERVATION_BUNDLE_SCHEMA}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      missingFields: parsed.error.issues.map((issue) => issue.path.join('.')),
    });
  }
  return {
    directory: path.dirname(manifestPath),
    clip: parsed.data,
    digest: createHash('sha256').update(bytes).digest('hex'),
  };
}

/**
 * Ego-frame-at-t0 history from the bundle's recorded world poses.
 *
 * Picks the pose nearest each of the 16 history instants
 * (`t0 − 1.5s … t0`, 10 Hz) and refuses when any instant has no pose within
 * half a step. The history is never extrapolated or zero-filled: a model fed
 * an invented history returns a number about a world that never existed.
 */
function egoHistory(clip: ObservationBundleDoc): { xyz: number[][]; rot: number[][][]; tS: number[] } {
  const poses = [...clip.ego.poses].sort((a, b) => a.tUs - b.tUs);
  if (poses.length === 0) {
    throw new ClipInputError({
      code: 'missing_fields',
      message: 'clip has no ego poses; a driving evaluation needs timestamped ego history',
      missingFields: ['ego.poses'],
    });
  }
  const toleranceUs = (HISTORY_DT_S * 1e6) / 2;
  const wanted: number[] = [];
  for (let step = OBSERVATION_EGO_HISTORY_STEPS - 1; step >= 0; step -= 1) {
    wanted.push(clip.t0Us - step * HISTORY_DT_S * 1e6);
  }
  const picked: typeof poses = [];
  const missingInstants: string[] = [];
  for (const instantUs of wanted) {
    let best = poses[0]!;
    let bestDelta = Math.abs(poses[0]!.tUs - instantUs);
    for (const pose of poses) {
      const delta = Math.abs(pose.tUs - instantUs);
      if (delta < bestDelta) {
        best = pose;
        bestDelta = delta;
      }
    }
    if (bestDelta > toleranceUs) {
      missingInstants.push(`${((instantUs - clip.t0Us) / 1e6).toFixed(1)}s`);
      continue;
    }
    picked.push(best);
  }
  if (missingInstants.length > 0) {
    throw new ClipInputError({
      code: 'missing_fields',
      message:
        `ego history is incomplete: no pose within ${HISTORY_DT_S / 2}s of ${missingInstants.join(', ')} ` +
        `relative to t0 (need ${OBSERVATION_EGO_HISTORY_STEPS} poses at ${1 / HISTORY_DT_S} Hz)`,
      missingFields: ['ego.poses'],
    });
  }
  const t0 = picked[picked.length - 1]!;
  const cos0 = Math.cos(-t0.headingRad);
  const sin0 = Math.sin(-t0.headingRad);
  const xyz: number[][] = [];
  const rot: number[][][] = [];
  const tS: number[] = [];
  for (const pose of picked) {
    const dx = pose.x - t0.x;
    const dy = pose.y - t0.y;
    xyz.push([dx * cos0 - dy * sin0, dx * sin0 + dy * cos0, 0]);
    const dyaw = pose.headingRad - t0.headingRad;
    const c = Math.cos(dyaw);
    const s = Math.sin(dyaw);
    rot.push([
      [c, -s, 0],
      [s, c, 0],
      [0, 0, 1],
    ]);
    tS.push((pose.tUs - t0.tUs) / 1e6);
  }
  return { xyz, rot, tS };
}

/**
 * Build the wire observation for one item, or throw a typed refusal.
 *
 * `requiredCameras` is the model's declared camera set. Frames are passed as
 * absolute paths (`frames_paths`) because the engine is co-located with this
 * process in both hosts; that avoids a base64 copy of every frame per step.
 */
export function buildObservation(
  bundle: ObservationBundle,
  options: { requiredCameras?: readonly number[]; variableCameras?: boolean } = {},
): MaterializedItem {
  const { clip, directory } = bundle;
  if (clip.cameras.length === 0) {
    throw new ClipInputError({
      code: 'missing_fields',
      message:
        'clip has no camera streams with calibration and timestamps; driving inference needs per-camera frames. ' +
        'Video-only inputs can only run text tasks (VQA / meta-actions), which are not a driving evaluation.',
      missingFields: ['cameras'],
    });
  }
  const available = clip.cameras.map((camera) => camera.cameraId).sort((a, b) => a - b);
  const required = [...(options.requiredCameras ?? [])].sort((a, b) => a - b);
  if (required.length > 0) {
    const missing = required.filter((id) => !available.includes(id));
    if (missing.length > 0) {
      throw new ClipInputError({
        code: 'missing_fields',
        message: `clip is missing camera ids [${missing.join(', ')}]; the model requires [${required.join(', ')}] and the clip has [${available.join(', ')}]`,
        missingFields: missing.map((id) => `cameras[cameraId=${id}]`),
      });
    }
  }
  const selected = required.length > 0 && !options.variableCameras
    ? clip.cameras.filter((camera) => required.includes(camera.cameraId))
    : clip.cameras;

  const cameras: InvokeObservation['cameras'][number][] = [];
  for (const camera of [...selected].sort((a, b) => a.cameraId - b.cameraId)) {
    const frames = [...camera.frames].sort((a, b) => a.tUs - b.tUs).filter((frame) => frame.tUs <= clip.t0Us);
    if (frames.length < FRAMES_PER_CAMERA) {
      throw new ClipInputError({
        code: 'missing_fields',
        message: `camera ${camera.cameraId} has ${frames.length} frames at or before t0; the model needs ${FRAMES_PER_CAMERA}`,
        missingFields: [`cameras[cameraId=${camera.cameraId}].frames`],
      });
    }
    const window = frames.slice(-FRAMES_PER_CAMERA);
    const paths = window.map((frame) => path.resolve(directory, frame.path));
    const absent = paths.filter((framePath) => !existsSync(framePath));
    if (absent.length > 0) {
      throw new ClipInputError({
        code: 'input_error',
        message: `camera ${camera.cameraId} lists frames that are not in the bundle: ${absent.join(', ')}`,
        missingFields: absent,
      });
    }
    cameras.push({
      camera_id: camera.cameraId,
      frames_paths: paths,
      encoding: camera.encoding,
      width: camera.width,
      height: camera.height,
    });
  }

  const history = egoHistory(clip);
  const front = selected.find((camera) => camera.cameraId === 1) ?? selected[0]!;
  const projection =
    front.intrinsics && front.extrinsicsRigFromCamera
      ? {
          cameraId: front.cameraId,
          K: front.intrinsics.K,
          distortion: { model: front.intrinsics.model, coeffs: front.intrinsics.coeffs },
          extrinsicsRigFromCamera: front.extrinsicsRigFromCamera,
          imageSize: [front.width, front.height] as [number, number],
          timestampsUs: front.frames.map((frame) => frame.tUs),
        }
      : null;

  return {
    obs: {
      cameras,
      ego_history_xyz: history.xyz,
      ego_history_rot: history.rot,
      ego_history_t_s: history.tS,
      ...(clip.navText ? { nav_text: clip.navText } : {}),
    },
    cameraIds: cameras.map((camera) => camera.camera_id),
    reference: clip.reference,
    projection,
    digest: bundle.digest,
    video: clip.video ? path.resolve(directory, clip.video) : null,
  };
}

/**
 * Frames-only observation for a text task.
 *
 * Text tasks (VQA, meta-actions, auto-labelling) consume frames alone, so a
 * video-only bundle can serve them — and only them. No ego history is
 * supplied, and the caller must never present the answer as a driving score.
 */
export function buildTextObservation(bundle: ObservationBundle): MaterializedItem {
  const { clip, directory } = bundle;
  if (clip.cameras.length === 0) {
    throw new ClipInputError({
      code: 'missing_fields',
      message: 'clip has no frames at all; nothing can be evaluated',
      missingFields: ['cameras'],
    });
  }
  const cameras: InvokeObservation['cameras'][number][] = [];
  for (const camera of [...clip.cameras].sort((a, b) => a.cameraId - b.cameraId)) {
    const window = [...camera.frames].sort((a, b) => a.tUs - b.tUs).slice(-FRAMES_PER_CAMERA);
    cameras.push({
      camera_id: camera.cameraId,
      frames_paths: window.map((frame) => path.resolve(directory, frame.path)),
      encoding: camera.encoding,
      width: camera.width,
      height: camera.height,
    });
  }
  return {
    obs: { cameras },
    cameraIds: cameras.map((camera) => camera.camera_id),
    reference: { kind: 'none', dtS: HISTORY_DT_S, points: [] },
    projection: null,
    digest: bundle.digest,
    video: clip.video ? path.resolve(directory, clip.video) : null,
  };
}
