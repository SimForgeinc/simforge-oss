/**
 * `manualDrive` — a recorded take of a human driving one actor.
 *
 * The Manual drive route variant stores what the native simulation actually
 * did while a person drove the actor for the whole clip: one sample per engine
 * tick, at the engine's own clock, from `t = 0` through `t = clipSeconds`.
 * Replay hands the actor's pose to this track for the entire clip, so the
 * recording is *the* motion — not a hint the engine re-solves, and not the
 * inputs that produced it.
 *
 * ## Frame
 *
 * Samples are in the y-up scene frame in metres: `x`/`z` are the ground-plane
 * coordinates every other scene-absolute payload uses, `y` is the physics
 * height of the body. The native engine is planar, so the truth stream
 * reports `y = 0` and that is the only value a take may carry: render ground
 * placement is derived from the map at (x, z), exactly as it was while the
 * take was recorded, and is not recorded. A nonzero `y` is an unsupported
 * recorded elevation and is rejected rather than ignored.
 * `headingRad` is the body yaw, CCW about `+Y` from `+X`, frame-invariant with
 * the engine's heading and unnormalised (replay normalises). `speedMps` is the
 * *signed* longitudinal speed along the body heading: negative while
 * reversing, so a reversing car keeps its recorded yaw instead of being
 * flipped to face its direction of travel.
 *
 * ## Why the bounds are what they are
 *
 * `MANUAL_DRIVE_MAX_SAMPLES` is the longest clip the choreography allows
 * (120 s) at the fixed instance step every materialised document runs at
 * (0.02 s), plus the closing sample. A take that exceeds it is rejected, never
 * thinned: simplifying a recording would change the motion it claims to
 * reproduce.
 */

import { z } from 'zod-v4';

/** The only recording format this schema accepts. */
export const MANUAL_DRIVE_RECORDING_VERSION = 1;

/** Fixed integration step of a materialised instance, seconds. */
const INSTANCE_DT_S = 0.02;
/** `ChoreographySchema.clipSeconds` ceiling, seconds. */
const CLIP_SECONDS_MAX = 120;

/** Longest clip at the instance tick rate, plus the sample at `clipSeconds`. */
export const MANUAL_DRIVE_MAX_SAMPLES = Math.round(CLIP_SECONDS_MAX / INSTANCE_DT_S) + 1;

/** A take must at least pin the start and the end of the clip. */
export const MANUAL_DRIVE_MIN_SAMPLES = 2;

/** Tolerance on the recording's clock against the clip clock, seconds. */
const TIME_TOLERANCE_S = 1e-6;

/** One engine tick of recorded actor state, y-up scene frame. */
export const ManualDriveSampleSchema = z.strictObject({
  /** Authoritative simulation time, seconds since clip start. */
  timeS: z.number().finite().min(0),
  x: z.number().finite(),
  /** Physics height, metres; the planar engine records 0. */
  y: z.number().finite(),
  z: z.number().finite(),
  /** Body yaw, radians, CCW about `+Y` from `+X`. */
  headingRad: z.number().finite(),
  /** Signed longitudinal speed along the body heading; negative = reversing. */
  speedMps: z.number().finite(),
});

/** A complete take. */
export const ManualDriveRecordingSchema = z.strictObject({
  version: z.literal(MANUAL_DRIVE_RECORDING_VERSION),
  /** Clip length the take was driven against; must equal the choreography's. */
  clipSeconds: z.number().finite().positive(),
  samples: z.array(ManualDriveSampleSchema)
    .min(MANUAL_DRIVE_MIN_SAMPLES)
    .max(MANUAL_DRIVE_MAX_SAMPLES),
});

/** One recorded tick. */
export type ManualDriveSample = z.infer<typeof ManualDriveSampleSchema>;
/** A recorded take. */
export type ManualDriveRecording = z.infer<typeof ManualDriveRecordingSchema>;

/** Verdict of {@link validateManualDriveRecording}. */
export type ManualDriveRecordingVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly path: string; readonly message: string };

function reject(path: string, message: string): ManualDriveRecordingVerdict {
  return { ok: false, path, message };
}

/**
 * The rules zod cannot state: the take covers exactly `[0, clipSeconds]` on a
 * strictly increasing clock and was driven against this clip's length.
 *
 * `path` is relative to the recording (`samples.3.timeS`), so callers prefix
 * their own location. The structural validator and the editor's commit gate
 * both run this, so a take is refused with one rule everywhere.
 */
export function validateManualDriveRecording(
  recording: ManualDriveRecording,
  clipSeconds: number,
): ManualDriveRecordingVerdict {
  if (recording.version !== MANUAL_DRIVE_RECORDING_VERSION) {
    return reject('version', `unsupported manual drive recording version ${String(recording.version)}`);
  }
  if (!Number.isFinite(recording.clipSeconds) || recording.clipSeconds <= 0) {
    return reject('clipSeconds', 'recording clipSeconds must be a positive finite number');
  }
  if (Math.abs(recording.clipSeconds - clipSeconds) > TIME_TOLERANCE_S) {
    return reject(
      'clipSeconds',
      `take was driven against a ${recording.clipSeconds}s clip, but the choreography is ${clipSeconds}s; re-record it`,
    );
  }
  const samples = recording.samples;
  if (samples.length < MANUAL_DRIVE_MIN_SAMPLES) {
    return reject('samples', `a take needs at least ${MANUAL_DRIVE_MIN_SAMPLES} samples`);
  }
  if (samples.length > MANUAL_DRIVE_MAX_SAMPLES) {
    return reject(
      'samples',
      `take has ${samples.length} samples, above the ${MANUAL_DRIVE_MAX_SAMPLES} supported for a ${CLIP_SECONDS_MAX}s clip at ${INSTANCE_DT_S}s`,
    );
  }
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!;
    for (const key of ['timeS', 'x', 'y', 'z', 'headingRad', 'speedMps'] as const) {
      if (!Number.isFinite(sample[key])) {
        return reject(`samples.${index}.${key}`, `sample ${key} must be finite`);
      }
    }
    if (sample.y !== 0) {
      return reject(`samples.${index}.y`, `unsupported recorded elevation ${sample.y}: the planar engine has no height state, so recorded y must be 0 (render ground placement stays map-derived)`);
    }
    if (index > 0 && sample.timeS <= samples[index - 1]!.timeS) {
      return reject(`samples.${index}.timeS`, 'sample times must be strictly increasing');
    }
  }
  if (Math.abs(samples[0]!.timeS) > TIME_TOLERANCE_S) {
    return reject('samples.0.timeS', `a take starts at t=0s, not t=${samples[0]!.timeS}s`);
  }
  const last = samples[samples.length - 1]!;
  if (Math.abs(last.timeS - recording.clipSeconds) > TIME_TOLERANCE_S) {
    return reject(
      `samples.${samples.length - 1}.timeS`,
      `a take ends at t=${recording.clipSeconds}s (the clip end), not t=${last.timeS}s`,
    );
  }
  return { ok: true };
}
