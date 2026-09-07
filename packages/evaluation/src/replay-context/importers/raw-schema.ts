/**
 * Schemas for the documents we read but do not own.
 *
 * A NuRec scene directory and a NuRec package are external inputs — produced by an importer
 * run at some earlier time, or by NVIDIA's own pipeline at some release. Parsing them through
 * a schema rather than casting means a malformed or unexpectedly-shaped document produces a
 * field-level complaint the user can act on, instead of `undefined` propagating into a bundle
 * that looks valid and renders wrong.
 *
 * Every schema is deliberately *loose*: only the fields this module consumes are declared,
 * and unknown keys are preserved rather than rejected. These documents legitimately carry
 * much more than we read, and new upstream fields must not break an import.
 */

import { z } from 'zod';

const Num = z.number().finite();

/** `background.json` from an imported scene directory. */
export const RawBackgroundSchema = z.looseObject({
  provider: z.string().optional(),
  sceneId: z.string().optional(),
  sourceUsdz: z.string().optional(),
  sourceUsdzSha256: z.string().optional(),
  digest: z.string().optional(),
  cameraShutterDurationUs: Num.optional(),
  rigCentroid: z.array(Num).optional(),
  actorTracks: z.record(z.string(), z.string()).optional(),
  episode: z.looseObject({ startTimestampUs: Num.optional(), durationS: Num.optional() }).optional(),
  metadata: z.looseObject({ nreSceneId: z.string().optional() }).optional(),
});
export type RawBackground = z.infer<typeof RawBackgroundSchema>;

/** One sensor of `camera-rig.json`. */
export const RawRigSensorSchema = z.looseObject({
  id: z.string(),
  projection: z.looseObject({
    type: z.string().optional(),
    width: Num.optional(),
    height: Num.optional(),
    principalPoint: z.array(Num).optional(),
    pixeldistToAnglePoly: z.array(Num).optional(),
    angleToPixeldistPoly: z.array(Num).optional(),
    maxAngleRad: Num.optional(),
    linearCde: z.array(Num).optional(),
    tSensorRig: z.array(Num).optional(),
    shutter: z.looseObject({ durationUs: Num.optional() }).optional(),
  }).optional(),
});
export type RawRigSensor = z.infer<typeof RawRigSensorSchema>;

export const RawCameraRigSchema = z.looseObject({ sensors: z.array(RawRigSensorSchema).optional() });

/** `ego-reference.json`: recorded ego samples in the SimForge scene frame. */
export const RawEgoSchema = z.looseObject({
  samples: z.array(z.looseObject({
    x: Num,
    z: Num,
    headingRad: Num,
    speedMps: Num.optional(),
    sourceTimestampUs: Num,
  })).optional(),
});

/** `actor-trajectories.json`: recorded tracks in the same frame. */
export const RawActorsSchema = z.looseObject({
  actors: z.record(z.string(), z.looseObject({
    kind: z.string().optional(),
    sourceClass: z.string().optional(),
    dims: z.looseObject({ l: Num, w: Num, h: Num }).optional(),
    samples: z.array(z.looseObject({
      x: Num,
      z: Num,
      headingRad: Num,
      speedMps: Num.optional(),
      sourceTimestampUs: Num,
    })).optional(),
  })).optional(),
});

/* ------------------------------------------------------- package members */

/**
 * `rig_trajectories.json` inside a NuRec package.
 *
 * `camera_model.parameters` stays `unknown` on purpose: the f-theta parameter block is
 * spelled differently across releases, and the importer's extractor inspects it explicitly so
 * that an unrecognised spelling drops the camera with a readable reason rather than passing a
 * half-filled calibration downstream.
 */
export const RawRigTrajectoriesSchema = z.looseObject({
  camera_calibrations: z.record(z.string(), z.looseObject({
    logical_sensor_name: z.string().optional(),
    unique_sensor_idx: Num.optional(),
    T_sensor_rig: z.array(z.array(Num)).optional(),
    camera_model: z.looseObject({
      type: z.string().optional(),
      parameters: z.record(z.string(), z.unknown()).optional(),
    }).optional(),
  })).optional(),
  rig_trajectories: z.array(z.looseObject({
    T_rig_worlds: z.array(z.array(z.array(Num))).optional(),
    T_rig_world_timestamps_us: z.array(Num).optional(),
  })).optional(),
});

/** `sequence_tracks.json` inside a NuRec package, keyed by sequence id. */
export const RawSequenceTracksSchema = z.record(
  z.string(),
  z.looseObject({
    tracks_data: z.looseObject({
      tracks_id: z.array(z.union([z.string(), Num])).optional(),
      tracks_label_class: z.array(z.string()).optional(),
      tracks_timestamps_us: z.array(z.array(Num)).optional(),
      tracks_poses: z.array(z.array(z.array(Num))).optional(),
    }).optional(),
    cuboidtracks_data: z.looseObject({ cuboids_dims: z.array(z.array(Num)).optional() }).optional(),
  }),
);
