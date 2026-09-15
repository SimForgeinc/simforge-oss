/**
 * Taking a render this machine produced into an evaluation of a model.
 *
 * The two halves of the product meet here. A native render emits one video per
 * authored camera plus a manifest and a behaviour trace; an open-loop
 * evaluation needs a clip bundle: the model's camera slots, frames at the
 * model's cadence, and real ego poses. Nothing in this file converts anything.
 * It decides whether a given render CAN be evaluated by a given model, and it
 * drives the control plane's own ingestion so the conversion happens once,
 * server-side, with provenance and settlement — never as a hidden local step
 * that produces a file nobody can trace.
 *
 * The camera contract is the part that has to be checked before a render is
 * spent rather than after: the model server identifies cameras by integer slot
 * only, refuses a set that does not match, and a render is minutes of GPU. So
 * the rig is compared to the family's declared requirement up front and the
 * missing slots are named.
 */

import type {
  ComputeJob,
  ComputeJobInputRole,
  ComputeJobModelRef,
  ComputeJobSubmission,
} from "@simforge-oss/evaluation/client";
import type { EvaluationGateway } from "@simforge-oss/evaluation/client";
import { MODEL_CATALOG } from "./model-catalog";
import type { ModelFamilyId, ModelQuant } from "./model-catalog";

/**
 * Dataset camera name to the integer slot the inference wire uses.
 *
 * Mirrored from `@simforge-oss/scenario`'s `ALPAMAYO_CAMERA_INDEX` rather than
 * imported: this module is bundled into the browser portal, and that package
 * pulls a Node-only graph. The Alpamayo rig presets deliberately name their
 * sensors after these dataset cameras, which is what makes the mapping a table
 * lookup instead of a guess — so an unknown sensor id is reported, never
 * assigned a slot.
 */
export const ALPAMAYO_CAMERA_SLOT: Readonly<Record<string, number>> = Object.freeze({
  camera_cross_left_120fov: 0,
  camera_front_wide_120fov: 1,
  camera_cross_right_120fov: 2,
  camera_rear_left_70fov: 3,
  camera_rear_tele_30fov: 4,
  camera_rear_right_70fov: 5,
  camera_front_tele_30fov: 6,
});

/** One rendered camera: the sensor the rig authored and the video it produced. */
export type RenderedCamera = {
  actorId: string;
  /** The rig's sensor id. An Alpamayo rig names these after dataset cameras. */
  sensorId: string;
  /** Artifact id of that camera's encoded video. */
  videoArtifactId: string;
  width: number;
  height: number;
  framesPerSecond: number;
  frameCount: number;
};

/** What a completed native render offers an evaluation. */
export type RenderHandoffSource = {
  renderJobId: string;
  /**
   * Identity of what was ACTUALLY captured, supplied by the producer.
   *
   * Deliberately data rather than something computed here. It must hash the
   * sensors the render really used - post-edit mounts, the FOV actually
   * rendered, the dimensions used - and the camera subset the model consumed,
   * because an author who widens one camera's FOV while the rig id stays
   * `alpamayo-4cam` has produced a different capture. Two things it must NOT
   * be: the unedited preset's digest, which is a recommendation and not an
   * identity, and the render's `rigRevision`, which is a monotonic
   * per-session counter and cannot identify a capture across runs or machines.
   *
   * Null when the producer did not supply one; the panel then says so instead
   * of showing a rig name as though it were an identity.
   */
  captureVersion: string | null;
  /** The scenario document and the content hash the render froze. */
  scenarioDocumentId: string;
  scenarioContentSha256: string;
  /** Rig preset id the cameras came from, for the receipt. */
  rigPresetId: string | null;
  manifestArtifactId: string;
  traceArtifactId: string;
  cameras: readonly RenderedCamera[];
};

export type RigCameraCheck =
  | { compatible: true; slots: readonly number[] }
  | {
    compatible: false;
    /** Slots the family requires that this rig does not render. */
    missingSlots: readonly number[];
    /** Sensor ids that map to no known camera slot. */
    unmappedSensorIds: readonly string[];
    reason: string;
  };

const slotList = (slots: readonly number[]) => slots.join(", ");

/**
 * Can this render's cameras satisfy this model family?
 *
 * A family with a variable camera set accepts what it is given; a family with
 * an exact requirement accepts nothing else, and padding the set is refused by
 * the model server rather than silently tolerated, so extra cameras are fine
 * but a missing one is fatal.
 */
export function checkRenderRigForFamily(
  cameras: readonly RenderedCamera[],
  family: ModelFamilyId,
): RigCameraCheck {
  const entry = MODEL_CATALOG[family];
  const rendered: number[] = [];
  const unmapped: string[] = [];
  for (const camera of cameras) {
    const slot = ALPAMAYO_CAMERA_SLOT[camera.sensorId];
    if (slot === undefined) unmapped.push(camera.sensorId);
    else rendered.push(slot);
  }
  rendered.sort((a, b) => a - b);

  const required = entry?.cameras.required ?? null;
  if (required === null) {
    // Variable set: any mapped camera works, but a rig of nothing but unknown
    // sensors offers the model no slot at all.
    if (rendered.length === 0) {
      return {
        compatible: false,
        missingSlots: [],
        unmappedSensorIds: unmapped,
        reason: unmapped.length > 0
          ? `None of this render's cameras (${unmapped.join(", ")}) map to a model camera slot. Fit an Alpamayo rig preset and render again.`
          : "This render has no cameras, so there is nothing for the model to look at.",
      };
    }
    return { compatible: true, slots: rendered };
  }

  const missing = required.filter((slot: number) => !rendered.includes(slot));
  if (missing.length === 0) return { compatible: true, slots: rendered };
  return {
    compatible: false,
    missingSlots: missing,
    unmappedSensorIds: unmapped,
    reason:
      `${entry?.displayName ?? family} requires camera slots ${slotList(required)} and this render has ${
        rendered.length > 0 ? slotList(rendered) : "none of them"
      }. Missing ${slotList(missing)}. Fit the matching Alpamayo rig preset to the recording vehicle and render again — the model server refuses an incomplete camera set rather than scoring a partial view.`
      + (unmapped.length > 0 ? ` Sensors ${unmapped.join(", ")} map to no model slot and were ignored.` : ""),
  };
}

/** The ingestion the control plane performs; the desktop never converts locally. */
export const RENDER_CLIP_INGEST_KIND = "ingest.render-clip" as const;

export type RenderClipIngestRequest = {
  renderManifestArtifactId: string;
  traceArtifactId: string;
  cameraVideoArtifactIds: readonly string[];
  /** Observation instant; the control plane defaults it to the clip's end. */
  t0Us?: number;
  cameraProfile: string;
  sourceRenderJobId: string;
};

export type RenderClipIngestResult = {
  artifactId: string;
  role: "clip-bundle";
  cameras: readonly { cameraId: number; frameCount: number }[];
  t0Us: number;
  /**
   * A trajectory that came out of the simulation is `authored` — simulation
   * truth. It is never `dataset`: only a recorded future may claim that, and
   * the control plane refuses a bundle that mislabels one as the other.
   */
  reference: { kind: "authored" | "dataset"; points?: number };
  frameCount: number;
  /**
   * The converter's own account of cadence, passed through untouched.
   *
   * A model consumes frames at a fixed rate; a render rate that does not
   * divide it forces nearest-frame selection, and the resulting jitter is
   * reported rather than corrected. `cadenceDividesExactly: false` means the
   * clip is usable but carries a timing error that belongs on screen, because
   * it lands in the metric with nothing else to attribute it to.
   */
  /** Slots present in the capture that this model did not consume. */
  renderedNotConsumed?: readonly number[];
  timeBase?: {
    renderFps: number;
    modelHz: number;
    cadenceDividesExactly: boolean;
    worstResampleErrorS: number;
  };
};

/** Every link from the authored scenario to the scored result, as stored fields. */
export type RenderEvaluationProvenance = {
  scenarioDocumentId: string;
  scenarioContentSha256: string;
  renderJobId: string;
  rigPresetId: string | null;
  captureVersion: string | null;
  cameraSlots: readonly number[];
  /** Slots rendered but not consumed by this model, from the converter. */
  renderedNotConsumed: readonly number[];
  renderManifestArtifactId: string;
  traceArtifactId: string;
  cameraVideoArtifactIds: readonly string[];
  clipBundleArtifactId: string;
  referenceKind: "authored" | "dataset";
  /** Null when the converter reported no cadence account. */
  timeBase: RenderClipIngestResult["timeBase"] | null;
  computeJobId: string;
  model: ComputeJobModelRef;
};

export type RenderHandoffPlan = {
  source: RenderHandoffSource;
  model: ComputeJobModelRef;
  check: RigCameraCheck;
  cameraProfile: string;
};

/**
 * Build the plan without performing anything.
 *
 * Deliberately separate from execution so a UI can show what will happen — and
 * refuse with a named reason — before a single byte moves or a job is charged.
 */
export function planRenderHandoff(
  source: RenderHandoffSource,
  model: { family: ModelFamilyId; revision: string; quant: ModelQuant },
  cameraProfile: string,
): RenderHandoffPlan {
  return {
    source,
    model: { family: model.family, revision: model.revision, quant: model.quant },
    check: checkRenderRigForFamily(source.cameras, model.family),
    cameraProfile,
  };
}

export type RenderHandoffStage =
  | "ingesting"
  | "awaiting-bundle"
  | "submitting"
  | "submitted";

export type RenderHandoffProgress = {
  stage: RenderHandoffStage;
  detail: string;
};

export type RenderHandoffGateway = EvaluationGateway & {
  /**
   * Convert a render into a clip bundle. Implemented by the control plane
   * because the conversion needs the pinned decoder the worker image carries,
   * and because one audited conversion serves both hosts.
   */
  ingestRenderClip(
    request: RenderClipIngestRequest,
    signal?: AbortSignal,
  ): Promise<RenderClipIngestResult>;
};

export class RenderHandoffRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "RenderHandoffRefused";
  }
}

/**
 * Ingest the render, then submit the evaluation that reads it.
 *
 * The submission carries `sourceRenderJobId` as a named field: params reject
 * anything path- or URL-shaped, and provenance that matters belongs in a field
 * the control plane stores, not in a free-text bag.
 */
export async function runRenderHandoff(
  gateway: RenderHandoffGateway,
  plan: RenderHandoffPlan,
  options: {
    idempotencyKey: string;
    onProgress?: (progress: RenderHandoffProgress) => void;
    signal?: AbortSignal;
  },
): Promise<{ job: ComputeJob; provenance: RenderEvaluationProvenance }> {
  if (!plan.check.compatible) throw new RenderHandoffRefused(plan.check.reason);
  const report = (stage: RenderHandoffStage, detail: string) =>
    options.onProgress?.({ stage, detail });

  const cameraVideoArtifactIds = plan.source.cameras.map((camera) => camera.videoArtifactId);
  report("ingesting", `Building a clip bundle from ${cameraVideoArtifactIds.length} rendered cameras`);
  const bundle = await gateway.ingestRenderClip(
    {
      renderManifestArtifactId: plan.source.manifestArtifactId,
      traceArtifactId: plan.source.traceArtifactId,
      cameraVideoArtifactIds,
      cameraProfile: plan.cameraProfile,
      sourceRenderJobId: plan.source.renderJobId,
    },
    options.signal,
  );

  report(
    "awaiting-bundle",
    `Clip bundle ${bundle.artifactId} covers ${bundle.cameras.length} cameras against a ${bundle.reference.kind} reference`,
  );

  const input: { role: ComputeJobInputRole; artifactId: string }[] = [
    { role: "clip-bundle", artifactId: bundle.artifactId },
  ];
  const submission: ComputeJobSubmission = {
    kind: "alpamayo.openloop",
    idempotencyKey: options.idempotencyKey,
    input: {
      model: plan.model,
      inputs: input,
      sourceRenderJobId: plan.source.renderJobId,
    },
  };

  report("submitting", `Submitting an open-loop run of ${plan.model.family} @ ${plan.model.revision.slice(0, 12)}`);
  const job = await gateway.submitJob(submission, options.signal);
  report("submitted", `Run ${job.id} accepted`);

  return {
    job,
    provenance: {
      scenarioDocumentId: plan.source.scenarioDocumentId,
      scenarioContentSha256: plan.source.scenarioContentSha256,
      renderJobId: plan.source.renderJobId,
      rigPresetId: plan.source.rigPresetId,
      captureVersion: plan.source.captureVersion,
      cameraSlots: plan.check.slots,
      renderedNotConsumed: bundle.renderedNotConsumed ?? [],
      renderManifestArtifactId: plan.source.manifestArtifactId,
      traceArtifactId: plan.source.traceArtifactId,
      cameraVideoArtifactIds,
      clipBundleArtifactId: bundle.artifactId,
      referenceKind: bundle.reference.kind,
      timeBase: bundle.timeBase ?? null,
      computeJobId: job.id,
      model: plan.model,
    },
  };
}
