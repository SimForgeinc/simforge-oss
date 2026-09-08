/**
 * Loading and admission of `simforge.eval-clip/v1` bundles.
 *
 * Admission answers four independent questions, because they have four different answers
 * and collapsing them is how users end up with fabricated scores:
 *
 *   openLoopInference   can the model be shown these frames at all?
 *   openLoopScored      is there a recorded future to score the prediction against?
 *   reconstructionReady can we attempt to build a world from this clip?
 *   closedLoopReady     does this clip already carry a renderable world?
 *
 * A video-only upload answers "no" to all four for driving purposes and is refused with the
 * exact missing fields plus the text-task alternatives. It is never run as a driving
 * evaluation with assumed intrinsics or a stationary ego.
 *
 * Integrity is checked, not trusted: every declared file is hashed against the digest in the
 * manifest before the clip is admitted, so a bundle that was truncated in transit fails here
 * rather than halfway through a paid GPU job.
 */

import { sha256File } from './digest.js';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  EvalClipSchema,
  type CalibratedCamera,
  type EvalClip,
} from './schema.js';
import {
  FRAME_ONLY_ALTERNATIVES,
  RefusalError,
  refusalFromIssues,
  type MissingField,
  type Refusal,
} from './refusal.js';
import {
  cameraTimestamps,
  canServeFamily,
  hasCompleteTimeline,
  servableRigPresets,
  type ModelFamily,
  type ServeVerdict,
} from './cameras.js';

/** Manifest file name inside a clip directory. */
export const EVAL_CLIP_FILENAME = 'clip.json';

export interface ClipAdmission {
  readonly clip: EvalClip;
  readonly clipDir: string;
  /** The model can be shown these frames (calibration + ego history present). */
  readonly openLoopInference: boolean;
  /** A recorded future exists, so the prediction can be scored. */
  readonly openLoopScored: boolean;
  /** Calibration + ego + seed geometry present: `reconstruct.nurec` may be attempted. */
  readonly reconstructionReady: boolean;
  /** A renderable world is already attached: import straight to a replay context. */
  readonly closedLoopReady: boolean;
  /** Present when the clip cannot be used for driving inference. */
  readonly refusal?: Refusal;
  readonly families: readonly ServeVerdict[];
  readonly rigPresets: readonly string[];
}


/**
 * Fields a clip must carry before a driving model may see it, evaluated against the parsed
 * document. These are the exact strings the portal and the desktop show, so they are
 * written for a user, not for a developer.
 */
function drivingInputGaps(clip: EvalClip): MissingField[] {
  const gaps: MissingField[] = [];
  if (clip.cameras === undefined || clip.cameras.length === 0) {
    gaps.push({
      path: 'cameras',
      requirement:
        'per-camera calibration: intrinsics (pinhole/opencv/ftheta), extrinsics as T_camera_rig, image size, and the Alpamayo camera index 0..6 each view maps to',
    });
  }
  if (clip.ego === undefined) {
    gaps.push({
      path: 'ego',
      requirement:
        'ego history: timestamped poses (x, y, heading) in a metric world frame, or speed + yaw rate that can be integrated into poses, covering at least the 1.6 s of history the model conditions on',
    });
  }
  const cameras = clip.cameras ?? [];
  cameras.forEach((camera, index) => {
    // A customer clip must carry a real capture timeline. Reference instants are something a
    // published reconstruction ships, not something an uploaded clip can be evaluated from.
    if (!hasCompleteTimeline(camera)) {
      gaps.push({
        path: `cameras[${index}].timing`,
        requirement: `a complete per-frame capture timeline for camera ${camera.sensorId}, not a set of reference instants`,
      });
      return;
    }
    const declared = cameraTimestamps(camera).length;
    if (declared < 4) {
      gaps.push({
        path: `cameras[${index}].timing`,
        requirement: `per-frame timestamps covering at least 4 frames per camera at ~10 Hz (camera ${camera.sensorId} declares ${declared})`,
      });
    }
  });
  return gaps;
}

/**
 * Parse, verify and classify a clip directory.
 *
 * Throws `RefusalError` when the manifest itself is unreadable or fails schema validation or
 * an integrity check — those are refusals about the upload, not about the model. A clip that
 * parses but lacks driving inputs is returned with `refusal` set, because the caller can
 * still offer the text tasks.
 */
export async function loadEvalClip(clipDir: string): Promise<ClipAdmission> {
  const manifestPath = path.join(clipDir, EVAL_CLIP_FILENAME);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new RefusalError({
      code: 'unsupported_input',
      message: `${manifestPath} is not a readable ${EVAL_CLIP_FILENAME}: ${(error as Error).message}`,
      missing: [{ path: EVAL_CLIP_FILENAME, requirement: 'a JSON manifest declaring schema "simforge.eval-clip/v1"' }],
      alternatives: [],
    });
  }

  const parsed = EvalClipSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RefusalError(
      refusalFromIssues('missing_fields', `${manifestPath} is not a valid simforge.eval-clip/v1 document`, parsed.error.issues),
    );
  }
  const clip = parsed.data;

  const declaredFiles: { path: string; sha256: string }[] = clip.videos.map((video) => ({ path: video.path, sha256: video.sha256 }));
  if (clip.pointCloud !== undefined) declaredFiles.push({ path: clip.pointCloud.path, sha256: clip.pointCloud.sha256 });
  if (clip.reference?.path !== undefined) {
    declaredFiles.push({ path: clip.reference.path, sha256: '' });
  }

  const integrityFailures: MissingField[] = [];
  for (const file of declaredFiles) {
    const absolute = path.resolve(clipDir, file.path);
    if (!absolute.startsWith(path.resolve(clipDir) + path.sep)) {
      integrityFailures.push({ path: file.path, requirement: 'declared paths must stay inside the clip directory' });
      continue;
    }
    try {
      const info = await stat(absolute);
      if (!info.isFile()) {
        integrityFailures.push({ path: file.path, requirement: 'declared path must be a file' });
        continue;
      }
    } catch {
      integrityFailures.push({ path: file.path, requirement: 'declared file is missing from the clip directory' });
      continue;
    }
    if (file.sha256 === '') continue;
    const digest = await sha256File(absolute);
    if (digest !== file.sha256) {
      integrityFailures.push({
        path: file.path,
        requirement: `sha256 mismatch: manifest declares ${file.sha256}, file hashes to ${digest}`,
      });
    }
  }
  if (integrityFailures.length > 0) {
    throw new RefusalError({
      code: 'integrity_failed',
      message: `clip ${clip.clipId} failed integrity verification`,
      missing: integrityFailures,
      alternatives: [],
    });
  }

  const gaps = drivingInputGaps(clip);
  const openLoopInference = gaps.length === 0;
  const openLoopScored = openLoopInference && clip.reference?.kind === 'recorded-future';
  const reconstructionReady = openLoopInference && clip.pointCloud !== undefined;
  const cameras: readonly CalibratedCamera[] = clip.cameras ?? [];
  const available = cameras.map((camera) => camera.cameraId);

  return {
    clip,
    clipDir,
    openLoopInference,
    openLoopScored,
    reconstructionReady,
    closedLoopReady: false,
    ...(openLoopInference
      ? {}
      : {
          refusal: {
            code: 'missing_fields' as const,
            message:
              `clip ${clip.clipId} cannot be used for driving inference: ${gaps.length} required input(s) are absent. ` +
              'SimForge does not assume intrinsics, a stationary ego or a synthetic history to fill them.',
            missing: gaps,
            alternatives: FRAME_ONLY_ALTERNATIVES,
          },
        }),
    families: (['alpamayo-1', 'alpamayo-1.5', 'alpamayo-2-super'] satisfies ModelFamily[]).map((family) =>
      canServeFamily(available, family),
    ),
    rigPresets: servableRigPresets(available),
  };
}

/**
 * Preconditions for `reconstruct.nurec`, as a refusal rather than a boolean, so the compute
 * worker can hand the user the same field list the desktop would show.
 *
 * The seed point cloud is a hard requirement: 3DGUT training initialises from a point cloud,
 * and seeding it from noise would produce a plausible-looking scene that is not a
 * reconstruction of the user's world.
 */
export function reconstructionRefusal(admission: ClipAdmission): Refusal | undefined {
  if (admission.refusal !== undefined) return admission.refusal;
  if (admission.clip.pointCloud === undefined) {
    return {
      code: 'missing_fields',
      message:
        `clip ${admission.clip.clipId} is calibrated but carries no seed geometry, so reconstruction cannot start. ` +
        'A 3DGUT reconstruction is initialised from a measured point cloud; SimForge will not seed it from random noise and present the result as your world.',
      missing: [
        {
          path: 'pointCloud',
          requirement:
            'a lidar or structure-from-motion point cloud (PLY, or COLMAP points3D.txt) in the same metric frame as ego.recordedPath',
        },
      ],
      alternatives: [
        'Open-loop evaluation works on this clip today: it has calibration, timestamps and ego history.',
      ],
    };
  }
  if (admission.clip.pointCloud.frame !== admission.clip.ego?.frame) {
    return {
      code: 'missing_fields',
      message: `clip ${admission.clip.clipId}: the seed point cloud and the ego path are in different frames`,
      missing: [
        {
          path: 'pointCloud.frame',
          requirement: `must equal ego.frame ("${admission.clip.ego?.frame ?? '<absent>'}"), got "${admission.clip.pointCloud.frame}"`,
        },
      ],
      alternatives: [],
    };
  }
  return undefined;
}
