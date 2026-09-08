/**
 * User bundle importer: a user-supplied `simforge.eval-clip/v1` that already carries a
 * renderable world becomes a `simforge.replay-context/v1` bundle.
 *
 * This is the path for a customer who reconstructed their own clip elsewhere (or received a
 * NuRec package with it) and wants to run closed loop on it. It performs no reconstruction —
 * that is `reconstruct.ts` — and it grants no trust: the clip's own calibration, ego path and
 * tracks are carried across, the geometry package is hashed, and the bundle still has to earn
 * its envelope through the gates.
 *
 * The refusals here are the ones a user actually hits: a clip with no calibration or no ego
 * history (reported by `loadEvalClip`), and a clip with both but no geometry — which can be
 * evaluated open-loop today and becomes closed-loop capable only after a reconstruction.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';

import { measureDynamicsConsistency, measureEgoHistoryParity } from '../envelope.js';
import { DEFAULT_GATE_THRESHOLDS, gateG3, gateG4, type GateThresholds } from '../gates.js';
import { sha256File } from '../digest.js';
import { RefusalError } from '../refusal.js';
import {
  REPLAY_CONTEXT_SCHEMA,
  ReplayContextSchema,
  type Dynamics,
  type GateId,
  type GateVerdict,
  type MapContext,
  type ReplayContext,
} from '../schema.js';
import type { ClipAdmission } from '../clip.js';

export const USER_BUNDLE_IMPORTER = { name: 'simforge.replay-context.user-bundle-importer', version: '1' } as const;

export interface UserBundleImportOptions {
  readonly admission: ClipAdmission;
  /**
   * Renderable geometry for the clip, relative to the clip directory or absolute. When the
   * clip was reconstructed by us this is the exported NuRec package.
   */
  readonly geometryPackage: string;
  readonly thresholds?: GateThresholds;
  /** Recorded when the geometry came from our own reconstruction rather than the user. */
  readonly reconstruction?: NonNullable<ReplayContext['source']['importer']['reconstruction']>;
}


/**
 * Build a replay context from an admitted clip plus its geometry.
 *
 * The clip's `dynamics` is optional in the clip schema but mandatory in a replay context —
 * with one honest exception, an explicitly empty track list. A scene with no other road users
 * is a real (if unusual) recording; a scene whose actors were simply never tracked is not,
 * and the two are distinguished by the user declaring `dynamics` with zero tracks rather than
 * omitting it.
 */
export async function importUserBundle(options: UserBundleImportOptions): Promise<ReplayContext> {
  const { admission } = options;
  if (admission.refusal !== undefined) throw new RefusalError(admission.refusal);
  const { clip, clipDir } = admission;
  if (clip.cameras === undefined || clip.ego === undefined) {
    throw new RefusalError({
      code: 'missing_fields',
      message: `clip ${clip.clipId} is missing calibration or ego history`,
      missing: [
        ...(clip.cameras === undefined ? [{ path: 'cameras', requirement: 'per-camera calibration' }] : []),
        ...(clip.ego === undefined ? [{ path: 'ego', requirement: 'timestamped ego poses' }] : []),
      ],
      alternatives: [],
    });
  }
  if (clip.dynamics === undefined) {
    throw new RefusalError({
      code: 'missing_fields',
      message:
        `clip ${clip.clipId} carries no dynamic-actor tracks, so a closed loop would replay an empty world. `
        + 'If the recording genuinely had no other road users, declare dynamics with an empty tracks list.',
      missing: [
        {
          path: 'dynamics',
          requirement: 'tracked dynamic actors with timestamped poses, boxes and classes, or an explicit empty tracks list',
        },
      ],
      alternatives: ['Open-loop evaluation does not need actor tracks and works on this clip today.'],
    });
  }

  const geometryPath = path.isAbsolute(options.geometryPackage)
    ? options.geometryPackage
    : path.resolve(clipDir, options.geometryPackage);
  let bytes = 0;
  try {
    const info = await stat(geometryPath);
    if (!info.isFile()) throw new Error('not a file');
    bytes = info.size;
  } catch {
    throw new RefusalError({
      code: 'missing_fields',
      message:
        `clip ${clip.clipId} has no renderable world at ${geometryPath}, so it cannot run closed loop. `
        + 'A video and its calibration describe the drive that happened, not the drives a policy might take instead.',
      missing: [
        {
          path: 'geometry',
          requirement:
            'a NuRec .usdz reconstruction of the scene — supply one, or run reconstruct.nurec on this clip (it also needs a seed point cloud)',
        },
      ],
      alternatives: ['Open-loop evaluation works on this clip today.'],
    });
  }
  const digest = await sha256File(geometryPath);

  const dynamics: Dynamics = clip.dynamics;
  const map: MapContext = clip.map ?? { source: 'derived-from-reconstruction', confidence: 'low' };

  const draft: ReplayContext = {
    schema: REPLAY_CONTEXT_SCHEMA,
    sceneId: clip.clipId,
    source: {
      ...clip.source,
      kind: options.reconstruction === undefined ? 'user-bundle' : 'reconstructed',
      sceneId: clip.clipId,
      inputs: [
        ...clip.source.inputs,
        { path: path.relative(clipDir, geometryPath) || geometryPath, sha256: digest, bytes },
      ],
      importer: {
        ...USER_BUNDLE_IMPORTER,
        ...(options.reconstruction === undefined ? {} : { reconstruction: options.reconstruction }),
      },
    },
    cameras: [...clip.cameras].sort((a, b) => a.cameraId - b.cameraId),
    ego: clip.ego,
    dynamics,
    geometry: {
      kind: 'nurec-usdz',
      sourcePackage: geometryPath,
      sourcePackageSha256: digest,
      renderer: 'nurec-splat-renderer',
    },
    map,
    validity: {
      qualified: false,
      // No profile has been measured yet; qualification is always for a camera set.
      profileCameraIds: [],
      envelope: { lateralM: 0, longitudinalS: 0, headingRad: 0 },
      gates: {},
      envelopeBasis: { offsetsTestedM: [], headingsTestedRad: [], largestPassingLateralM: 0, largestPassingHeadingRad: 0 },
    },
  };

  const thresholds = options.thresholds ?? DEFAULT_GATE_THRESHOLDS;
  const gates: Partial<Record<GateId, GateVerdict>> = {
    G3: gateG3(measureEgoHistoryParity(draft), thresholds),
    G4: gateG4(measureDynamicsConsistency(draft), thresholds),
  };
  return ReplayContextSchema.parse({ ...draft, validity: { ...draft.validity, gates } });
}
