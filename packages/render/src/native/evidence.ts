import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  CameraCalibrationPerturbationSchema,
  CameraCalibrationViewSchema,
  CameraProfileSchema,
  GENERIC_CAMERA_PROFILE,
  canonicalize,
  type CameraCalibrationPerturbation,
  type CameraCalibrationView,
  type CameraProfile,
  type RenderIntentV1,
  type RenderSourceV3,
} from '@simforge-oss/scenario';

import { EngineCapabilityApproximationSchema } from '../capabilities.js';
import { createFixedSchedules, unionFrameMicros, type FixedSchedule } from '../schedule.js';
import { NATIVE_ACTOR_ASSETS_INPUT_ID } from './actor-assets.js';
import { NATIVE_SERVICE_PROTOCOL } from './service-client.js';

/**
 * The evidence documents a native run uploads alongside its videos. The
 * engine builds them through these schemas and every Studio host parses the
 * uploaded bytes through the same schemas before accepting a completion, so
 * producer and consumer cannot drift on a field, a literal, or the service
 * protocol the run actually spoke.
 */

export const NATIVE_RENDER_MANIFEST_V1_SCHEMA = 'simforge.native-render-manifest/v1' as const;
export const NATIVE_RENDER_MANIFEST_V2_SCHEMA = 'simforge.native-render-manifest/v2' as const;
export const NATIVE_RUN_DIAGNOSTICS_V1_SCHEMA = 'simforge.native-run-diagnostics/v1' as const;
export const CAMERA_PROFILE_EVIDENCE_PRESENT_V2 = 'camera-profile-evidence: present (v2)' as const;
export const CAMERA_PROFILE_EVIDENCE_ABSENT_PRE_V2 = 'camera-profile-evidence: absent (pre-v2)' as const;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const IdentifierSchema = z.string().trim().min(1);

export function cameraProfileConfigHash(profile: CameraProfile): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(profile))).digest('hex');
}

export function cameraProfileVersion(profile: CameraProfile): number {
  return Number(profile.profileId.slice(profile.profileId.lastIndexOf('@') + 1));
}

export function resolveEffectiveCameraProfile(
  requested: CameraProfile,
  captureProfile: 'cinematic' | 'sensor',
): { effective: CameraProfile | null; differences: string[] } {
  if (captureProfile === 'cinematic') {
    return { effective: null, differences: ['cameraProfile: not applied by cinematic review capture'] };
  }
  return {
    effective: GENERIC_CAMERA_PROFILE,
    differences: cameraProfileConfigHash(requested) === cameraProfileConfigHash(GENERIC_CAMERA_PROFILE)
      ? []
      : ['cameraProfile: generic-rgb@1 sensor profile used instead of requested profile'],
  };
}

/** Lineage every evidence document binds to the lease it was produced under. */
const NativeRunLineageSchema = z.strictObject({
  intentSha256: Sha256Schema,
  executionPackageControlSha256: Sha256Schema,
  sourceXoscSha256: Sha256Schema,
  loweringSha256: Sha256Schema,
  /** Digest of the pinned actor appearance closure the run rendered with. */
  actorAssetsSha256: Sha256Schema,
  /** Rendered ticks: the union of every RGB source's frame timestamps. */
  frameCount: z.number().int().positive(),
});

const NativeLookSchema = z.strictObject({
  profile: z.enum(['sensor', 'cinematic']),
  lighting: z.record(z.string(), z.unknown()),
  profileConfig: z.record(z.string(), z.unknown()),
  autoMeter: z.boolean(),
  provenance: z.record(z.string(), z.unknown()),
});

const NativeVideoEvidenceSchema = z.strictObject({
  actorId: IdentifierSchema,
  sensorId: IdentifierSchema,
  relativePath: IdentifierSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  framesPerSecond: z.number().finite().positive(),
  /** Frames encoded for this source: its own schedule, not the union. */
  frameCount: z.number().int().positive(),
  sha256: Sha256Schema,
  sizeBytes: z.number().int().positive(),
});

const NativeCameraProfileV1Schema = z.strictObject({
  actorId: IdentifierSchema,
  sensorId: IdentifierSchema,
  outputName: IdentifierSchema,
  requested: CameraProfileSchema,
  effective: CameraProfileSchema.nullable(),
  approximations: z.array(EngineCapabilityApproximationSchema).default([]),
  differences: z.array(z.string()),
});

const NativeCameraProfileV2Schema = NativeCameraProfileV1Schema.extend({
  profileSource: z.enum(['default', 'authored']),
  profileVersion: z.number().int().positive(),
  configHash: Sha256Schema,
  reportedCalibration: CameraCalibrationViewSchema.optional(),
}).check((ctx) => {
  if (ctx.value.profileVersion !== cameraProfileVersion(ctx.value.requested)) {
    ctx.issues.push({ code: 'custom', path: ['profileVersion'], message: 'profileVersion must match requested.profileId', input: ctx.value.profileVersion });
  }
  if (ctx.value.configHash !== cameraProfileConfigHash(ctx.value.requested)) {
    ctx.issues.push({ code: 'custom', path: ['configHash'], message: 'configHash must match the requested camera profile', input: ctx.value.configHash });
  }
});

const NativeRenderManifestBaseSchema = NativeRunLineageSchema.extend({
  look: z.strictObject({
    ...NativeLookSchema.shape,
  }),
  videos: z.array(NativeVideoEvidenceSchema).min(1),
});

export const NativeRenderManifestV1Schema = NativeRenderManifestBaseSchema.extend({
  schema: z.literal(NATIVE_RENDER_MANIFEST_V1_SCHEMA),
  fidelityMode: z.enum(['review', 'dataset']).optional(),
  cameraProfiles: z.array(NativeCameraProfileV1Schema).default([]),
  warnings: z.array(z.string()).default([]),
}).transform((manifest) => ({
  ...manifest,
  cameraProfileEvidence: CAMERA_PROFILE_EVIDENCE_ABSENT_PRE_V2,
}));

export const NativeRenderManifestV2Schema = NativeRenderManifestBaseSchema.extend({
  schema: z.literal(NATIVE_RENDER_MANIFEST_V2_SCHEMA),
  cameraProfileEvidence: z.literal(CAMERA_PROFILE_EVIDENCE_PRESENT_V2),
  fidelityMode: z.enum(['review', 'dataset']),
  cameraProfiles: z.array(NativeCameraProfileV2Schema).min(1),
  warnings: z.array(z.string()),
}).check((ctx) => {
  const expectedLook = ctx.value.fidelityMode === 'dataset' ? 'sensor' : 'cinematic';
  if (ctx.value.look.profile !== expectedLook) {
    ctx.issues.push({ code: 'custom', path: ['look', 'profile'], message: `fidelityMode ${ctx.value.fidelityMode} requires ${expectedLook} capture`, input: ctx.value.look.profile });
  }
  const keys = new Set<string>();
  for (let index = 0; index < ctx.value.cameraProfiles.length; index += 1) {
    const profile = ctx.value.cameraProfiles[index]!;
    const key = `${profile.actorId}\0${profile.sensorId}`;
    if (keys.has(key)) {
      ctx.issues.push({ code: 'custom', path: ['cameraProfiles', index], message: 'camera profile evidence must be unique per actor and sensor', input: key });
    }
    keys.add(key);
    const expected = resolveEffectiveCameraProfile(profile.requested, expectedLook);
    const effectiveMatches = profile.effective === null
      ? expected.effective === null
      : expected.effective !== null && cameraProfileConfigHash(profile.effective) === cameraProfileConfigHash(expected.effective);
    if (!effectiveMatches) {
      ctx.issues.push({ code: 'custom', path: ['cameraProfiles', index, 'effective'], message: `${ctx.value.fidelityMode} effective camera profile is inconsistent`, input: profile.effective });
    }
    if (JSON.stringify(profile.differences) !== JSON.stringify(expected.differences)) {
      ctx.issues.push({ code: 'custom', path: ['cameraProfiles', index, 'differences'], message: `${ctx.value.fidelityMode} camera profile differences are inconsistent`, input: profile.differences });
    }
  }
});

export const NativeRenderManifestSchema = z.union([NativeRenderManifestV2Schema, NativeRenderManifestV1Schema]);
export type NativeRenderManifest = z.infer<typeof NativeRenderManifestSchema>;
export type NativeRenderManifestV2 = z.infer<typeof NativeRenderManifestV2Schema>;

export const NativeRunDiagnosticsSchema = NativeRunLineageSchema.extend({
  schema: z.literal(NATIVE_RUN_DIAGNOSTICS_V1_SCHEMA),
  /** The scenario's replay clock (`FileHeader.Properties.uniscenarios.trajectoryReplay.dt`). */
  fixedTimestepSeconds: z.number().finite().positive(),
  traceSha256: Sha256Schema,
  videoCount: z.number().int().positive(),
  videos: z.array(z.strictObject({
    actorId: IdentifierSchema,
    sensorId: IdentifierSchema,
    /** Frames encoded for this source: its own schedule, not the union. */
    frameCount: z.number().int().positive(),
    sha256: Sha256Schema,
  })).min(1),
  calibrationPerturbations: z.array(z.strictObject({
    actorId: IdentifierSchema,
    sensorId: IdentifierSchema,
    perturbation: CameraCalibrationPerturbationSchema,
  })).default([]),
  service: z.strictObject({
    protocol: z.literal(NATIVE_SERVICE_PROTOCOL),
    binary: IdentifierSchema,
  }),
  /** One identity per rendered tick, in tick order, as the service answered. */
  frames: z.array(z.strictObject({
    simTick: z.number().int().nonnegative(),
    sceneRevision: z.number().int().nonnegative(),
    rigRevision: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative(),
  })),
  timings: z.strictObject({
    wallMs: z.number().finite().nonnegative(),
    serverMs: z.number().finite().nonnegative(),
  }),
}).check((ctx) => {
  const diagnostics = ctx.value;
  if (diagnostics.videoCount !== diagnostics.videos.length) {
    ctx.issues.push({ code: 'custom', path: ['videoCount'], message: 'videoCount must match videos', input: diagnostics.videoCount });
  }
  if (diagnostics.frames.length !== diagnostics.frameCount || diagnostics.frames.some((frame, tick) => frame.simTick !== tick)) {
    ctx.issues.push({ code: 'custom', path: ['frames'], message: 'frames must cover every rendered tick in order', input: diagnostics.frames.length });
  }
});

export type NativeRunDiagnostics = z.infer<typeof NativeRunDiagnosticsSchema>;

export function nativeCalibrationEvidence(sources: readonly RenderSourceV3[]) {
  return {
    consumer: sources.flatMap((source) =>
      source.modality !== 'lidar' && source.modality !== 'radar' && source.attributes.reportedCalibration
        ? [{ actorId: source.actorId, sensorId: source.sensorId, reportedCalibration: source.attributes.reportedCalibration }]
        : []),
    privileged: sources.flatMap((source) =>
      source.modality !== 'lidar' && source.modality !== 'radar' && source.attributes.calibrationPerturbation
        ? [{ actorId: source.actorId, sensorId: source.sensorId, perturbation: source.attributes.calibrationPerturbation }]
        : []),
  };
}

/** A reserved upload the host already verified against object storage. */
export interface NativeReservedArtifact {
  readonly role: string;
  readonly actorId: string | null;
  readonly sensorId: string | null;
  readonly mediaType: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface NativeRunExpectations {
  readonly intentSha256: string;
  readonly executionPackageControlSha256: string;
  readonly sourceXoscSha256: string;
  readonly actorAssetsSha256: string;
  /** Union tick count of every RGB schedule (`unionFrameMicros`). */
  readonly frameCount: number;
  /** Per RGB source, keyed by `${actorId}\0${sensorId}`. */
  readonly videos: ReadonlyMap<string, { width: number; height: number; framesPerSecond: number; frameCount: number }>;
  readonly cameraProfiles: ReadonlyMap<string, {
    outputName: string;
    profileSource: 'default' | 'authored';
    requested: CameraProfile;
    effective: CameraProfile | null;
    differences: string[];
    reportedCalibration?: CameraCalibrationView;
    calibrationPerturbation?: CameraCalibrationPerturbation;
  }>;
}

export type NativeEvidenceFailure =
  | 'native_artifact_evidence_incomplete'
  | 'native_camera_profile_evidence_absent'
  | 'native_diagnostics_evidence_mismatch';

function videoKey(video: { actorId: string | null; sensorId: string | null }): string {
  return `${video.actorId}\0${video.sensorId}`;
}

/**
 * What a native run must have produced for this lease: one video per RGB
 * source on that source's own fixed schedule, a union timeline of every
 * source's quantized frame timestamps — the same derivation the engine ran —
 * and the actor closure the intent pinned as `actors.native-closure`.
 */
/**
 * The video every lidar and radar source of a native render is encoded at.
 * Structured sensors carry no image size of their own; their visualisation
 * takes the first camera's frame and the union of the camera schedules'
 * ticks, so the sensor videos are frame-locked to the cameras.
 */
export function nativeSensorVideoFormat(intent: RenderIntentV1): { width: number; height: number; framesPerSecond: number; frameCount: number } {
  const cameras = [...intent.renderSpec.sources]
    .filter((source) => source.modality === 'rgb')
    .sort((left, right) => left.outputName.localeCompare(right.outputName));
  const lead = cameras[0];
  if (!lead || lead.modality !== 'rgb') throw new Error('native render requires at least one RGB camera');
  const schedules = createFixedSchedules(intent).filter((schedule) => cameras.some((camera) => camera.outputName === schedule.sourceId));
  return {
    width: lead.attributes.width,
    height: lead.attributes.height,
    framesPerSecond: Math.max(...schedules.map((schedule) => schedule.framesPerSecond)),
    frameCount: unionFrameMicros(schedules).length,
  };
}

export function nativeRunExpectations(
  intent: RenderIntentV1,
  lease: { readonly intentSha256: string; readonly executionPackageControlSha256: string },
): NativeRunExpectations {
  const actorAssets = intent.assets.find((asset) => asset.assetId === NATIVE_ACTOR_ASSETS_INPUT_ID);
  if (!actorAssets) throw new Error('native_actor_assets_undeclared');
  const scheduleBySource = new Map(createFixedSchedules(intent).map((schedule) => [schedule.sourceId, schedule]));
  const schedules: FixedSchedule[] = [];
  const videos = new Map<string, { width: number; height: number; framesPerSecond: number; frameCount: number }>();
  const cameraProfiles = new Map<string, {
    outputName: string;
    profileSource: 'default' | 'authored';
    requested: CameraProfile;
    effective: CameraProfile | null;
    differences: string[];
    reportedCalibration?: CameraCalibrationView;
    calibrationPerturbation?: CameraCalibrationPerturbation;
  }>();
  const sensorVideo = intent.renderSpec.sources.some((source) => source.modality === 'lidar' || source.modality === 'radar')
    ? nativeSensorVideoFormat(intent)
    : null;
  for (const source of intent.renderSpec.sources) {
    if (source.modality === 'lidar' || source.modality === 'radar') {
      videos.set(videoKey(source), sensorVideo!);
      continue;
    }
    if (source.modality !== 'rgb') continue;
    const schedule = scheduleBySource.get(source.outputName);
    if (!schedule) throw new Error(`native render source ${source.outputName} has no fixed schedule`);
    schedules.push(schedule);
    videos.set(videoKey(source), {
      width: source.attributes.width,
      height: source.attributes.height,
      framesPerSecond: schedule.framesPerSecond,
      frameCount: schedule.frameCount,
    });
    cameraProfiles.set(videoKey(source), {
      outputName: source.outputName,
      profileSource: source.attributes.profileSource,
      requested: source.attributes.cameraProfile,
      ...resolveEffectiveCameraProfile(
        source.attributes.cameraProfile,
        intent.renderSpec.capabilityIntent.fidelity === 'dataset' ? 'sensor' : 'cinematic',
      ),
      ...(source.attributes.reportedCalibration ? { reportedCalibration: source.attributes.reportedCalibration } : {}),
      ...(source.attributes.calibrationPerturbation ? { calibrationPerturbation: source.attributes.calibrationPerturbation } : {}),
    });
  }
  return {
    intentSha256: lease.intentSha256,
    executionPackageControlSha256: lease.executionPackageControlSha256,
    sourceXoscSha256: intent.scenarioRevision.openScenario.sha256,
    actorAssetsSha256: actorAssets.sha256,
    frameCount: unionFrameMicros(schedules).length,
    videos,
    cameraProfiles,
  };
}

/**
 * Whether a native completion's reserved uploads and parsed evidence agree
 * with the lease and with each other. The artifact set must be exactly one
 * manifest, one diagnostics, one trace and one mp4 per RGB source; both
 * documents must bind the lease's intent, control lineage, source xosc and
 * actor closure, agree on the lowering hash, carry the union tick count, and
 * name each reserved video's bytes with its schedule's frame count,
 * dimensions and rate; the diagnostics must name the reserved trace's bytes.
 */
export function nativeEvidenceFailure(
  reservations: readonly NativeReservedArtifact[],
  manifest: NativeRenderManifest,
  diagnostics: NativeRunDiagnostics,
  expectations: NativeRunExpectations,
): NativeEvidenceFailure | null {
  if (manifest.cameraProfileEvidence === CAMERA_PROFILE_EVIDENCE_ABSENT_PRE_V2) {
    return 'native_camera_profile_evidence_absent';
  }
  const roleCount = (role: string): number => reservations.filter((item) => item.role === role).length;
  const trace = reservations.find((item) => item.role === 'trace');
  const videos = reservations.filter((item) => item.role === 'video');
  if (
    !trace
    || roleCount('manifest') !== 1
    || roleCount('diagnostics') !== 1
    || roleCount('trace') !== 1
    || videos.length === 0
    || reservations.some((item) => !['video', 'manifest', 'trace', 'diagnostics', 'sensorArchive'].includes(item.role))
    || videos.some((item) => item.mediaType !== 'video/mp4')
  ) {
    return 'native_artifact_evidence_incomplete';
  }
  const reservedVideos = new Map(videos.map((video) => [videoKey(video), video]));
  const lineageMismatch = (document: NativeRenderManifest | NativeRunDiagnostics): boolean =>
    document.intentSha256 !== expectations.intentSha256
    || document.executionPackageControlSha256 !== expectations.executionPackageControlSha256
    || document.sourceXoscSha256 !== expectations.sourceXoscSha256
    || document.actorAssetsSha256 !== expectations.actorAssetsSha256
    || document.frameCount !== expectations.frameCount;
  const mismatch =
    lineageMismatch(manifest)
    || lineageMismatch(diagnostics)
    || manifest.loweringSha256 !== diagnostics.loweringSha256
    || diagnostics.traceSha256 !== trace.sha256
    || videos.length !== expectations.videos.size
    || manifest.videos.length !== videos.length
    || diagnostics.videos.length !== videos.length
    || manifest.cameraProfiles.length !== expectations.cameraProfiles.size
    || new Set(manifest.cameraProfiles.map(videoKey)).size !== manifest.cameraProfiles.length
    || [...expectations.cameraProfiles.keys()].some((key) => !manifest.cameraProfiles.some((profile) => videoKey(profile) === key))
    || manifest.cameraProfiles.some((profile) => {
      const expected = expectations.cameraProfiles.get(videoKey(profile));
      const effectiveMatches = profile.effective === null
        ? expected?.effective === null
        : expected?.effective !== null
          && expected?.effective !== undefined
          && cameraProfileConfigHash(profile.effective) === cameraProfileConfigHash(expected.effective);
      return !expected
        || profile.outputName !== expected.outputName
        || profile.profileSource !== expected.profileSource
        || profile.configHash !== cameraProfileConfigHash(expected.requested)
        || JSON.stringify(profile.reportedCalibration) !== JSON.stringify(expected.reportedCalibration)
        || !effectiveMatches
        || JSON.stringify(profile.differences) !== JSON.stringify(expected.differences);
    })
    || new Set(diagnostics.calibrationPerturbations.map(videoKey)).size !== diagnostics.calibrationPerturbations.length
    || diagnostics.calibrationPerturbations.length
      !== [...expectations.cameraProfiles.values()].filter((profile) => profile.calibrationPerturbation).length
    || [...expectations.cameraProfiles.entries()].some(([key, profile]) =>
      profile.calibrationPerturbation && !diagnostics.calibrationPerturbations.some((record) => videoKey(record) === key))
    || diagnostics.calibrationPerturbations.some((record) => {
      const expected = expectations.cameraProfiles.get(videoKey(record));
      return !expected || JSON.stringify(record.perturbation) !== JSON.stringify(expected.calibrationPerturbation);
    })
    || manifest.videos.some((video) => {
      const reserved = reservedVideos.get(videoKey(video));
      const expected = expectations.videos.get(videoKey(video));
      return !reserved
        || !expected
        || video.sha256 !== reserved.sha256
        || video.sizeBytes !== reserved.sizeBytes
        || video.frameCount !== expected.frameCount
        || video.width !== expected.width
        || video.height !== expected.height
        || video.framesPerSecond !== expected.framesPerSecond;
    })
    || diagnostics.videos.some((video) => {
      const reserved = reservedVideos.get(videoKey(video));
      const expected = expectations.videos.get(videoKey(video));
      return !reserved || !expected || video.sha256 !== reserved.sha256 || video.frameCount !== expected.frameCount;
    });
  return mismatch ? 'native_diagnostics_evidence_mismatch' : null;
}
