import type {
  RenderArtifactManifest,
  RenderInputFile,
  RenderProgressRecord,
} from "@simforge-oss/render";
import type { RenderIntentV1 } from "@simforge-oss/scenario";

export type LocalRenderEngine = "browser" | "native";

export type RemoteInput = {
  readonly inputId: string;
  /** Workspace-relative materialization path; preserves map-manifest relative URL closure. */
  readonly relativePath?: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly download: {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
  };
};

export type BrowserRenderClaimPayload = {
  readonly mode: "browser_render";
  readonly engine: "browser";
  readonly intent: Record<string, unknown>;
  readonly intentSha256: string;
  readonly inputs: readonly RemoteInput[];
  /** CreateBrowserRecordingSchema payload resolved from the immutable revision before execution. */
  readonly recording: Record<string, unknown>;
};

export type NativeMapMember = {
  readonly inputId: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
};

/**
 * A local native (Bevy) render claim. Small immutable inputs are fetched
 * per attempt; the map's native closure is served from the host's ensured
 * local map directory, declared here member by member so the worker can
 * refuse a directory whose bytes are not the intent's.
 */
export type NativeRenderClaimPayload = {
  readonly mode: "native_render";
  readonly engine: "native";
  readonly intent: Record<string, unknown>;
  readonly intentSha256: string;
  readonly executionPackageControlSha256: string;
  readonly attemptNumber: number;
  readonly mapVersionId: string;
  readonly inputs: readonly RemoteInput[];
  readonly map: { readonly members: readonly NativeMapMember[] };
};

export type CpuJobClaim = {
  readonly contract: "uniscenario.cpu-job-claim/v1";
  readonly jobFamily: "openscenario_render";
  readonly jobId: string;
  readonly attemptId: string;
  readonly fenceToken: string;
  readonly leaseExpiresAt: string;
  readonly payload: BrowserRenderClaimPayload | NativeRenderClaimPayload;
};

export type CpuFence = Pick<CpuJobClaim, "jobFamily" | "attemptId" | "fenceToken">;

export type NativeMapPreparation =
  | { readonly state: "preparing"; readonly startedAt: string }
  | { readonly state: "ready"; readonly directory: string; readonly mapVersionId: string; readonly startedAt: string; readonly readyAt: string }
  | { readonly state: "failed"; readonly code: string; readonly message: string; readonly startedAt: string };

export type NativeArtifactIdentity =
  | { readonly role: "video" | "frames" | "sensorArchive"; readonly actorId: string; readonly sensorId: string; readonly modality: string }
  | { readonly role: "manifest" | "trace" | "annotations" | "diagnostics"; readonly actorId: null; readonly sensorId: null; readonly modality: null };

export type NativeArtifactReservation = {
  readonly artifactId: string;
  readonly upload: { readonly url: string; readonly method: "PUT"; readonly headers: Readonly<Record<string, string>> };
};

export type NativeCompletionArtifact = {
  readonly artifactId: string;
  readonly identity: NativeArtifactIdentity;
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
};

export type RecordingSensorIdentity = {
  readonly actorId: string;
  readonly sensorId: string;
  readonly modality: "rgb" | "depth" | "semantic" | "instance" | "lidar" | "radar";
};

export type RecordingArtifact =
  | {
    readonly kind: "manifest" | "video";
    readonly sensor?: never;
    readonly path: string;
    readonly mediaType: "application/json" | "video/mp4";
    readonly sha256: string;
    readonly sizeBytes: number;
  }
  | {
    readonly kind: "frames";
    readonly sensor?: never;
    readonly path: string;
    readonly mediaType: "application/x-ndjson";
    readonly sha256: string;
    readonly sizeBytes: number;
  }
  | {
    readonly kind: "sensor_video";
    readonly sensor: RecordingSensorIdentity;
    readonly path: string;
    readonly mediaType: "video/webm";
    readonly sha256: string;
    readonly sizeBytes: number;
  }
  | {
    readonly kind: "sensor_archive";
    readonly sensor: RecordingSensorIdentity;
    readonly path: string;
    readonly mediaType: "application/zip";
    readonly sha256: string;
    readonly sizeBytes: number;
  };

export type RenderExecutionRequest = {
  readonly jobId: string;
  readonly attempt: number;
  readonly engine: LocalRenderEngine;
  readonly intent: Record<string, unknown>;
  readonly intentSha256?: string;
  /** Control lineage the native engine binds into its trace, manifest and diagnostics. */
  readonly executionPackageControlSha256?: string;
  readonly inputs: ReadonlyMap<string, RenderInputFile>;
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly reportProgress?: (record: RenderProgressRecord) => Promise<void>;
};

/** The engine run every lane shares: digest-checked inputs, a verified manifest, stage timings. */
export type EngineExecution = {
  readonly intentSha256: string;
  readonly intent: RenderIntentV1;
  readonly runtimeManifest: RenderArtifactManifest;
  readonly frameCount: number;
  readonly stageTimingsMs: Record<string, number>;
};

export type RenderExecutionResult = {
  readonly intentSha256: string;
  readonly frameCount: number;
  readonly durationSeconds: number;
  readonly runtimeManifest: RenderArtifactManifest;
  readonly artifacts: readonly RecordingArtifact[];
  /** Wall-clock stage costs for local profiling and progress diagnostics. */
  readonly stageTimingsMs: Readonly<Record<string, number>>;
};
