import { z } from 'zod';

import { LEGACY_XOSC_MOTION_SOURCE, RenderSourceTransformSchema, type RenderIntentV1 } from '@simforge-oss/scenario';

import { createFixedSchedules, unionFrameMicros, type FixedSchedule } from '../schedule.js';
import { NATIVE_ACTOR_ASSETS_INPUT_ID } from './actor-assets.js';
import { NATIVE_SERVICE_PROTOCOL } from './service-client.js';
import { NativeStageTimingsSchema } from './stage-timings.js';

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
  /** What the scene states were lowered from; absent on pre-timeline evidence. */
  sceneSource: z.enum(['render-timeline', 'openscenario-legacy']).optional(),
  /** `timelineSha256` of the `render.timeline` input (render-timeline source). */
  timelineSha256: Sha256Schema.optional(),
  /** Digest of the pinned actor appearance closure the run rendered with. */
  actorAssetsSha256: Sha256Schema,
  /** Rendered ticks: the union of every RGB source's frame timestamps. */
  frameCount: z.number().int().positive(),
  textureProfile: z.strictObject({
    renderTextures: z.enum(['uastc-full', 'bc7-512']),
    memberCount: z.number().int().positive(),
    textureBytes: z.number().int().nonnegative(),
    geometryBytes: z.number().int().nonnegative(),
    estimatedBytes: z.number().int().nonnegative(),
    budgetBytes: z.number().int().positive(),
    capacityBytes: z.number().int().positive(),
    /** `detected` (gated by native-evidence.vram-detected): the job's own device, measured on the worker. */
    capacitySource: z.enum(['assumed', 'explicit', 'detected']),
    cacheKey: Sha256Schema,
  }).optional(),
});

export const NativeRenderManifestSchema = NativeRunLineageSchema.extend({
  schema: z.literal(NATIVE_RENDER_MANIFEST_V1_SCHEMA),
  look: z.strictObject({
    /** rc.73 form, written only for a plane without `native-evidence.render-config`. */
    profile: z.literal('cinematic').optional(),
    lighting: z.record(z.string(), z.unknown()),
    /** rc.73 form (then the resolved render config); see `render`. */
    profileConfig: z.record(z.string(), z.unknown()).optional(),
    autoMeter: z.boolean(),
    provenance: z.record(z.string(), z.unknown()),
  }),
  /**
   * The render configuration; gated by `native-evidence.render-config`.
   * `request` is what the job asked for (preset + overrides), `config` the
   * `RenderConfig` the service resolved and rendered with, `geometryLod`
   * whether the map's LOD derivative was drawn (`manifestSha256` null: the
   * mode was `off` or the map carries none).
   */
  render: z.strictObject({
    request: z.strictObject({
      preset: z.enum(['training', 'showcase']),
      set: z.record(z.string(), z.unknown()),
    }),
    config: z.record(z.string(), z.unknown()),
    geometryLod: z.strictObject({
      mode: z.enum(['auto', 'off']),
      manifestSha256: Sha256Schema.nullable(),
      buildKey: Sha256Schema.nullable(),
    }),
  }).optional(),
  /**
   * How captured pixels relate to time; gated by `native-evidence.capture-clock`.
   * `simulation-time`: each frame is a function of its scene and simulation
   * time (one capture per frame, pinned sky clock and noise seed, explicit
   * AA samples). `update-count`: rc.73 and earlier, where the sky and the
   * TAA history advanced with every frame the renderer drew.
   */
  capture: z.strictObject({
    clock: z.enum(['simulation-time', 'update-count']),
    antiAlias: z.string().min(1).max(32),
    samplesPerFrame: z.number().int().min(1).max(16),
  }).optional(),
  /**
   * The ffmpeg that encoded every video and how each was encoded; gated by
   * `native-evidence.encoder`. `source` says how the binary was found
   * (`option`: the worker's engine option; `path`: a PATH lookup, recorded
   * as such). `codec` is what encoded the file; `startedAs` is present when
   * an NVENC session could not open and the source re-encoded on libx264.
   */
  encoder: z.strictObject({
    path: IdentifierSchema,
    source: z.enum(['option', 'env', 'runtime-manifest', 'runtime-root', 'path']),
    version: z.string().trim().min(1).max(512),
    videos: z.array(z.strictObject({
      actorId: IdentifierSchema,
      sensorId: IdentifierSchema,
      codec: z.enum(['libx264', 'h264_nvenc']),
      startedAs: z.literal('h264_nvenc').optional(),
      args: z.array(z.string().min(1).max(256)).min(1).max(64),
    })).min(1),
  }).optional(),
  videos: z.array(z.strictObject({
    actorId: IdentifierSchema,
    sensorId: IdentifierSchema,
    /** Physical sensor metadata retained independently of generated identifiers. */
    sensor: z.strictObject({
      label: z.string().trim().min(1).max(200).optional(),
      role: z.enum(['camera', 'lidar', 'radar']),
      modality: z.enum(['rgb', 'depth', 'semantic', 'instance', 'lidar', 'radar']),
      mount: RenderSourceTransformSchema,
    }).optional(),
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
  /** Observed-transform parity against the timeline sampler (render-timeline runs). */
  parity: z.strictObject({
    schema: z.literal('simforge.render-parity/v1'),
    pass: z.boolean(),
    comparedPoses: z.number().int().nonnegative(),
    maxPositionErrorM: z.number().nonnegative(),
    maxHeadingErrorDeg: z.number().nonnegative(),
    maxPitchErrorDeg: z.number().nonnegative().nullable(),
    maxRollErrorDeg: z.number().nonnegative().nullable(),
    presenceMismatches: z.number().int().nonnegative(),
  }).optional(),
  frames: z.array(z.strictObject({
    simTick: z.number().int().nonnegative(),
    sceneRevision: z.number().int().nonnegative(),
    rigRevision: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative(),
  })),
  /**
   * Per rendered tick, the exposure each RGB camera metered (the dash-cam
   * camera model): EV100, the adjustment over the incident exposure, and the
   * aperture/shutter/ISO/gain the camera's program realises it with. Gated
   * by `native-evidence.render-config`.
   */
  exposure: z.array(z.strictObject({
    tick: z.number().int().nonnegative(),
    cameras: z.record(z.string(), z.strictObject({
      ev100: z.number().finite(),
      adjustEv: z.number().finite(),
      meteredLog2Luminance: z.number().finite(),
      fNumber: z.number().finite().positive(),
      shutterS: z.number().finite().positive(),
      iso: z.number().finite().positive(),
      gainDb: z.number().finite(),
    })),
  })).optional(),
  timings: z.strictObject({
    wallMs: z.number().finite().nonnegative(),
    serverMs: z.number().finite().nonnegative(),
    /** Per-stage breakdown; gated by `native-evidence.stage-timings`. */
    stages: NativeStageTimingsSchema.optional(),
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

/**
 * A native evidence document the host could not accept, with the real parse
 * issues. Hosts surface `verificationDetails` in the completion response and
 * their logs instead of a bare `artifact_verification_failed`.
 */
export class NativeEvidenceSchemaError extends Error {
  readonly verificationDetails: {
    document: string;
    issues: Array<{ path: string; code: string; message: string }>;
  };

  constructor(document: string, issues: readonly TolerantParseIssue[]) {
    super(`native_${document}_schema_invalid`);
    this.name = 'NativeEvidenceSchemaError';
    this.verificationDetails = {
      document,
      issues: issues.slice(0, 20).map((issue) => ({
        path: issue.path.map(String).join('.') || '(root)',
        code: issue.code,
        message: issue.message,
      })),
    };
  }
}

/** One schema issue, as any Zod major reports it. */
export type TolerantParseIssue = {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly keys?: readonly string[];
};

/**
 * What the tolerant parser needs from a schema. Structural on purpose: a host
 * app may resolve `zod` to a different major than this package does, and
 * both majors' objects satisfy it.
 */
export type TolerantParseSchema<T> = {
  safeParse(input: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly TolerantParseIssue[] } };
};

export type HostParsedEvidence<T> = {
  readonly value: T;
  /** Fields a newer worker sent that this host does not know, as `path.key`. */
  readonly ignoredFields: readonly string[];
};

function withoutKeys(value: unknown, path: readonly PropertyKey[], keys: readonly string[]): unknown {
  if (path.length === 0) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const key of keys) delete copy[key];
    return copy;
  }
  const [head, ...rest] = path;
  if (Array.isArray(value)) {
    const copy = [...value];
    copy[head as number] = withoutKeys(copy[head as number], rest, keys);
    return copy;
  }
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return { ...record, [head as string]: withoutKeys(record[head as string], rest, keys) };
}

/**
 * Host-side parse: the same strict schema the engine produced the document
 * with, except that fields this host does not know yet are ignored (and
 * reported) instead of failing the completion.
 *
 * The engine keeps parsing strictly, so a producer can never emit a typo; a
 * newer worker that adds evidence (as rc.73's timeline-sourced runs added
 * `sceneSource`, `timelineSha256` and `parity`) no longer has every completion
 * refused by an older control plane. Anything other than an unknown key (a
 * missing field, a wrong type, a literal or protocol mismatch, a failed
 * cross-field check) still rejects, with the real issues attached.
 */
export function parseToleratingUnknownKeys<T>(schema: TolerantParseSchema<T>, input: unknown, document = 'evidence'): HostParsedEvidence<T> {
  let candidate = input;
  const ignoredFields: string[] = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const parsed = schema.safeParse(candidate);
    if (parsed.success) return { value: parsed.data, ignoredFields };
    const issues = parsed.error.issues;
    if (!issues.every((issue) => issue.code === 'unrecognized_keys')) {
      throw new NativeEvidenceSchemaError(document, issues.filter((issue) => issue.code !== 'unrecognized_keys'));
    }
    for (const issue of issues) {
      const keys = issue.keys ?? [];
      ignoredFields.push(...keys.map((key) => [...issue.path.map(String), key].join('.')));
      candidate = withoutKeys(candidate, issue.path, keys);
    }
  }
  const last = schema.safeParse(candidate);
  throw new NativeEvidenceSchemaError(document, last.success ? [] : last.error.issues);
}

export function parseNativeRenderManifestForHost(input: unknown): HostParsedEvidence<NativeRenderManifest> {
  return parseToleratingUnknownKeys(NativeRenderManifestSchema, input, 'manifest');
}

export function parseNativeRunDiagnosticsForHost(input: unknown): HostParsedEvidence<NativeRunDiagnostics> {
  return parseToleratingUnknownKeys(NativeRunDiagnosticsSchema, input, 'diagnostics');
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

/** The intent asset id of the render timeline (`RENDER_TIMELINE_INPUT_ID`; kept local so hosts need no WASM import). */
export const NATIVE_RENDER_TIMELINE_ASSET_ID = 'render.timeline';

export interface NativeRunExpectations {
  readonly intentSha256: string;
  readonly executionPackageControlSha256: string;
  readonly sourceXoscSha256: string;
  readonly actorAssetsSha256: string;
  readonly renderTextures?: 'uastc-full' | 'bc7-512';
  readonly nativeVramBudgetBytes?: number;
  readonly nativeVramCapacityBytes?: number;
  /** Union tick count of every RGB schedule (`unionFrameMicros`). */
  readonly frameCount: number;
  /** Per source, keyed by `${actorId}\0${sensorId}`. */
  readonly videos: ReadonlyMap<string, NativeExpectedVideo>;
  /** Digest of the intent's `render.timeline` asset: the run must render from it and pass parity. */
  readonly timelineSha256?: string;
  /** The intent explicitly requested the legacy OpenSCENARIO replay: the run must say so. */
  readonly legacyXoscReplay?: true;
  /** Lidar/radar sources that must each carry one `sensorArchive` (the intent asked for it), keyed like `videos`. */
  readonly sensorArchives: ReadonlySet<string>;
}

export interface NativeExpectedVideo {
  readonly width: number;
  readonly height: number;
  readonly framesPerSecond: number;
  readonly frameCount: number;
  readonly modality: 'rgb' | 'lidar' | 'radar';
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
  const videos = new Map<string, NativeExpectedVideo>();
  const sensorArchives = new Set<string>();
  const wantsArchive = intent.renderSpec.artifacts.includes('sensorArchive');
  const sensorVideo = intent.renderSpec.sources.some((source) => source.modality === 'lidar' || source.modality === 'radar')
    ? nativeSensorVideoFormat(intent)
    : null;
  for (const source of intent.renderSpec.sources) {
    if (source.modality === 'lidar' || source.modality === 'radar') {
      videos.set(videoKey(source), { ...sensorVideo!, modality: source.modality });
      if (wantsArchive) sensorArchives.add(videoKey(source));
      continue;
    }
    if (source.modality !== 'rgb') throw new Error(`native render cannot produce ${source.modality} source ${source.outputName}`);
    const schedule = scheduleBySource.get(source.outputName);
    if (!schedule) throw new Error(`native render source ${source.outputName} has no fixed schedule`);
    schedules.push(schedule);
    videos.set(videoKey(source), {
      width: source.attributes.width,
      height: source.attributes.height,
      framesPerSecond: schedule.framesPerSecond,
      frameCount: schedule.frameCount,
      modality: 'rgb',
    });
  }
  const timeline = intent.assets.find((asset) => asset.assetId === NATIVE_RENDER_TIMELINE_ASSET_ID);
  return {
    intentSha256: lease.intentSha256,
    executionPackageControlSha256: lease.executionPackageControlSha256,
    sourceXoscSha256: intent.scenarioRevision.openScenario.sha256,
    actorAssetsSha256: actorAssets.sha256,
    renderTextures: intent.renderTextures,
    nativeVramBudgetBytes: intent.nativeVramBudgetBytes,
    nativeVramCapacityBytes: intent.nativeVramCapacityBytes,
    frameCount: unionFrameMicros(schedules).length,
    videos,
    ...(timeline ? { timelineSha256: timeline.sha256 } : {}),
    ...(intent.motionSource === LEGACY_XOSC_MOTION_SOURCE ? { legacyXoscReplay: true as const } : {}),
    sensorArchives,
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
    || reservations.some((item) => !['video', 'manifest', 'trace', 'diagnostics', 'sensorArchive'].includes(item.role))
    || videos.some((item) => item.mediaType !== 'video/mp4')
  ) {
    return 'native_artifact_evidence_incomplete';
  }
  const archives = reservations.filter((item) => item.role === 'sensorArchive');
  if (
    archives.length !== expectations.sensorArchives.size
    || archives.some((item) => item.mediaType !== 'application/zip' || !expectations.sensorArchives.has(videoKey(item)))
    || new Set(archives.map(videoKey)).size !== archives.length
  ) {
    return 'native_artifact_evidence_incomplete';
  }
  const reservedVideos = new Map(videos.map((video) => [videoKey(video), video]));
  const lineageMismatch = (document: NativeRenderManifest | NativeRunDiagnostics): boolean =>
    document.intentSha256 !== expectations.intentSha256
    || document.executionPackageControlSha256 !== expectations.executionPackageControlSha256
    || document.sourceXoscSha256 !== expectations.sourceXoscSha256
    || document.actorAssetsSha256 !== expectations.actorAssetsSha256
    || (expectations.renderTextures !== undefined && document.textureProfile?.renderTextures !== expectations.renderTextures)
    || (expectations.nativeVramBudgetBytes !== undefined && (document.textureProfile?.budgetBytes !== expectations.nativeVramBudgetBytes || document.textureProfile.estimatedBytes > expectations.nativeVramBudgetBytes))
    || (expectations.nativeVramCapacityBytes !== undefined && (document.textureProfile?.capacityBytes !== (expectations.nativeVramBudgetBytes ?? expectations.nativeVramCapacityBytes) || document.textureProfile.estimatedBytes > document.textureProfile.capacityBytes))
    || document.frameCount !== expectations.frameCount;
  // A declared timeline is the render contract: the run must say it rendered
  // from exactly that timeline and that its observed poses passed parity.
  const timelineMismatch = expectations.timelineSha256 !== undefined && (
    manifest.sceneSource !== 'render-timeline'
    || diagnostics.sceneSource !== 'render-timeline'
    || manifest.timelineSha256 !== expectations.timelineSha256
    || diagnostics.timelineSha256 !== expectations.timelineSha256
    || diagnostics.parity?.pass !== true
    || diagnostics.parity.comparedPoses === 0
  );
  // Only an explicitly requested legacy replay may report the legacy source,
  // and it must.
  const legacyMismatch = (expectations.legacyXoscReplay === true) !== (manifest.sceneSource === 'openscenario-legacy')
    && (expectations.legacyXoscReplay === true || manifest.sceneSource !== undefined);
  const mismatch =
    timelineMismatch
    || legacyMismatch
    || lineageMismatch(manifest)
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
        || video.framesPerSecond !== expected.framesPerSecond
        || video.sensor?.modality !== expected.modality;
    })
    || diagnostics.videos.some((video) => {
      const reserved = reservedVideos.get(videoKey(video));
      const expected = expectations.videos.get(videoKey(video));
      return !reserved || !expected || video.sha256 !== reserved.sha256 || video.frameCount !== expected.frameCount;
    });
  return mismatch ? 'native_diagnostics_evidence_mismatch' : null;
}
