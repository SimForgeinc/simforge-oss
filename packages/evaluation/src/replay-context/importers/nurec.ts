/**
 * NuRec scene importer: an imported NuRec/PhysicalAI-AV scene directory plus its source
 * package become a `simforge.replay-context/v1` bundle.
 *
 * The input is the layout the NuRec import already produces and the splat backend already
 * consumes (`renderer/splat/python/simforge_splat/backend.py::LoadedScene`):
 *
 *   background.json        provider, source package path + sha256, `volume.nurec` member
 *                          digest, episode window, shutter, actor track ids
 *   camera-rig.json        calibrated f-theta sensors (`tSensorRig`, polynomials, shutter)
 *   ego-reference.json     recorded ego samples in the SimForge scene frame
 *   actor-trajectories.json recorded dynamic tracks in the same frame
 *   import-provenance.json digests of every emitted file, calibration provenance
 *   map/                   OpenDRIVE + topology for lane/route context
 *
 * Two things this importer refuses to do. It does not invent per-frame timestamps: they are
 * read from the package's own `frames/<sensor>/<timestampUs>.jpeg` members, and a camera the
 * package never recorded is dropped with a reason rather than given a synthetic timeline. It
 * does not mark the result qualified: G1/G2/G5 need renders and a replay, so a freshly
 * imported bundle is `validity.qualified === false` with a zero-width envelope until
 * `qualifyBundle` measures one.
 *
 * Frames. The sidecars are written in the SimForge scene frame (y-up, `x, z`); the renderer,
 * the package calibration and the recorded actor poses all live in the NuRec source frame
 * (z-up, `x, y`). The importer converts to the *source* frame — `y = -z_scene`, yaw carried
 * through unchanged — because that is the frame every downstream consumer of this bundle
 * (renderer, envelope monitor, gate measurement) works in. The conversion mirrors
 * `LoadedScene.rig_pose_from_ego` / `track_pose` exactly.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { cameraIndex } from '../cameras.js';
import { measureDynamicsConsistency, measureEgoHistoryParity } from '../envelope.js';
import { DEFAULT_GATE_THRESHOLDS, gateG3, gateG4, type GateThresholds } from '../gates.js';
import { sha256File } from '../digest.js';
import { RefusalError, type MissingField } from '../refusal.js';
import {
  REPLAY_CONTEXT_SCHEMA,
  ReplayContextSchema,
  type CalibratedCamera,
  type Dynamics,
  type Ego,
  type EgoPose,
  type GateId,
  type GateVerdict,
  type MapContext,
  type ReplayContext,
  type Track,
} from '../schema.js';
import { readZipIndex, recordedFrames } from '../usdz.js';
import {
  RawActorsSchema,
  RawBackgroundSchema,
  RawCameraRigSchema,
  RawEgoSchema,
  type RawRigSensor,
} from './raw-schema.js';

/** Importer identity written into `source.importer`. */
export const NUREC_IMPORTER = { name: 'simforge.replay-context.nurec-importer', version: '1' } as const;

export interface NurecImportOptions {
  /** Scene directory containing background.json and friends. */
  readonly sceneDir: string;
  /** Overrides `background.sourceUsdz` when the package lives elsewhere on this host. */
  readonly sourcePackage?: string;
  /**
   * Re-hash the source package and compare against `background.sourceUsdzSha256`.
   * On by default: the pinned digest is the only thing tying measured renders to specific
   * bytes. Packages are gigabytes, so a caller that has already verified them this session
   * may skip it — the result records which happened.
   */
  readonly verifyPackage?: boolean;
  /** Licence governing the source assets. Required: it is never guessed from the path. */
  readonly license: string;
  /** False (default) for dataset-derived scenes: they must never be committed or shipped. */
  readonly redistributable?: boolean;
  readonly thresholds?: GateThresholds;
}


/**
 * Read one sidecar and validate it. A parse failure and an absent file are the same class of
 * problem for the caller — the scene directory does not carry what an import needs — so both
 * land in `missing` with the reason attached.
 */
async function readDoc<T>(filePath: string, schema: z.ZodType<T>, missing: MissingField[]): Promise<T | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    missing.push({ path: path.basename(filePath), requirement: `readable JSON (${(error as Error).message})` });
    return undefined;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    missing.push({ path: path.basename(filePath), requirement: parsed.error.issues.map((issue) => issue.message).join('; ') });
    return undefined;
  }
  return parsed.data;
}

/**
 * Source-frame conversion for a scene-frame sample. The scene frame is y-up with the
 * horizontal plane spanned by `x` and `z`; the source frame is z-up with `y = -z_scene`.
 */
function toSourceFrame(sample: { x: number; z: number; headingRad: number }): { x: number; y: number; headingRad: number } {
  return { x: sample.x, y: -sample.z, headingRad: sample.headingRad };
}

const CLASS_BY_SOURCE: Record<string, Track['class']> = {
  car: 'car',
  automobile: 'car',
  van: 'car',
  vehicle: 'car',
  truck: 'truck',
  heavy_truck: 'truck',
  trailer: 'truck',
  bus: 'bus',
  motorcycle: 'motorcycle',
  scooter: 'motorcycle',
  bicycle: 'bicycle',
  cyclist: 'bicycle',
  pedestrian: 'pedestrian',
  person: 'pedestrian',
  static_object: 'static-object',
};

/**
 * Import a NuRec scene directory into an unqualified replay-context bundle.
 *
 * Throws `RefusalError` listing every absent or malformed input at once, so a user fixing an
 * incomplete scene sees the whole list instead of discovering it one file per attempt.
 */
export async function importNurecScene(options: NurecImportOptions): Promise<ReplayContext> {
  const { sceneDir } = options;
  const missing: MissingField[] = [];

  const background = await readDoc(path.join(sceneDir, 'background.json'), RawBackgroundSchema, missing);
  const rig = await readDoc(path.join(sceneDir, 'camera-rig.json'), RawCameraRigSchema, missing);
  const egoDoc = await readDoc(path.join(sceneDir, 'ego-reference.json'), RawEgoSchema, missing);
  const actorsDoc = await readDoc(path.join(sceneDir, 'actor-trajectories.json'), RawActorsSchema, missing);

  if (background !== undefined && background.provider !== 'nurec') {
    missing.push({
      path: 'background.json.provider',
      requirement: `must be "nurec"; this scene declares "${String(background.provider)}"`,
    });
  }
  if (missing.length > 0 || background === undefined || rig === undefined || egoDoc === undefined || actorsDoc === undefined) {
    throw new RefusalError({
      code: 'missing_fields',
      message: `${sceneDir} is not a complete NuRec scene directory`,
      missing,
      alternatives: [],
    });
  }

  /* ---------------------------------------------------------- source package */

  const packagePath = options.sourcePackage ?? String(background.sourceUsdz ?? '');
  const expectedSha = String(background.sourceUsdzSha256 ?? '');
  try {
    const info = await stat(packagePath);
    if (!info.isFile()) throw new Error('not a file');
  } catch {
    throw new RefusalError({
      code: 'missing_fields',
      message:
        `the NuRec source package for scene ${String(background.sceneId ?? '')} is not reachable at ${packagePath}. `
        + 'The package holds the geometry and the recorded frames; the sidecars alone cannot be rendered or measured.',
      missing: [{ path: 'background.json.sourceUsdz', requirement: `an existing package with sha256 ${expectedSha}` }],
      alternatives: [],
    });
  }
  const verify = options.verifyPackage ?? true;
  if (verify) {
    const digest = await sha256File(packagePath);
    if (digest !== expectedSha) {
      throw new RefusalError({
        code: 'integrity_failed',
        message: `source package identity mismatch for scene ${String(background.sceneId ?? '')}`,
        missing: [{ path: packagePath, requirement: `sha256 ${expectedSha}, found ${digest}` }],
        alternatives: [],
      });
    }
  }

  /* ------------------------------------------------------------- camera rig */

  const frames = recordedFrames(await readZipIndex(packagePath));
  const framesBySensor = new Map(frames.map((entry) => [entry.sensorId, entry]));
  const shutterUs = Number(background.cameraShutterDurationUs ?? 30_000);

  const cameras: CalibratedCamera[] = [];
  const droppedCameras: { sensorId: string; reason: string }[] = [];
  const sensors: readonly RawRigSensor[] = rig.sensors ?? [];
  for (const sensor of sensors) {
    const id = cameraIndex(sensor.id);
    if (id === undefined) {
      droppedCameras.push({ sensorId: sensor.id, reason: 'not an Alpamayo camera name; no wire index exists for it' });
      continue;
    }
    const projection = sensor.projection;
    if (projection === undefined || projection.type !== 'ftheta') {
      droppedCameras.push({ sensorId: sensor.id, reason: `unsupported projection type "${String(projection?.type)}"` });
      continue;
    }
    const recorded = framesBySensor.get(sensor.id);
    if (recorded === undefined || recorded.timestampsUs.length === 0) {
      droppedCameras.push({ sensorId: sensor.id, reason: 'the package contains no recorded frames for this sensor' });
      continue;
    }
    const t = projection.tSensorRig;
    if (t === undefined || t.length < 12) {
      droppedCameras.push({ sensorId: sensor.id, reason: 'tSensorRig is not a 3x4 (or 4x4) row-major transform' });
      continue;
    }
    const { width, height, principalPoint, pixeldistToAnglePoly, angleToPixeldistPoly, maxAngleRad } = projection;
    if (
      width === undefined || height === undefined || principalPoint === undefined || principalPoint.length < 2
      || pixeldistToAnglePoly === undefined || angleToPixeldistPoly === undefined || maxAngleRad === undefined
    ) {
      droppedCameras.push({
        sensorId: sensor.id,
        reason: 'incomplete f-theta calibration (needs width, height, principalPoint and both polynomials); it is not being guessed',
      });
      continue;
    }
    const linear = projection.linearCde;
    cameras.push({
      cameraId: id,
      sensorId: sensor.id,
      width,
      height,
      intrinsics: {
        model: 'ftheta',
        cx: principalPoint[0]!,
        cy: principalPoint[1]!,
        pixeldistToAnglePoly,
        angleToPixeldistPoly,
        maxAngleRad,
        ...(linear === undefined || linear.length < 3
          ? {}
          : { linearCde: [linear[0]!, linear[1]!, linear[2]!] as [number, number, number] }),
      },
      extrinsics: {
        matrix: [
          [t[0]!, t[1]!, t[2]!, t[3]!],
          [t[4]!, t[5]!, t[6]!, t[7]!],
          [t[8]!, t[9]!, t[10]!, t[11]!],
        ],
      },
      timing: {
        // Same as the package importer: the archive publishes reference frames, not a timeline.
        kind: 'reference-frames',
        timestampsUs: [...recorded.timestampsUs],
        shutterUs: Number(projection.shutter?.durationUs ?? shutterUs),
      },
    });
  }
  if (cameras.length === 0) {
    throw new RefusalError({
      code: 'missing_fields',
      message: `scene ${String(background.sceneId ?? '')} has no usable calibrated cameras`,
      missing: droppedCameras.map((entry) => ({ path: `camera-rig.json#${entry.sensorId}`, requirement: entry.reason })),
      alternatives: [],
    });
  }
  cameras.sort((a, b) => a.cameraId - b.cameraId);

  /* -------------------------------------------------------------------- ego */

  const samples = egoDoc.samples ?? [];
  if (samples.length < 2) {
    throw new RefusalError({
      code: 'missing_fields',
      message: `scene ${String(background.sceneId ?? '')} has no usable recorded ego path`,
      missing: [{ path: 'ego-reference.json.samples', requirement: 'at least two timestamped ego poses' }],
      alternatives: [],
    });
  }
  const ordered = [...samples].sort((a, b) => a.sourceTimestampUs - b.sourceTimestampUs);
  const recordedPath: EgoPose[] = [];
  const declaredSpeed: (number | undefined)[] = [];
  for (const sample of ordered) {
    const previous = recordedPath[recordedPath.length - 1];
    if (previous !== undefined && sample.sourceTimestampUs <= previous.tUs) continue;
    recordedPath.push({ tUs: sample.sourceTimestampUs, ...toSourceFrame(sample) });
    declaredSpeed.push(sample.speedMps === undefined ? undefined : Math.max(0, sample.speedMps));
  }
  // A sample without a declared speed is differentiated from its neighbours rather than
  // defaulted to zero, which would put a stationary step into the model's ego history.
  const speedMps = declaredSpeed.map((declared, index) => {
    if (declared !== undefined) return declared;
    const a = recordedPath[Math.max(0, index - 1)]!;
    const b = recordedPath[Math.min(recordedPath.length - 1, index + 1)]!;
    const dt = (b.tUs - a.tUs) / 1e6;
    return dt <= 0 ? 0 : Math.hypot(b.x - a.x, b.y - a.y) / dt;
  });
  const ego: Ego = {
    frame: 'nurec-source-z-up',
    originUs: recordedPath[0]!.tUs,
    endUs: recordedPath[recordedPath.length - 1]!.tUs,
    recordedPath,
    speedMps,
    source: 'dataset',
  };

  /* --------------------------------------------------------------- dynamics */

  const tracks: Track[] = [];
  const excluded: { trackId: string; reason: string }[] = [];
  for (const [trackId, raw] of Object.entries(actorsDoc.actors ?? {})) {
    const rawSamples = raw.samples ?? [];
    if (rawSamples.length === 0) {
      excluded.push({ trackId, reason: 'track has no samples' });
      continue;
    }
    const dims = raw.dims;
    if (dims === undefined || !(dims.l > 0 && dims.w > 0 && dims.h > 0)) {
      excluded.push({ trackId, reason: 'track has no positive bounding-box dimensions' });
      continue;
    }
    const sourceClass = String(raw.sourceClass ?? raw.kind ?? 'unknown');
    tracks.push({
      trackId,
      sourceClass,
      class: CLASS_BY_SOURCE[sourceClass] ?? 'unknown',
      dims: { l: dims.l, w: dims.w, h: dims.h },
      samples: [...rawSamples]
        .sort((a, b) => a.sourceTimestampUs - b.sourceTimestampUs)
        .map((sample) => ({
          tUs: sample.sourceTimestampUs,
          ...toSourceFrame(sample),
          ...(sample.speedMps === undefined ? {} : { speedMps: Math.max(0, sample.speedMps) }),
        })),
    });
  }
  const dynamics: Dynamics = { agentMode: 'replay', tracks, excluded };

  /* -------------------------------------------------------------------- map */

  let map: MapContext = { source: 'derived-from-reconstruction', confidence: 'low' };
  try {
    const xodr = path.join(sceneDir, 'map', 'map.xodr');
    await stat(xodr);
    map = { source: 'derived-from-reconstruction', path: 'map/map.xodr', confidence: 'low' };
  } catch {
    // No lane context: scoring that needs a route will say so; nothing is invented here.
  }

  /* ------------------------------------------------------- assemble + gates */

  const inputs: ReplayContext['source']['inputs'] = [];
  for (const name of ['background.json', 'camera-rig.json', 'ego-reference.json', 'actor-trajectories.json']) {
    const filePath = path.join(sceneDir, name);
    const info = await stat(filePath);
    inputs.push({ path: name, sha256: await sha256File(filePath), bytes: info.size });
  }

  const sceneId = String(background.sceneId ?? '');
  const draft: ReplayContext = {
    schema: REPLAY_CONTEXT_SCHEMA,
    sceneId,
    source: {
      kind: 'nurec',
      sceneId,
      origin: String(background.metadata?.nreSceneId ?? packagePath),
      license: options.license,
      redistributable: options.redistributable ?? false,
      inputs,
      importer: { ...NUREC_IMPORTER },
    },
    cameras,
    ego,
    dynamics,
    geometry: {
      kind: 'nurec-usdz',
      sourcePackage: packagePath,
      sourcePackageSha256: expectedSha,
      ...(background.digest === undefined ? {} : { memberDigest: background.digest }),
      renderer: 'nurec-splat-renderer',
    },
    map,
    validity: {
      qualified: false,
      envelope: { lateralM: 0, longitudinalS: 0, headingRad: 0 },
      gates: {},
      envelopeBasis: { offsetsTestedM: [], headingsTestedRad: [], largestPassingLateralM: 0, largestPassingHeadingRad: 0 },
    },
  };

  // G3/G4 need no renderer, so they are measured at import time; G1/G2/G5 stay absent until
  // `qualifyBundle` renders and `stockReplayGate` replays.
  const thresholds = options.thresholds ?? DEFAULT_GATE_THRESHOLDS;
  const gates: Partial<Record<GateId, GateVerdict>> = {
    G3: gateG3(measureEgoHistoryParity(draft), thresholds),
    G4: gateG4(measureDynamicsConsistency(draft), thresholds),
  };

  return ReplayContextSchema.parse({ ...draft, validity: { ...draft.validity, gates } });
}
