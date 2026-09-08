/**
 * Clip and replayable-scene input contracts.
 *
 * Two documents, one direction of travel:
 *
 *   `simforge.eval-clip/v1`       what a user (or a dataset export) hands us: recorded
 *                                 frames plus the sidecars that make them metrically
 *                                 interpretable. Open-loop capable when calibration +
 *                                 ego history are present; scored only with a reference
 *                                 future.
 *   `simforge.replay-context/v1`  what a closed loop can actually execute: the clip's
 *                                 geometry/appearance reconstruction, calibration, ego
 *                                 reference path, dynamic tracks, lane/route context and
 *                                 the measured bounded region within which renders off the
 *                                 recorded trajectory are trustworthy.
 *
 * The second is never inferred from the first. An importer produces it from a
 * reconstruction that exists (NuRec/AlpaSim package, or one we reconstructed), and the
 * validity block is written by measurement (see `gates.ts`), never by assertion. A bundle
 * whose gates have not run is `validity.qualified === false` and must not be used for a
 * scored model episode.
 *
 * Field paths under `validity.envelope`, `ego.recordedPath`, `ego.originUs`, `ego.endUs`
 * and `cameras[].cameraId` are a frozen cross-owner contract: the Python episode runner
 * (`adapters/gym/simforge_oss_gym/replay_envelope.py`) reads them straight out of
 * `<bundleDir>/replay-context.json` without importing any TypeScript. Renaming them is a
 * breaking change for that consumer.
 *
 * Nothing here fabricates a missing input. A clip without calibration/ego/timestamps is
 * refused with the exact dotted field list (`refusal.ts`); it is never padded with
 * assumed intrinsics, a synthetic ego history or invented labels.
 */

import { z } from 'zod';

/** Every document in this module carries its schema id verbatim. */
export const EVAL_CLIP_SCHEMA = 'simforge.eval-clip/v1' as const;
export const REPLAY_CONTEXT_SCHEMA = 'simforge.replay-context/v1' as const;

/** Canonical on-disk file name of a replay-context bundle. */
export const REPLAY_CONTEXT_FILENAME = 'replay-context.json';
/** Where `stockReplayGate` persists its verdict inside a bundle directory. */
export const STOCK_REPLAY_VERDICT_PATH = 'qualification/stock-replay.json';
/** Where `qualifyBundle` persists the full gate report inside a bundle directory. */
export const GATE_REPORT_PATH = 'qualification/validity-gates.json';

const Finite = z.number().finite();
const NonNegative = Finite.min(0);
/** Microsecond wall/scene timestamps are integers; float microseconds are a bug, not a rounding style. */
const TimestampUs = z.number().int();
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'expected lowercase sha256 hex');

/* --------------------------------------------------------------- calibration */

/**
 * Camera intrinsics. Three models are accepted because they are the three we can actually
 * consume end to end: `pinhole` and `opencv` map onto COLMAP `PINHOLE`/`OPENCV` for the
 * reconstruction path, and `ftheta` is the polynomial model the NuRec AV packages ship
 * (`angleToPixeldistPoly` / `pixeldistToAnglePoly` in `camera-rig.json`).
 *
 * There is deliberately no "unknown"/"assumed" variant.
 */
export const IntrinsicsSchema = z.discriminatedUnion('model', [
  z.strictObject({
    model: z.literal('pinhole'),
    fx: Finite.positive(),
    fy: Finite.positive(),
    cx: Finite,
    cy: Finite,
  }),
  z.strictObject({
    model: z.literal('opencv'),
    fx: Finite.positive(),
    fy: Finite.positive(),
    cx: Finite,
    cy: Finite,
    /** [k1, k2, p1, p2] radial/tangential, OpenCV order. */
    distortion: z.tuple([Finite, Finite, Finite, Finite]),
  }),
  z.strictObject({
    model: z.literal('ftheta'),
    cx: Finite,
    cy: Finite,
    /** Polynomial mapping pixel distance from the principal point to incident angle (radians). */
    pixeldistToAnglePoly: z.array(Finite).min(2),
    /** Inverse polynomial; the NuRec packages ship both and they are not re-derived here. */
    angleToPixeldistPoly: z.array(Finite).min(2),
    maxAngleRad: Finite.positive(),
    /** Linear c/d/e terms of the f-theta model (NuRec `linearCde`). */
    linearCde: z.tuple([Finite, Finite, Finite]).optional(),
  }),
]);
export type Intrinsics = z.infer<typeof IntrinsicsSchema>;

/**
 * Rigid transform, camera frame from rig frame. Stored as an explicit 3x4 row-major matrix
 * because that is what both the NuRec packages (`trajectoryCalibration.T_sensor_rig`) and
 * COLMAP export need; Euler triplets are lossy about convention and are not accepted.
 */
export const ExtrinsicsSchema = z.strictObject({
  /** `T_camera_rig`: 3 rows of [r00 r01 r02 tx]. Maps a point in rig coordinates into camera coordinates. */
  matrix: z.tuple([
    z.tuple([Finite, Finite, Finite, Finite]),
    z.tuple([Finite, Finite, Finite, Finite]),
    z.tuple([Finite, Finite, Finite, Finite]),
  ]),
});
export type Extrinsics = z.infer<typeof ExtrinsicsSchema>;

/**
 * Per-frame timing. A constant-rate clip may declare `fps` + `offsetUs`; anything with
 * real jitter (every recorded AV clip) declares explicit `timestampsUs`. Rolling shutter is
 * declared, never assumed to be zero: `shutterUs === 0` means global shutter and must be a
 * deliberate statement about the sensor.
 */
export const CameraTimingSchema = z.union([
  z.strictObject({
    kind: z.literal('explicit'),
    timestampsUs: z.array(TimestampUs).min(1),
    shutterUs: z.number().int().min(0),
  }),
  /**
   * Only these capture instants are published, not a complete timeline.
   *
   * The NuRec AV releases ship a single reference frame per camera rather than the recorded
   * sequence, so pretending those instants are the camera's timeline would invent a 1-frame
   * recording. They are what G1 compares renders against; the drive's clock is `ego.recordedPath`.
   */
  z.strictObject({
    kind: z.literal('reference-frames'),
    timestampsUs: z.array(TimestampUs).min(1),
    shutterUs: z.number().int().min(0),
  }),
  z.strictObject({
    kind: z.literal('constant-rate'),
    fps: Finite.positive(),
    offsetUs: TimestampUs,
    frameCount: z.number().int().positive(),
    shutterUs: z.number().int().min(0),
  }),
]);
export type CameraTiming = z.infer<typeof CameraTimingSchema>;

/**
 * One calibrated camera.
 *
 * `cameraId` is the Alpamayo camera index 0..6 (`ALPAMAYO_CAMERA_INDEX`); it is what the
 * model wire identifies a view by and what a rig preset is checked against. `sensorId` is
 * the source's own name and is kept for provenance and for addressing the renderer.
 */
export const CalibratedCameraSchema = z.strictObject({
  cameraId: z.number().int().min(0).max(6),
  sensorId: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  intrinsics: IntrinsicsSchema,
  extrinsics: ExtrinsicsSchema,
  timing: CameraTimingSchema,
});
export type CalibratedCamera = z.infer<typeof CalibratedCameraSchema>;

/* ----------------------------------------------------------------------- ego */

/**
 * One recorded ego pose in the bundle's metric world frame.
 *
 * This is the deviation reference the envelope monitor and the episode runner measure
 * against, so it is planar-and-heading only by design: the vertical channel is the
 * reconstruction's ground model, not a control input.
 */
export const EgoPoseSchema = z.strictObject({
  tUs: TimestampUs,
  x: Finite,
  y: Finite,
  headingRad: Finite,
});
export type EgoPose = z.infer<typeof EgoPoseSchema>;

export const EgoSchema = z.strictObject({
  /** Name of the metric world frame these poses live in (e.g. `nurec-source-z-up`, `map-enu`). */
  frame: z.string().min(1),
  originUs: TimestampUs,
  endUs: TimestampUs,
  /** Ascending in `tUs`, at least two poses; the recorded path the ego actually drove. */
  recordedPath: z.array(EgoPoseSchema).min(2),
  /** Per-pose longitudinal speed, same index order as `recordedPath`, m/s. */
  speedMps: z.array(NonNegative).min(2),
  /**
   * How the poses were obtained. `derived-from-speed-heading` marks an integrated (and
   * therefore drift-prone) source so a consumer can weight it honestly; it is never
   * silently upgraded to `measured`.
   */
  source: z.enum(['dataset', 'gnss-imu', 'slam', 'derived-from-speed-heading']),
  /**
   * Full rig pose per sample, when the source measured one.
   *
   * `recordedPath` is deliberately planar: it is the deviation reference for envelope
   * enforcement, where roll/pitch are the reconstruction's business rather than a control
   * input. Reconstruction, however, needs true 6-DoF camera poses — a planar pose would put
   * every camera on a flat road that does not exist and produce a warped scene. So this
   * channel is optional for a replayable bundle and **required** to reconstruct one, and its
   * absence is reported as a missing field rather than filled with zero roll and pitch.
   *
   * `position` is the rig origin in `frame`; `quaternion` is (x, y, z, w), rig-from-world's
   * inverse — i.e. it rotates rig-frame vectors into world.
   */
  recordedPose6dof: z.array(z.strictObject({
    tUs: TimestampUs,
    position: z.tuple([Finite, Finite, Finite]),
    quaternion: z.tuple([Finite, Finite, Finite, Finite]),
  })).min(2).optional(),
}).check((ctx) => {
  const { recordedPath, speedMps, originUs, endUs } = ctx.value;
  if (speedMps.length !== recordedPath.length) {
    ctx.issues.push({
      code: 'custom',
      message: `ego.speedMps has ${speedMps.length} entries but ego.recordedPath has ${recordedPath.length}`,
      path: ['speedMps'],
      input: speedMps,
    });
  }
  for (let i = 1; i < recordedPath.length; i += 1) {
    const prev = recordedPath[i - 1]!;
    const cur = recordedPath[i]!;
    if (cur.tUs <= prev.tUs) {
      ctx.issues.push({
        code: 'custom',
        message: `ego.recordedPath must be strictly ascending in tUs (index ${i}: ${prev.tUs} -> ${cur.tUs})`,
        path: ['recordedPath', i, 'tUs'],
        input: cur.tUs,
      });
      break;
    }
  }
  if (endUs <= originUs) {
    ctx.issues.push({
      code: 'custom',
      message: `ego.endUs (${endUs}) must be after ego.originUs (${originUs})`,
      path: ['endUs'],
      input: endUs,
    });
  }
});
export type Ego = z.infer<typeof EgoSchema>;

/* ------------------------------------------------------------------ dynamics */

export const TrackSampleSchema = z.strictObject({
  tUs: TimestampUs,
  x: Finite,
  y: Finite,
  headingRad: Finite,
  speedMps: NonNegative.optional(),
});

export const TrackSchema = z.strictObject({
  trackId: z.string().min(1),
  /** Source label preserved verbatim; `class` is our normalised bucket. */
  sourceClass: z.string().min(1),
  class: z.enum(['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'pedestrian', 'static-object', 'unknown']),
  dims: z.strictObject({ l: Finite.positive(), w: Finite.positive(), h: Finite.positive() }),
  samples: z.array(TrackSampleSchema).min(1),
});
export type Track = z.infer<typeof TrackSchema>;

export const DynamicsSchema = z.strictObject({
  /**
   * Actor behaviour when the ego leaves its recorded trajectory. `replay` is the only
   * mode implemented: tracks play back their recorded motion regardless of what the ego
   * does. That is exactly why an envelope exists — replayed actors stop being a valid
   * world once the ego's deviation would have changed their behaviour.
   */
  agentMode: z.literal('replay'),
  tracks: z.array(TrackSchema),
  /** Track ids intentionally excluded from the scene, with the reason recorded. */
  excluded: z.array(z.strictObject({ trackId: z.string().min(1), reason: z.string().min(1) })),
});
export type Dynamics = z.infer<typeof DynamicsSchema>;

/* ------------------------------------------------------------------ geometry */

/**
 * The renderable reconstruction. `sourcePackageSha256` pins the exact bytes the renders
 * were measured against; the splat backend re-verifies it at load (`LoadedScene`), so a
 * swapped package invalidates the bundle instead of silently rendering something else.
 */
export const GeometrySchema = z.strictObject({
  kind: z.enum(['nurec-usdz', 'authored-map']),
  /** Path relative to the bundle directory, or an absolute path for an external package. */
  sourcePackage: z.string().min(1),
  sourcePackageSha256: Sha256,
  /** `volume.nurec` member digest inside the package, when the source is a NuRec archive. */
  memberDigest: Sha256.optional(),
  /** Renderer role that can consume this geometry. */
  renderer: z.enum(['nurec-splat-renderer', 'native-bevy']),
});
export type Geometry = z.infer<typeof GeometrySchema>;

/* ----------------------------------------------------------------------- map */

export const MapContextSchema = z.strictObject({
  /**
   * `map-registry` means metric lane/route context came from an authoritative map bundle.
   * `derived-from-reconstruction` means it was extracted from the scene itself and is
   * lower confidence — recorded, never hidden, and carried into scoring provenance.
   */
  source: z.enum(['map-registry', 'derived-from-reconstruction']),
  /** OpenDRIVE / map bundle path relative to the bundle directory, when present. */
  path: z.string().min(1).optional(),
  mapId: z.string().min(1).optional(),
  /** Route the reference drive follows, as arc length along the recorded path (metres). */
  routeArcM: NonNegative.optional(),
  speedLimitMps: NonNegative.optional(),
  confidence: z.enum(['high', 'low']),
});
export type MapContext = z.infer<typeof MapContextSchema>;

/* -------------------------------------------------------------------- gates */

export const GateIdSchema = z.enum(['G1', 'G2', 'G3', 'G4', 'G5']);
export type GateId = z.infer<typeof GateIdSchema>;

/**
 * One gate verdict. `measured` and `threshold` are always both present so a reader can
 * see how close a pass was; `direction` says which way is good, so no consumer has to
 * guess whether a bigger number is better.
 */
export const GateVerdictSchema = z.strictObject({
  id: GateIdSchema,
  name: z.string().min(1),
  passed: z.boolean(),
  measured: Finite,
  threshold: Finite,
  direction: z.enum(['at-least', 'at-most']),
  unit: z.string().min(1),
  /** Why this threshold has this value. Present on every gate; see `gates.ts`. */
  rationale: z.string().min(1),
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type GateVerdict = z.infer<typeof GateVerdictSchema>;

/**
 * The bounded region within which renders off the recorded trajectory were measured to
 * hold up. Zero is a legitimate value and means "on-trajectory replay only": it is not a
 * failure to report, and an episode that never deviates can still run.
 */
export const EnvelopeSchema = z.strictObject({
  lateralM: NonNegative,
  longitudinalS: NonNegative,
  headingRad: NonNegative,
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

export const ValiditySchema = z.strictObject({
  /**
   * True only when every gate in `gates` passed. A model episode must be refused on a
   * bundle with `qualified === false`; that is a precondition check, not a score.
   */
  qualified: z.boolean(),
  envelope: EnvelopeSchema,
  /** Partial: G1/G2/G5 arrive only after rendering and a stock replay. */
  gates: z.partialRecord(GateIdSchema, GateVerdictSchema),
  /** What was actually probed, so the envelope is reproducible and its granularity visible. */
  envelopeBasis: z.strictObject({
    offsetsTestedM: z.array(NonNegative),
    headingsTestedRad: z.array(NonNegative),
    largestPassingLateralM: NonNegative,
    largestPassingHeadingRad: NonNegative,
  }),
  /** ISO-8601 instant the gates were measured. */
  measuredAt: z.string().min(1).optional(),
});
export type Validity = z.infer<typeof ValiditySchema>;

/* -------------------------------------------------------------------- source */

/**
 * Provenance of the scene.
 *
 * `synthetic-fixture` exists so schema/envelope/refusal behaviour can be exercised without
 * a licensed dataset. It is structurally prevented from being scored: `assertScoreable`
 * rejects it, and importers refuse to mark such a bundle qualified.
 */
export const SourceSchema = z.strictObject({
  kind: z.enum(['nurec', 'alpasim', 'user-bundle', 'reconstructed', 'synthetic-fixture']),
  /** Stable id of the originating scene/clip (dataset clip id, user upload id, ...). */
  sceneId: z.string().min(1),
  /** Human-readable origin, e.g. the dataset release or the user upload reference. */
  origin: z.string().min(1),
  /** SPDX id or licence name governing the source assets. Never guessed. */
  license: z.string().min(1),
  /** True when the licence forbids redistribution — such bundles must never be committed or shipped. */
  redistributable: z.boolean(),
  /** Digests of the inputs this bundle was built from. */
  inputs: z.array(z.strictObject({
    path: z.string().min(1),
    sha256: Sha256,
    bytes: z.number().int().min(0),
  })),
  /** Tooling identity, so a bundle can be traced to the code that produced it. */
  importer: z.strictObject({
    name: z.string().min(1),
    version: z.string().min(1),
    /** Set for `reconstructed` bundles: the reconstruction run that produced the geometry. */
    reconstruction: z.strictObject({
      method: z.literal('3dgut'),
      threedgrutCommit: z.string().min(1).optional(),
      datasetFormat: z.enum(['colmap', 'ncore-v4']),
      config: z.string().min(1),
      iterations: z.number().int().positive(),
    }).optional(),
  }),
});
export type Source = z.infer<typeof SourceSchema>;

/* ------------------------------------------------------- replay-context/v1 */

export const ReplayContextSchema = z.strictObject({
  schema: z.literal(REPLAY_CONTEXT_SCHEMA),
  sceneId: z.string().min(1),
  source: SourceSchema,
  /** Top-level, not nested under `calibration`: `cameras[].cameraId` is the rig-preset check. */
  cameras: z.array(CalibratedCameraSchema).min(1),
  ego: EgoSchema,
  dynamics: DynamicsSchema,
  geometry: GeometrySchema,
  map: MapContextSchema,
  validity: ValiditySchema,
}).check((ctx) => {
  const ids = new Set<number>();
  ctx.value.cameras.forEach((camera, index) => {
    if (ids.has(camera.cameraId)) {
      ctx.issues.push({
        code: 'custom',
        message: `duplicate cameras[].cameraId ${camera.cameraId}`,
        path: ['cameras', index, 'cameraId'],
        input: camera.cameraId,
      });
    }
    ids.add(camera.cameraId);
  });
  const gateIds = Object.keys(ctx.value.validity.gates);
  if (ctx.value.validity.qualified && gateIds.length !== 5) {
    ctx.issues.push({
      code: 'custom',
      message: `validity.qualified is true but only ${gateIds.length}/5 gates are recorded (${gateIds.join(', ') || 'none'})`,
      path: ['validity', 'qualified'],
      input: ctx.value.validity.qualified,
    });
  }
  for (const [id, verdict] of Object.entries(ctx.value.validity.gates)) {
    if (ctx.value.validity.qualified && !verdict.passed) {
      ctx.issues.push({
        code: 'custom',
        message: `validity.qualified is true but gate ${id} failed`,
        path: ['validity', 'gates', id, 'passed'],
        input: verdict.passed,
      });
    }
  }
  if (ctx.value.validity.qualified && ctx.value.source.kind === 'synthetic-fixture') {
    ctx.issues.push({
      code: 'custom',
      message: 'a synthetic-fixture bundle can never be qualified for model evaluation',
      path: ['validity', 'qualified'],
      input: true,
    });
  }
});
export type ReplayContext = z.infer<typeof ReplayContextSchema>;

/* ------------------------------------------------------------ eval-clip/v1 */

/**
 * A recorded video track plus the sidecars that make it interpretable.
 *
 * `frames` is the on-disk evidence: either an encoded video or an image sequence. The
 * schema does not accept a track without a camera identity, because a frame we cannot
 * attribute to a calibrated view is not a model input.
 */
export const ClipVideoSchema = z.strictObject({
  cameraId: z.number().int().min(0).max(6),
  sensorId: z.string().min(1),
  /** Path relative to the clip directory. */
  path: z.string().min(1),
  kind: z.enum(['video', 'image-sequence']),
  sha256: Sha256,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type ClipVideo = z.infer<typeof ClipVideoSchema>;

/**
 * Seed geometry for reconstruction. 3DGUT training needs an initial point cloud
 * (`sparse/0/points3D.txt` for the COLMAP path); we require a real one — lidar or SfM —
 * rather than seeding from random noise and calling the result a reconstruction of the
 * user's world.
 */
export const PointCloudSchema = z.strictObject({
  path: z.string().min(1),
  sha256: Sha256,
  format: z.enum(['ply', 'colmap-points3d-txt']),
  source: z.enum(['lidar', 'sfm']),
  /** Frame the points live in; must match `ego.frame` of the produced bundle. */
  frame: z.string().min(1),
});
export type PointCloud = z.infer<typeof PointCloudSchema>;

export const EvalClipSchema = z.strictObject({
  schema: z.literal(EVAL_CLIP_SCHEMA),
  clipId: z.string().min(1),
  source: SourceSchema,
  videos: z.array(ClipVideoSchema).min(1),
  /** Present exactly when the clip is calibrated. Its absence is what a refusal reports. */
  cameras: z.array(CalibratedCameraSchema).min(1).optional(),
  ego: EgoSchema.optional(),
  /** Recorded future used as the scoring reference; without it a run is inference, not a score. */
  reference: z.strictObject({
    kind: z.enum(['recorded-future', 'none']),
    path: z.string().min(1).optional(),
  }).optional(),
  dynamics: DynamicsSchema.optional(),
  pointCloud: PointCloudSchema.optional(),
  map: MapContextSchema.optional(),
}).check((ctx) => {
  const declared = new Set(ctx.value.cameras?.map((camera) => camera.cameraId) ?? []);
  if (ctx.value.cameras === undefined) return;
  ctx.value.videos.forEach((video, index) => {
    if (!declared.has(video.cameraId)) {
      ctx.issues.push({
        code: 'custom',
        message: `videos[${index}] declares cameraId ${video.cameraId} with no matching calibrated camera`,
        path: ['videos', index, 'cameraId'],
        input: video.cameraId,
      });
    }
  });
});
export type EvalClip = z.infer<typeof EvalClipSchema>;

/**
 * Input reference for evaluation provenance (`provenance.input`), so a result can name the
 * exact bundle it was produced from.
 */
export function replayContextInputRef(bundle: ReplayContext): {
  readonly kind: 'replay-context';
  readonly ref: string;
  readonly digest: string;
} {
  const geometryDigest = bundle.geometry.sourcePackageSha256;
  return { kind: 'replay-context', ref: bundle.sceneId, digest: geometryDigest };
}
