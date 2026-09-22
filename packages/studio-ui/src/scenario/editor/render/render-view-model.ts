/**
 * Pure presentation logic for the render, details and artifact tabs.
 *
 * Everything here is a function over plain data, for the same reason
 * `status/notification-model.ts` is: the rules that decide what a state *looks* like — which tone,
 * which verb, whether a progress bar is honest, what a failure code means in English — are the part
 * worth testing, and testing them through a DOM would be testing React instead.
 */

import * as stylex from "@stylexjs/stylex";
import { styles } from "./RenderStatePieces.stylex";
import type {
  ScenarioGalleryItemDto,
  ScenarioPresignedArtifactDto,
  ScenarioRenderArtifactDto,
  ScenarioRendererEngine,
  ScenarioRenderJobMode,
  ScenarioRenderJobDetailDto,
  ScenarioRenderJobState,
} from "@simforge-oss/studio-host";

export type RenderStateTone = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type RenderStateVisual = {
  label: string;
  tone: RenderStateTone;
  /** Whether the state is still advancing. Drives polling and the pulse. */
  live: boolean;
};

const STATE_VISUALS: Record<ScenarioRenderJobState, RenderStateVisual> = {
  queued: { label: "Queued", tone: "queued", live: true },
  // `leased` is a control-plane detail: a worker has claimed the job but has not reported a first
  // event. To an author that is indistinguishable from starting, so it does not get its own word.
  leased: { label: "Starting", tone: "running", live: true },
  running: { label: "Running", tone: "running", live: true },
  succeeded: { label: "Done", tone: "succeeded", live: false },
  failed: { label: "Failed", tone: "failed", live: false },
  cancelled: { label: "Cancelled", tone: "cancelled", live: false },
};

export function renderStateVisual(state: ScenarioRenderJobState): RenderStateVisual {
  return STATE_VISUALS[state] ?? { label: state, tone: "queued", live: false };
}

/** Tokenized chip styling per tone. No hex, no white-alpha — parity plan §5.1. */
export function renderStateChipStyle(tone: RenderStateTone): stylex.StyleXStyles {
  switch (tone) {
    case "running":
      return styles.chipRunning;
    case "succeeded":
      return styles.chipSucceeded;
    case "failed":
      return styles.chipFailed;
    case "cancelled":
      return styles.chipCancelled;
    default:
      return styles.chipQueued;
  }
}

/** What a job is, as far as naming and filtering go: its mode and the engine that ran it. */
export type RenderJobIdentity = Pick<ScenarioGalleryItemDto, "jobMode" | "rendererEngine">;

const JOB_MODE_LABELS: Record<Exclude<ScenarioRenderJobMode, "full_render" | "browser_render">, string> = {
  interaction_2d: "2D interaction",
  cosmos_augment: "Cosmos augment",
  vlm_annotate: "VLM annotate",
};

const ENGINE_LABELS: Record<ScenarioRendererEngine, string> = {
  native: "Native render",
  carla: "CARLA render",
  browser: "Browser render",
};

/**
 * The engine a managed render ran on, which is what the gallery filters and labels by.
 *
 * `rendererEngine` is the DTO's own answer and wins whenever the row has one. `full_render` says
 * nothing about the engine — native and CARLA both submit it — so a row without an engine is the
 * native default rather than CARLA; only `browser_render` names its engine by mode.
 */
export function renderJobEngine(job: RenderJobIdentity): ScenarioRendererEngine {
  return job.rendererEngine ?? (job.jobMode === "browser_render" ? "browser" : "native");
}

export function renderJobLabel(job: RenderJobIdentity): string {
  if (job.jobMode === "full_render" || job.jobMode === "browser_render") {
    return ENGINE_LABELS[renderJobEngine(job)];
  }
  return JOB_MODE_LABELS[job.jobMode] ?? job.jobMode;
}

export function isPostprocessMode(
  mode: ScenarioRenderJobMode,
): mode is "cosmos_augment" | "vlm_annotate" {
  return mode === "cosmos_augment" || mode === "vlm_annotate";
}

/**
 * The attempt a job is currently on, when that attempt is a retry and still moving; else null.
 *
 * The control plane requeues a retryable failure and claims the next attempt without clearing
 * `failureCode`, so a queued or running retry still carries its previous attempt's code. Surfaces
 * show this instead: the fact worth announcing is that attempt N is live, not that attempt N-1 died.
 */
export function activeRetry(job: {
  jobState: ScenarioRenderJobState;
  attemptCount: number;
}): { attempt: number; phase: string } | null {
  if (!renderStateVisual(job.jobState).live || job.attemptCount <= 1) return null;
  return {
    attempt: job.attemptCount,
    phase: job.jobState === "leased" ? "starting" : job.jobState,
  };
}

/**
 * The width of the progress bar, and whether to announce a number at all.
 *
 * `progressPercent` is null wherever the worker has not reported one, which is most of a queued job's
 * life. A bar at 0 reads as "stuck at zero" and a bar with no `aria-valuenow` reads as broken, so an
 * unreported progress is an indeterminate bar with no value — not a zero.
 *
 * A reported 0 keeps a 4% sliver so a just-started job shows something, while the *announced* value
 * stays honest. Same trick, and same reason, as `states/ScenarioJobDetails.tsx`.
 */
export function renderProgressBar(item: {
  jobState: ScenarioRenderJobState;
  progressPercent: number | null;
}): { indeterminate: boolean; percent: number | null; widthPercent: number } {
  const visual = renderStateVisual(item.jobState);
  if (item.jobState === "succeeded") return { indeterminate: false, percent: 100, widthPercent: 100 };
  if (!visual.live) return { indeterminate: false, percent: null, widthPercent: 0 };
  if (item.progressPercent == null) return { indeterminate: true, percent: null, widthPercent: 0 };
  const percent = Math.max(0, Math.min(100, Math.round(item.progressPercent)));
  return { indeterminate: false, percent, widthPercent: Math.max(4, percent) };
}

/** True when at least one job is still advancing, so the surface should keep polling. */
export function hasLiveJob(items: readonly { jobState: ScenarioRenderJobState }[]): boolean {
  return items.some((item) => renderStateVisual(item.jobState).live);
}

/**
 * Plain English for the control plane's failure codes, for a job that has actually failed.
 *
 * `failure_detail` is a JSON blob written by a worker and is shown separately, verbatim, in the
 * details tab. This is the one-line version an author reads first, and it exists because
 * `lease_expired` and `parity_threshold_failed` mean nothing to someone who did not write the
 * scheduler. An unmapped code falls back to a humanized form rather than being hidden — a code we
 * have no copy for is still the most useful thing on screen.
 *
 * Null for every state but `failed`. A `failureCode` alone is not evidence of a failed job — see
 * `activeRetry` — and a cancelled or succeeded job with a leftover code has nothing to explain.
 */
const FAILURE_MESSAGES: Record<string, string> = {
  lease_expired: "The render worker stopped reporting and its lease expired.",
  parity_threshold_failed: "The render finished but missed its 2D parity thresholds.",
  cancelled_by_request: "This render was cancelled.",
  worker_error: "The render worker reported an error.",
  compile_failed: "The scenario could not be compiled for this render.",
  upload_failed: "The render finished but its output could not be uploaded.",
};

export function jobFailureMessage(job: {
  jobState: ScenarioRenderJobState;
  failureCode: string | null;
  failureDetail?: unknown;
}): string | null {
  if (job.jobState !== "failed" || !job.failureCode) return null;
  if (job.failureCode === "native_texture_capacity_exceeded" || job.failureCode === "native_map_asset_set_too_large") {
    let detail = job.failureDetail;
    if (typeof detail === "string") {
      try { detail = JSON.parse(detail); } catch { return detail as string; }
    }
    if (detail && typeof detail === "object" && "message" in detail && typeof detail.message === "string") return detail.message;
  }
  return FAILURE_MESSAGES[job.failureCode] ?? humanizeCode(job.failureCode);
}

export function humanizeCode(code: string): string {
  const words = code.replace(/[_-]+/g, " ").trim();
  if (!words) return code;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What an artifact can do right now.
 *
 * `pending` has no complete object behind it and `quarantined` failed checksum verification, so
 * neither may be offered as a link — the route already returns `url: null` for both. `available` with
 * a null url means the object was cleaned up between the metadata read and the signing call; that is
 * a downgrade, not an error, and it gets its own message so it is not mistaken for "still uploading".
 */
export type ArtifactAvailability =
  | { kind: "ready"; url: string }
  /** Available, but this payload was not signed. The caller signs on demand via `downloads`. */
  | { kind: "resolvable"; message: string }
  | { kind: "pending"; message: string }
  | { kind: "quarantined"; message: string }
  | { kind: "deleted"; message: string }
  | { kind: "unavailable"; message: string };

/**
 * `signed` says whether this payload came from a route that mints URLs.
 *
 * It has to be told, because `url: null` is ambiguous on its own: from `downloads` it means the object
 * vanished between the metadata read and the signing call, while from `artifact-index` or `detail` it
 * means nothing at all — those routes never sign. Guessing from url presence would report every
 * browsable artifact in the workspace as missing from storage.
 *
 * The `switch` leads on `artifactState` for the same reason the route contract requires it: a state
 * added later must fall through to "not ready", not to an error or a broken link.
 */
export function artifactAvailability(
  artifact: Pick<ScenarioRenderArtifactDto, "artifactState"> & { url?: string | null },
  options: { signed?: boolean } = {},
): ArtifactAvailability {
  const signed = options.signed ?? true;
  switch (artifact.artifactState) {
    case "available":
      if (artifact.url) return { kind: "ready", url: artifact.url };
      return signed
        ? { kind: "unavailable", message: "This file is no longer in storage." }
        : { kind: "resolvable", message: "Ready" };
    case "pending":
      return { kind: "pending", message: "Still uploading." };
    case "quarantined":
      return { kind: "quarantined", message: "Failed checksum verification." };
    case "deleted":
      return { kind: "deleted", message: "Deleted." };
    default:
      return { kind: "unavailable", message: humanizeCode(artifact.artifactState) };
  }
}

/** True where the artifact is a video we can put in a `<video>` element. */
export function isPlayableVideo(
  artifact: Pick<ScenarioRenderArtifactDto, "mediaType" | "artifactState"> & {
    url?: string | null;
  },
): boolean {
  return (
    artifact.mediaType.startsWith("video/")
    && artifactAvailability(artifact).kind === "ready"
  );
}

export function isImage(artifact: Pick<ScenarioRenderArtifactDto, "mediaType">): boolean {
  return artifact.mediaType.startsWith("image/");
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  // `noUncheckedIndexedAccess` makes this possibly-undefined; the loop bound guarantees it is not.
  const unit = units[unitIndex] ?? "TB";
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${unit}`;
}

/** Short digest for a provenance row. Full value stays in the `title`, never truncated in the DOM. */
export function shortDigest(value: string | null): string {
  if (!value) return "—";
  return value.length <= 16 ? value : `${value.slice(0, 12)}…${value.slice(-4)}`;
}

export function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatElapsed(fromIso: string | null, toIso: string | null): string {
  if (!fromIso) return "—";
  const from = new Date(fromIso).getTime();
  const to = toIso ? new Date(toIso).getTime() : Date.now();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return "—";
  const seconds = Math.round((to - from) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Worker stages, including preparation/encoding rather than calling all work "rendering". */
export const RENDER_PIPELINE_STAGES = [
  { kind: "queued", label: "Queued", hint: "Waiting for a worker" },
  { kind: "leased", label: "Leased", hint: "Worker assigned" },
  { kind: "downloading", label: "Downloading inputs", hint: "Fetching and verifying input files" },
  { kind: "preparing", label: "Preparing", hint: "Loading the scene" },
  { kind: "rendering", label: "Rendering", hint: "Producing simulation ticks" },
  { kind: "encoding", label: "Encoding", hint: "Finishing videos and sensor archives" },
  { kind: "uploading", label: "Uploading artifacts", hint: "Sending outputs to storage" },
  { kind: "finalizing", label: "Finalizing", hint: "Verifying stored outputs" },
  { kind: "completed", label: "Done", hint: "Every artifact is verified" },
] as const;

export type RenderStageState = "done" | "active" | "pending" | "stopped";

/** Header, stages and counters share the current attempt's durable worker records. */
export function renderPipelineStages(detail: ScenarioRenderJobDetailDto) {
  const live = renderStateVisual(detail.jobState).live;
  const attempt = detail.attempts.find((item) => item.attemptNumber === detail.attemptCount);
  const records = [...(detail.progressRecords ?? []), ...(detail.progressDetail ? [detail.progressDetail] : [])]
    .filter((record) => record.attempt === detail.attemptCount
      && (record.event === "stage.started" || record.event === "stage.progress"));
  const newest = records.reduce<(typeof records)[number] | null>(
    (last, record) => !last || record.sequence > last.sequence ? record : last, null,
  );
  const currentKind = detail.jobState === "succeeded" ? "completed"
    : detail.jobState === "queued" ? "queued"
    : newest && "stage" in newest ? newest.stage : attempt ? "leased" : "queued";
  const currentIndex = RENDER_PIPELINE_STAGES.findIndex((stage) => stage.kind === currentKind);
  const stages = RENDER_PIPELINE_STAGES.map((stage, index) => {
    const record = records.filter((item) => "stage" in item && item.stage === stage.kind)
      .reduce<(typeof records)[number] | null>((last, item) => !last || item.sequence > last.sequence ? item : last, null);
    let hint: string = stage.kind === "leased" && attempt ? attempt.workerNodeId : stage.hint;
    if (record?.event === "stage.progress") {
      const unit = stage.kind === "downloading" ? "files" : stage.kind === "uploading" ? "artifacts"
        : stage.kind === "rendering" ? "ticks" : record.unit;
      hint = `${record.completed}/${record.total} ${unit}`;
      if (stage.kind === "rendering") hint += ` · ${Math.round(100 * record.completed / record.total)}%`;
      if (record.downloadedBytes !== undefined && record.totalBytes !== undefined) {
        hint += ` · ${formatBytes(record.downloadedBytes)} / ${formatBytes(record.totalBytes)}`;
      }
    }
    const at = stage.kind === "queued" ? detail.createdAt
      : stage.kind === "leased" ? attempt?.leasedAt ?? null
      : stage.kind === "completed" ? detail.completedAt : record?.timestamp ?? null;
    const state: RenderStageState = detail.jobState === "succeeded" ? at !== null ? "done" : "stopped"
      : index === currentIndex && live ? "active"
      : index < currentIndex && (at !== null || stage.kind === "queued") ? "done"
      : !live || index < currentIndex ? "stopped" : "pending";
    return { ...stage, hint, at, state };
  });
  const current = stages[currentIndex]!;
  const progress = newest?.event === "stage.progress" ? newest : null;
  return {
    stages,
    label: live ? current.label : renderStateVisual(detail.jobState).label,
    percent: detail.jobState === "succeeded" ? 100
      : live && detail.jobState !== "queued" && progress ? 100 * progress.completed / progress.total : null,
    updatedAt: newest?.timestamp ?? attempt?.leasedAt ?? detail.createdAt,
  };
}

export function formatCostCents(cents: number): string {
  if (!Number.isFinite(cents)) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

/** A sensor's authored name belongs to the immutable revision, not its generated ID. */
export function artifactSensorName(artifact: ScenarioRenderArtifactDto): string | null {
  if (!artifact.identity?.sensorId) return null;
  const label = artifact.sensorLabel?.trim();
  const modality = artifact.identity.modality;
  const role = modality === "lidar" ? "Lidar" : modality === "radar" ? "Radar" : "Camera";
  if (label && label !== artifact.identity.sensorId && label !== artifact.identity.actorId) {
    return label.toLowerCase().includes(role.toLowerCase()) ? label : `${label} ${role.toLowerCase()}`;
  }
  return role;
}

export function artifactDisplayName(artifact: ScenarioRenderArtifactDto): string {
  const sensor = artifactSensorName(artifact);
  const role = artifact.identity?.role ?? artifact.artifactKind;
  const modality = artifact.identity?.modality;
  const kind = role === "sensorArchive" ? "point archive"
    : role === "video" && modality === "rgb" ? "RGB video"
    : role === "video" && modality && !["lidar", "radar"].includes(modality) ? `${humanizeCode(modality)} video`
    : humanizeCode(role);
  return sensor ? `${sensor} · ${kind}` : kind;
}

/** Keep each physical sensor's video and point archive together. IDs are keys only. */
export function groupArtifacts<T extends ScenarioRenderArtifactDto & { url?: string | null }>(
  artifacts: readonly T[],
): { key: string; title: string; items: T[] }[] {
  const groups = new Map<string, { key: string; title: string; items: T[] }>();
  for (const artifact of artifacts) {
    const sensor = artifactSensorName(artifact);
    const key = sensor ? `${artifact.identity!.actorId}\u0000${artifact.identity!.sensorId}` : "evidence";
    let group = groups.get(key);
    if (!group) {
      group = { key, title: sensor ?? "Render evidence", items: [] };
      groups.set(key, group);
    }
    group.items.push(artifact);
  }
  return [...groups.values()].sort((a, b) =>
    Number(a.key === "evidence") - Number(b.key === "evidence") || a.title.localeCompare(b.title),
  ).map((group) => ({
    ...group,
    items: group.items.sort((a, b) =>
      Number(b.mediaType.startsWith("video/")) - Number(a.mediaType.startsWith("video/"))
      || artifactDisplayName(a).localeCompare(artifactDisplayName(b))),
  }));
}

/**
 * The accessible name for a gallery tile.
 *
 * A tile is a picture, a chip and two numbers; without this it announces as an unlabelled button.
 * A terminal failure reason is in the name because that decides whether the author opens it. A live
 * retry instead names the active attempt; carrying the prior failure forward would describe the
 * current attempt as failed while it is running.
 */
export function galleryItemAccessibleName(item: ScenarioGalleryItemDto): string {
  const retry = activeRetry(item);
  const parts = [
    renderJobLabel(item),
    formatTimestamp(item.createdAt),
    retry ? `Retrying, attempt ${retry.attempt} ${retry.phase}` : renderStateVisual(item.jobState).label,
    item.artifactCount === 1 ? "1 artifact" : `${item.artifactCount} artifacts`,
  ];
  const failure = jobFailureMessage(item);
  if (failure) parts.push(failure);
  return parts.join(", ");
}

/**
 * A stable idempotency key for a postprocess submission.
 *
 * Keyed on what the run *is* — parent, source artifact, mode, model, config — rather than on a
 * random value or a clock, so a double-click, a retried fetch and a reloaded tab all resolve to the
 * same job instead of queueing three. `createPostprocessJob` returns `created: false` for the
 * repeats.
 */
export function postprocessIdempotencyKey(input: {
  parentRenderJobId: string;
  sourceArtifactId: string;
  jobMode: string;
  modelFamily: string;
  modelConfig: Record<string, unknown>;
}): string {
  const config = JSON.stringify(input.modelConfig, Object.keys(input.modelConfig).sort());
  return [
    "pp",
    input.jobMode,
    input.parentRenderJobId,
    input.sourceArtifactId,
    input.modelFamily.trim(),
    fnv1a32(config),
  ].join(":");
}

/**
 * A short, stable hash for the idempotency key's config component.
 *
 * FNV-1a rather than SHA-256 because `crypto.subtle.digest` is async and this is called inside a
 * render path. The server hashes the config properly into `model_config_sha256`; this only has to
 * distinguish two configs the same user submits, where a 32-bit space is ample.
 */
function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Artifacts a postprocess run can be fed: an available video output of the parent render. */
export function postprocessSourceCandidates(
  artifacts: readonly ScenarioPresignedArtifactDto[] | readonly (ScenarioRenderArtifactDto & {
    url: string | null;
  })[],
): (ScenarioRenderArtifactDto & { url: string | null })[] {
  return artifacts.filter(
    (artifact): artifact is ScenarioRenderArtifactDto & { url: string | null } =>
      artifact.artifactState === "available" && artifact.mediaType.startsWith("video/"),
  );
}
