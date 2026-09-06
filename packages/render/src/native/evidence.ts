import { z } from 'zod';

import type { RenderIntentV1 } from '@simforge-oss/scenario';

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
export const NATIVE_RUN_DIAGNOSTICS_V1_SCHEMA = 'simforge.native-run-diagnostics/v1' as const;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const IdentifierSchema = z.string().trim().min(1);

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

export const NativeRenderManifestSchema = NativeRunLineageSchema.extend({
  schema: z.literal(NATIVE_RENDER_MANIFEST_V1_SCHEMA),
  look: z.strictObject({
    profile: z.literal('cinematic'),
    lighting: z.record(z.string(), z.unknown()),
    profileConfig: z.record(z.string(), z.unknown()),
    autoMeter: z.boolean(),
    provenance: z.record(z.string(), z.unknown()),
  }),
  videos: z.array(z.strictObject({
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
  })).min(1),
});

export type NativeRenderManifest = z.infer<typeof NativeRenderManifestSchema>;

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
}

export type NativeEvidenceFailure = 'native_artifact_evidence_incomplete' | 'native_diagnostics_evidence_mismatch';

function videoKey(video: { actorId: string | null; sensorId: string | null }): string {
  return `${video.actorId}\0${video.sensorId}`;
}

/**
 * What a native run must have produced for this lease: one video per RGB
 * source on that source's own fixed schedule, a union timeline of every
 * source's quantized frame timestamps — the same derivation the engine ran —
 * and the actor closure the intent pinned as `actors.native-closure`.
 */
export function nativeRunExpectations(
  intent: RenderIntentV1,
  lease: { readonly intentSha256: string; readonly executionPackageControlSha256: string },
): NativeRunExpectations {
  const actorAssets = intent.assets.find((asset) => asset.assetId === NATIVE_ACTOR_ASSETS_INPUT_ID);
  if (!actorAssets) throw new Error('native_actor_assets_undeclared');
  const scheduleBySource = new Map(createFixedSchedules(intent).map((schedule) => [schedule.sourceId, schedule]));
  const schedules: FixedSchedule[] = [];
  const videos = new Map<string, { width: number; height: number; framesPerSecond: number; frameCount: number }>();
  for (const source of intent.renderSpec.sources) {
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
  }
  return {
    intentSha256: lease.intentSha256,
    executionPackageControlSha256: lease.executionPackageControlSha256,
    sourceXoscSha256: intent.scenarioRevision.openScenario.sha256,
    actorAssetsSha256: actorAssets.sha256,
    frameCount: unionFrameMicros(schedules).length,
    videos,
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
  const roleCount = (role: string): number => reservations.filter((item) => item.role === role).length;
  const trace = reservations.find((item) => item.role === 'trace');
  const videos = reservations.filter((item) => item.role === 'video');
  if (
    !trace
    || roleCount('manifest') !== 1
    || roleCount('diagnostics') !== 1
    || roleCount('trace') !== 1
    || videos.length === 0
    || reservations.some((item) => !['video', 'manifest', 'trace', 'diagnostics'].includes(item.role))
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
