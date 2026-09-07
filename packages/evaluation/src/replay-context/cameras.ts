/**
 * Which model families a clip or bundle can actually serve.
 *
 * Camera identity on the inference wire is an integer 0..6 and nothing else
 * (`ALPAMAYO_CAMERA_INDEX` in `@simforge-oss/scenario`, mirrored in
 * `adapters/alpamayo/src/simforge_alpamayo/bridge.py`). A family either requires an exact
 * set of those integers or accepts a variable subset. Serving capability is therefore a
 * set comparison, and the answer to "can this scene run Alpamayo 1?" is decidable from the
 * bundle alone — no renderer, no model, no download.
 *
 * A camera the source does not have is never manufactured to satisfy a profile. A
 * three-camera clip cannot serve Alpamayo 1; it reports exactly which indices are missing.
 */

import { ALPAMAYO_CAMERA_INDEX, type AlpamayoCameraName } from '@simforge-oss/scenario';

import type { CalibratedCamera } from './schema.js';

/** Model families as named in the model lock and registry. */
export type ModelFamily = 'alpamayo-1' | 'alpamayo-1.5' | 'alpamayo-2-super';

interface FamilyCameraProfile {
  /** Exactly these indices must be present; `null` when the family accepts a variable set. */
  readonly required: readonly number[] | null;
  /** Used when the family is variable and the caller expressed no preference. */
  readonly preferred: readonly number[];
  /** Lower bound for variable families. */
  readonly minCameras: number;
}

/**
 * Per-family camera requirements, from the upstream model cards and inference code
 * (see the evaluation plan §1.2/§4.5): A1 is fixed four-camera, A1.5 accepts a variable
 * count with a four-camera default, A2 trajectory inference is fixed six-camera.
 */
const FAMILY_CAMERA_PROFILE: Record<ModelFamily, FamilyCameraProfile> = {
  'alpamayo-1': { required: [0, 1, 2, 6], preferred: [0, 1, 2, 6], minCameras: 4 },
  'alpamayo-1.5': { required: null, preferred: [0, 1, 2, 6], minCameras: 1 },
  'alpamayo-2-super': { required: [0, 1, 2, 3, 5, 6], preferred: [0, 1, 2, 3, 5, 6], minCameras: 6 },
};

/** Authored rig presets and the camera indices they cover. */
const RIG_PRESET_CAMERAS: Record<string, readonly number[]> = {
  'alpamayo-2cam': [1, 6],
  'alpamayo-4cam': [0, 1, 2, 6],
  'alpamayo-6cam': [0, 1, 2, 3, 5, 6],
  'alpamayo-6cam-vqa': [0, 1, 2, 3, 4, 5],
};

/** Reverse of `ALPAMAYO_CAMERA_INDEX`, for turning a wire index back into a sensor name. */
const CAMERA_NAME_BY_INDEX: Record<number, AlpamayoCameraName> = Object.fromEntries(
  Object.entries(ALPAMAYO_CAMERA_INDEX).map(([name, index]) => [index, name as AlpamayoCameraName]),
) as Record<number, AlpamayoCameraName>;

/** Dataset sensor name for a wire camera index, or `undefined` for an index outside 0..6. */
export function cameraName(cameraId: number): AlpamayoCameraName | undefined {
  return CAMERA_NAME_BY_INDEX[cameraId];
}

/** Wire camera index for a dataset sensor name, or `undefined` when the name is unknown. */
export function cameraIndex(sensorId: string): number | undefined {
  return (ALPAMAYO_CAMERA_INDEX as Record<string, number>)[sensorId];
}

export interface ServeVerdict {
  readonly family: ModelFamily;
  readonly canServe: boolean;
  /** Indices the family requires that this scene does not have. */
  readonly missingCameras: readonly number[];
  /** The camera set that would be used, when `canServe`. */
  readonly cameras: readonly number[];
  readonly reason?: string;
}

/**
 * Can a scene with `available` camera indices serve `family`?
 *
 * Extra cameras are fine (they are simply not used); missing required ones are fatal and
 * enumerated. For a variable family the intersection with the preferred set is used, and
 * an empty intersection is a refusal rather than a zero-camera observation.
 */
export function canServeFamily(available: readonly number[], family: ModelFamily): ServeVerdict {
  const profile = FAMILY_CAMERA_PROFILE[family];
  const have = new Set(available);
  if (profile.required !== null) {
    const missing = profile.required.filter((id) => !have.has(id));
    if (missing.length > 0) {
      return {
        family,
        canServe: false,
        missingCameras: missing,
        cameras: [],
        reason: `${family} requires cameras [${profile.required.join(', ')}]; missing [${missing.join(', ')}]`,
      };
    }
    return { family, canServe: true, missingCameras: [], cameras: profile.required };
  }
  const usable = profile.preferred.filter((id) => have.has(id));
  const cameras = usable.length > 0 ? usable : [...available].sort((a, b) => a - b);
  if (cameras.length < profile.minCameras) {
    return {
      family,
      canServe: false,
      missingCameras: [],
      cameras: [],
      reason: `${family} needs at least ${profile.minCameras} camera(s); the scene has ${cameras.length}`,
    };
  }
  return { family, canServe: true, missingCameras: [], cameras };
}

/** Every family verdict for a scene, so a UI can render the capability matrix from one call. */
export function servableFamilies(available: readonly number[]): readonly ServeVerdict[] {
  return (Object.keys(FAMILY_CAMERA_PROFILE) as ModelFamily[]).map((family) => canServeFamily(available, family));
}

/** Rig presets a scene's cameras fully cover. */
export function servableRigPresets(available: readonly number[]): readonly string[] {
  const have = new Set(available);
  return Object.entries(RIG_PRESET_CAMERAS)
    .filter(([, cameras]) => cameras.every((id) => have.has(id)))
    .map(([preset]) => preset);
}

/**
 * Capture timestamps of a camera, whichever way its timing was declared.
 *
 * A constant-rate declaration is expanded here rather than at each call site so the two
 * consumers that need per-frame times — dynamics/time alignment (G4) and the reconstruction
 * dataset writer — cannot drift in how they round.
 */
export function cameraTimestamps(camera: CalibratedCamera): number[] {
  const timing = camera.timing;
  if (timing.kind === 'explicit') return [...timing.timestampsUs];
  return Array.from({ length: timing.frameCount }, (_, frame) =>
    Math.round(timing.offsetUs + (frame * 1e6) / timing.fps));
}
