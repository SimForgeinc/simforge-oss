import cameraProfiles from '../../../../../adapters/gym/simforge_oss_gym/camera_profiles.json' with { type: 'json' };

/** Camera rigs shared by every drive policy. Coordinates are engine-frame metres. */
export interface CameraSpec {
  readonly sensorId: string;
  readonly cameraId: number;
  readonly fwd: number;
  readonly left: number;
  readonly up: number;
  readonly yawDeg: number;
  readonly pitchDeg?: number;
  readonly hfov: number;
  readonly width: number;
  readonly height: number;
}

export const WIDTH = cameraProfiles.width;
export const HEIGHT = cameraProfiles.height;

/** One packaged calibration registry shared with Python's Episode presets. */
export const PROFILES: Readonly<Record<string, readonly CameraSpec[]>> = cameraProfiles.profiles;

export function getProfile(name: string): readonly CameraSpec[] {
  const profile = PROFILES[name];
  if (!profile) throw new Error(`unknown camera profile ${name}; known profiles: ${Object.keys(PROFILES).join(', ')}`);
  return profile;
}
