/**
 * What the user actually gave us, and what may honestly be done with it.
 *
 * The product rule this module exists to enforce: a plain video is not a
 * driving input. Open-loop trajectory scoring needs the camera rig the model
 * was trained on, calibration, per-frame timestamps and ego history, and a
 * *score* additionally needs a reference future. When any of those is absent
 * the UI refuses the run and names the missing pieces — it never synthesizes a
 * camera view, an ego pose, a timestamp or a label to make the form submittable.
 *
 * Classification here is a pre-flight for the user's benefit. The worker
 * re-validates the real bundle and is authoritative; an unreadable bundle is
 * therefore reported as unverified rather than assumed good or assumed bad.
 */

import type { ModelCatalogEntry } from "./model-catalog";

/** A driving input requirement, in the words the refusal notice uses. */
export type DrivingInputRequirement =
  | "cameras"
  | "calibration"
  | "frame-timestamps"
  | "ego-history"
  | "reference-future";

export const DRIVING_REQUIREMENT_LABELS: Record<DrivingInputRequirement, string> = {
  cameras: "the model's required camera views",
  calibration: "camera calibration (intrinsics and rig extrinsics)",
  "frame-timestamps": "per-frame timestamps",
  "ego-history": "ego state history",
  "reference-future": "a recorded reference future to score against",
};

export type ClipManifestProbe = {
  schema: string | null;
  cameraIds: number[];
  hasCalibration: boolean;
  hasFrameTimestamps: boolean;
  hasEgoHistory: boolean;
  hasReferenceFuture: boolean;
  /**
   * A replayable-scene bundle's own declarations. A bundle that says it is a
   * synthetic fixture, or that its validity gates did not pass, must never be
   * presented as scoreable however complete it otherwise looks.
   */
  sourceKind: string | null;
  qualified: boolean | null;
  /**
   * The camera set the bundle's validity gates were actually MEASURED over. A
   * rig is servable only if every one of its cameras appears here — a bundle
   * qualified over three cameras says nothing about a fourth.
   */
  profileCameraIds: number[] | null;
  durationS: number | null;
  itemCount: number;
};

/**
 * The classification of one selected input.
 *
 * `driving-clip` with `scoreable: false` is a legitimate run — a prediction —
 * and the results screen says so instead of showing an error-free zero.
 */
export type EvaluationInputClass =
  | {
      kind: "driving-clip";
      scoreable: boolean;
      probe: ClipManifestProbe;
      /** Requirements satisfied by the bundle but not by the chosen model, e.g. camera set. */
      modelMismatch: string[];
    }
  | { kind: "video-only"; mediaType: string; missing: DrivingInputRequirement[] }
  | { kind: "bundle-unverified"; reason: string }
  | { kind: "incomplete"; probe: ClipManifestProbe; missing: DrivingInputRequirement[] }
  | { kind: "unsupported"; mediaType: string; reason: string };

const VIDEO_MEDIA_TYPES = ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"];
const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".mkv"];
const BUNDLE_EXTENSIONS = [".zip", ".tar", ".tar.gz", ".tgz", ".tar.zst"];

/**
 * Read a clip/replay-context manifest the browser can parse without a bundle
 * reader. Returns null when the document is not a manifest at all.
 */
export function probeClipManifest(document: unknown): ClipManifestProbe | null {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return null;
  const record = document as Record<string, unknown>;
  const schema = typeof record.schema === "string" ? record.schema : null;

  const cameras = record.cameras;
  const cameraIds = Array.isArray(cameras)
    ? cameras
        .map((entry) => {
          if (typeof entry === "number") return entry;
          if (typeof entry === "object" && entry !== null) {
            const id = (entry as Record<string, unknown>).cameraId;
            if (typeof id === "number") return id;
          }
          return null;
        })
        .filter((id): id is number => id !== null)
    : [];

  const calibration = record.calibration;
  const ego = record.ego ?? record.egoHistory;
  const reference = record.reference ?? record.referenceFuture;
  const timestamps = record.timestampsUs ?? record.frameTimestampsUs;

  const hasCalibration =
    typeof calibration === "object" &&
    calibration !== null &&
    Object.keys(calibration as Record<string, unknown>).length > 0;

  const timestampsPresent =
    (Array.isArray(timestamps) && timestamps.length > 0) ||
    (Array.isArray(cameras) &&
      cameras.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          Array.isArray((entry as Record<string, unknown>).timestampsUs),
      ));

  const referencePresent =
    Array.isArray(reference)
      ? reference.length > 0
      : typeof reference === "object" &&
        reference !== null &&
        (reference as Record<string, unknown>).kind !== "none";

  if (schema === null && cameraIds.length === 0 && !hasCalibration && !timestampsPresent) {
    return null;
  }

  const source = record.source;
  const sourceKind =
    typeof source === "object" && source !== null && typeof (source as Record<string, unknown>).kind === "string"
      ? ((source as Record<string, unknown>).kind as string)
      : null;
  const validity = record.validity;
  const qualified =
    typeof validity === "object" && validity !== null && typeof (validity as Record<string, unknown>).qualified === "boolean"
      ? ((validity as Record<string, unknown>).qualified as boolean)
      : null;

  const profileCameraIds =
    typeof validity === "object" && validity !== null &&
    Array.isArray((validity as Record<string, unknown>).profileCameraIds)
      ? ((validity as Record<string, unknown>).profileCameraIds as unknown[]).filter(
          (id): id is number => typeof id === "number",
        )
      : null;

  const items = record.items;
  return {
    schema,
    sourceKind,
    qualified,
    profileCameraIds,
    cameraIds,
    hasCalibration,
    hasFrameTimestamps: timestampsPresent,
    hasEgoHistory: Array.isArray(ego) ? ego.length > 0 : typeof ego === "object" && ego !== null,
    hasReferenceFuture: referencePresent,
    durationS: typeof record.durationS === "number" ? record.durationS : null,
    itemCount: Array.isArray(items) && items.length > 0 ? items.length : 1,
  };
}

/**
 * Classify a selected file for a chosen model family.
 *
 * `manifest` is the parsed sidecar/manifest document when the selection carried
 * one; without it a bundle stays `bundle-unverified`, because guessing a bundle's
 * contents from its filename is exactly the fabrication this screen forbids.
 */
export function classifyEvaluationInput(
  file: { name: string; type: string; size: number },
  model: ModelCatalogEntry,
  manifest?: unknown,
): EvaluationInputClass {
  const name = file.name.toLowerCase();
  const isVideo =
    VIDEO_MEDIA_TYPES.includes(file.type) || VIDEO_EXTENSIONS.some((ext) => name.endsWith(ext));
  const isBundle = BUNDLE_EXTENSIONS.some((ext) => name.endsWith(ext));
  const isJson = name.endsWith(".json") || file.type === "application/json";

  if (manifest !== undefined) {
    const probe = probeClipManifest(manifest);
    if (probe) return classifyProbe(probe, model);
  }

  if (isJson && manifest === undefined) {
    return {
      kind: "unsupported",
      mediaType: file.type || "application/json",
      reason:
        "This JSON document is not a clip manifest. Select a clip bundle manifest, a replayable-scene bundle, or a video.",
    };
  }

  if (isBundle) {
    return {
      kind: "bundle-unverified",
      reason:
        "The bundle's contents are checked on the server after upload. Until then this run is not promised a score: if the bundle lacks the required cameras, calibration, timestamps or ego history, the job returns a refusal naming what is missing.",
    };
  }

  if (isVideo) {
    return {
      kind: "video-only",
      mediaType: file.type || "video/mp4",
      missing: ["cameras", "calibration", "frame-timestamps", "ego-history", "reference-future"],
    };
  }

  return {
    kind: "unsupported",
    mediaType: file.type || "application/octet-stream",
    reason:
      "Only videos and clip/replayable-scene bundles can be evaluated. Nothing about this file identifies it as either.",
  };
}

function classifyProbe(probe: ClipManifestProbe, model: ModelCatalogEntry): EvaluationInputClass {
  const missing: DrivingInputRequirement[] = [];
  if (probe.cameraIds.length === 0) missing.push("cameras");
  if (!probe.hasCalibration) missing.push("calibration");
  if (!probe.hasFrameTimestamps) missing.push("frame-timestamps");
  if (!probe.hasEgoHistory) missing.push("ego-history");

  if (missing.length > 0) return { kind: "incomplete", probe, missing };

  const required = model.cameras.required;
  const modelMismatch: string[] = [];

  // A measured profile bounds what the bundle can serve, independently of what
  // cameras it happens to contain: the gates were run over these cameras and
  // no others.
  const profile = probe.profileCameraIds;
  if (profile && profile.length > 0) {
    const wanted = required ?? model.cameras.default;
    const unmeasured = wanted.filter((id) => !profile.includes(id));
    if (unmeasured.length > 0) {
      modelMismatch.push(
        `This bundle's validity gates were measured over cameras [${profile.join(", ")}] only. ${model.displayName} needs [${wanted.join(", ")}], so camera${
          unmeasured.length === 1 ? "" : "s"
        } [${unmeasured.join(", ")}] would be unqualified for it.`,
      );
    }
  }

  if (required) {
    const absent = required.filter((id) => !probe.cameraIds.includes(id));
    if (absent.length > 0) {
      modelMismatch.push(
        `${model.displayName} requires camera ids [${required.join(", ")}]; the clip is missing [${absent.join(", ")}].`,
      );
    }
  } else if (probe.cameraIds.length > model.cameras.max) {
    modelMismatch.push(
      `${model.displayName} accepts at most ${model.cameras.max} cameras; the clip has ${probe.cameraIds.length}.`,
    );
  }

  // A fixture or an unqualified bundle can carry a reference future and still
  // not be scoreable: the bundle itself says its numbers do not count, and the
  // worker enforces that. Saying so here means the user learns it before the
  // run rather than from a result that arrives unscored.
  const declaredUnscoreable =
    probe.sourceKind === "synthetic-fixture" || probe.qualified === false;
  if (declaredUnscoreable) {
    modelMismatch.push(
      probe.sourceKind === "synthetic-fixture"
        ? "This bundle declares itself a synthetic fixture, which is a test artifact: it can be run but never scored, and it cannot set qualified state."
        : "This bundle's validity gates did not pass (validity.qualified is false), so a run against it is not scored and its envelope is not usable.",
    );
  }
  return {
    kind: "driving-clip",
    scoreable: probe.hasReferenceFuture && !declaredUnscoreable,
    probe,
    modelMismatch,
  };
}

/**
 * Which job kinds this input can legitimately produce with this model.
 *
 * Open-loop needs a driving input. Text analysis needs only pixels but also
 * needs the family to have a text head — asking a trajectory-only model a
 * question is a capability error, not a fallback.
 */
export function offerableJobKinds(
  input: EvaluationInputClass,
  model: ModelCatalogEntry,
): { kind: "alpamayo.openloop" | "alpamayo.text"; scoreable: boolean; blocked: string | null }[] {
  const offers: {
    kind: "alpamayo.openloop" | "alpamayo.text";
    scoreable: boolean;
    blocked: string | null;
  }[] = [];

  if (input.kind === "driving-clip") {
    offers.push({
      kind: "alpamayo.openloop",
      scoreable: input.scoreable && input.modelMismatch.length === 0,
      blocked: input.modelMismatch[0] ?? null,
    });
  } else if (input.kind === "bundle-unverified") {
    offers.push({ kind: "alpamayo.openloop", scoreable: false, blocked: null });
  } else if (input.kind === "video-only" || input.kind === "incomplete") {
    offers.push({
      kind: "alpamayo.openloop",
      scoreable: false,
      blocked:
        input.kind === "video-only"
          ? "A video alone is not a driving input: open-loop prediction needs the model's camera rig, calibration, frame timestamps and ego history."
          : `This bundle is missing ${input.missing.map((item) => DRIVING_REQUIREMENT_LABELS[item]).join(", ")}.`,
    });
  }

  offers.push({
    kind: "alpamayo.text",
    scoreable: false,
    blocked:
      model.textTasks.length > 0
        ? null
        : `${model.displayName} has no text head; it only predicts trajectories, and a text request comes back as an unsupported operation.`,
  });

  return offers;
}
