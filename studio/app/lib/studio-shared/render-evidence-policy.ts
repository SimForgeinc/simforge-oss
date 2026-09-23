import { z } from "zod";

import type { RenderEvidenceRejection } from "./scenario-render-control";

/**
 * Control-plane acceptance of render evidence under the no-silent-fallbacks
 * policy (docs/engineering/no-silent-fallbacks.md). The control plane is the
 * last line of defence: evidence that records a degradation (an inexact map
 * or environment, an unverified runtime, a substituted body the intent did
 * not allow, an ungraded or legacy-sourced native render) is refused here
 * with a code naming it, whatever the worker's own verdict says.
 *
 * Feature names mirror the `CONTROL_FEATURE_*` constants in
 * `@simforge-oss/render` (worker-control.ts). A field gated by a feature is
 * required only when the lease listed that feature: an older worker that
 * was never asked for it is still accepted.
 */

export const RENDER_CONTROL_FEATURE_NATIVE_SCENE_SOURCE = "native-evidence.scene-source";
export const RENDER_CONTROL_FEATURE_NATIVE_PARITY = "native-evidence.parity";
export const RENDER_CONTROL_FEATURE_NATIVE_STAGE_TIMINGS = "native-evidence.stage-timings";
export const RENDER_CONTROL_FEATURE_NATIVE_CAPTURE_CLOCK = "native-evidence.capture-clock";
export const RENDER_CONTROL_FEATURE_RENDER_SUBSTITUTIONS = "render-evidence.substitutions";
export const RENDER_CONTROL_FEATURE_NATIVE_ENCODER = "native-evidence.encoder";

/**
 * How this control plane holds a worker to each feature its leases list
 * (`CONTROL_FEATURES_V1`). A feature the lease listed whose field is missing
 * is a rejection, never silently accepted. Every listed feature needs an
 * entry here (a contract test enforces it), so adding a feature forces a
 * decision about its requirement.
 */
export const RENDER_CONTROL_FEATURE_REQUIREMENTS: Readonly<Record<string, string>> = {
  [RENDER_CONTROL_FEATURE_NATIVE_SCENE_SOURCE]: "native manifest and diagnostics carry sceneSource; it must be render-timeline and match the intent's render.timeline",
  [RENDER_CONTROL_FEATURE_NATIVE_PARITY]: "native diagnostics carry a passing parity block whenever the intent declares render.timeline",
  [RENDER_CONTROL_FEATURE_NATIVE_STAGE_TIMINGS]: "native diagnostics carry timings.stages",
  [RENDER_CONTROL_FEATURE_NATIVE_CAPTURE_CLOCK]: "native manifest carries capture",
  [RENDER_CONTROL_FEATURE_NATIVE_ENCODER]: "native manifest carries encoder",
  [RENDER_CONTROL_FEATURE_RENDER_SUBSTITUTIONS]: "every engine substitution is recorded in substitutions and allowed by the intent; CARLA body substitutions need it",
};

/** The `allowSubstitutions` entry (`RenderSubstitutionKind`) that permits a CARLA actor body substitution. */
export const CARLA_ACTOR_BODY_SUBSTITUTION = "carla-actor-body";
/** The job-input field that grants a substitution, recorded as each substitution's `allowedBy`. */
export const RENDER_SUBSTITUTION_GRANT_FIELD = "allowSubstitutions";

/**
 * One substitution an engine made because the intent allowed it
 * (`RenderSubstitution` in `@simforge-oss/render`): `kind` is the
 * `RenderSubstitutionKind` the intent's `allowSubstitutions` must list, and
 * `allowedBy` names the granting field (`allowSubstitutions`). Unknown keys
 * (an engine's `details`) are ignored.
 */
export const RenderSubstitutionRecordSchema = z.object({
  kind: z.string().trim().min(1).max(64),
  subject: z.string().trim().min(1).max(200),
  requested: z.string().trim().min(1).max(512),
  rendered: z.string().trim().min(1).max(512),
  allowedBy: z.string().trim().min(1).max(64),
});
export type RenderSubstitutionRecord = z.infer<typeof RenderSubstitutionRecordSchema>;

export type SubstitutionVerdict =
  | { rejection: RenderEvidenceRejection; substitutions?: undefined }
  | { rejection?: undefined; substitutions: RenderSubstitutionRecord[] };

function listed(values: readonly string[], limit = 20): string {
  const head = values.slice(0, limit).join(", ");
  return values.length > limit ? `${head} (+${values.length - limit} more)` : head;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * The `substitutions` an engine manifest recorded: each must parse and must
 * name an `allowSubstitutions` entry of this intent. Absent means none.
 */
export function renderSubstitutionsVerdict(
  raw: unknown,
  allowSubstitutions: readonly string[],
): SubstitutionVerdict {
  if (raw === undefined) return { substitutions: [] };
  const parsed = z.array(RenderSubstitutionRecordSchema).max(4096).safeParse(raw);
  if (!parsed.success) {
    return {
      rejection: {
        code: "render_substitutions_invalid",
        message: `the engine manifest's substitutions list is malformed: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`).join("; ")}`,
      },
    };
  }
  const allowed = new Set(allowSubstitutions);
  const refused = parsed.data.filter((item) => !allowed.has(item.kind) || item.allowedBy !== RENDER_SUBSTITUTION_GRANT_FIELD);
  if (refused.length > 0) {
    return {
      rejection: {
        code: "render_substitution_not_allowed",
        message: `the engine substituted inputs the render intent did not allow: ${listed(refused.map((item) => `${item.subject} ${item.kind} ${item.requested} -> ${item.rendered} (allowedBy ${item.allowedBy})`))}; the intent allows ${allowSubstitutions.length > 0 ? allowSubstitutions.join(", ") : "no substitutions"}`,
        details: { substitutions: refused.slice(0, 50), allowSubstitutions: [...allowSubstitutions] },
      },
    };
  }
  return { substitutions: parsed.data };
}

const CarlaVehicleFallbackSchema = z.object({
  actorId: z.string().trim().min(1),
  authoredCatalogId: z.string().trim().min(1),
  fallbackCatalogId: z.string().trim().min(1),
});

/**
 * CARLA actor bodies rendered other than authored. A current executor
 * records each in its manifest's `substitutions`; an rc.73 executor listed
 * them only in `carlaVehicleFallbacks` and could not record them. Either
 * way a body substitution is accepted only when the intent allowed
 * `carla-actor-body`, the lease negotiated `render-evidence.substitutions`,
 * and a substitution record names it; otherwise the render shows bodies
 * nobody asked for and is refused. A manifest that carries neither list
 * cannot say whether any body was substituted and is refused too.
 */
export function carlaSubstitutionVerdict(input: {
  fallbacks: unknown;
  substitutions: unknown;
  allowSubstitutions: readonly string[];
  substitutionsNegotiated: boolean;
}): SubstitutionVerdict {
  if (input.fallbacks === undefined && input.substitutions === undefined) {
    return {
      rejection: {
        code: "carla_evidence_field_missing",
        message: "the CARLA manifest has neither substitutions nor carlaVehicleFallbacks, so the control plane cannot tell whether any actor body was substituted",
        details: { field: "substitutions" },
      },
    };
  }
  const fallbacks = z.array(CarlaVehicleFallbackSchema).max(10_000).safeParse(input.fallbacks ?? []);
  if (!fallbacks.success) {
    return {
      rejection: {
        code: "carla_evidence_field_invalid",
        message: `the CARLA manifest's carlaVehicleFallbacks list is malformed: ${fallbacks.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`).join("; ")}`,
        details: { field: "carlaVehicleFallbacks" },
      },
    };
  }
  const recorded = renderSubstitutionsVerdict(input.substitutions, input.allowSubstitutions);
  if (recorded.rejection) return recorded;
  if (recorded.substitutions.length > 0 && !input.substitutionsNegotiated) {
    return {
      rejection: {
        code: "render_substitution_unrecorded",
        message: `CARLA substituted inputs although the lease did not negotiate ${RENDER_CONTROL_FEATURE_RENDER_SUBSTITUTIONS}: ${listed(recorded.substitutions.map((item) => `${item.subject}: ${item.requested} -> ${item.rendered}`))}`,
        details: { substitutions: recorded.substitutions.slice(0, 50) },
      },
    };
  }
  const bodies = fallbacks.data;
  if (bodies.length === 0) return recorded;
  const describe = (item: z.infer<typeof CarlaVehicleFallbackSchema>) => `${item.actorId}: ${item.authoredCatalogId} -> ${item.fallbackCatalogId}`;
  if (!input.allowSubstitutions.includes(CARLA_ACTOR_BODY_SUBSTITUTION)) {
    return {
      rejection: {
        code: "carla_actor_body_substituted",
        message: `CARLA rendered ${bodies.length} actor(s) with a different body than authored, and the render intent did not allow ${CARLA_ACTOR_BODY_SUBSTITUTION}: ${listed(bodies.map(describe))}`,
        details: { carlaVehicleFallbacks: bodies.slice(0, 50) },
      },
    };
  }
  const unrecorded = input.substitutionsNegotiated
    ? bodies.filter((item) => !recorded.substitutions.some((entry) =>
      entry.kind === CARLA_ACTOR_BODY_SUBSTITUTION
      && entry.subject === item.actorId
      && entry.requested === item.authoredCatalogId
      && entry.rendered === item.fallbackCatalogId))
    : bodies;
  if (unrecorded.length > 0) {
    return {
      rejection: {
        code: "render_substitution_unrecorded",
        message: input.substitutionsNegotiated
          ? `CARLA substituted actor bodies its manifest does not record under substitutions: ${listed(unrecorded.map(describe))}`
          : `CARLA substituted actor bodies but the lease did not negotiate ${RENDER_CONTROL_FEATURE_RENDER_SUBSTITUTIONS}, so they cannot be recorded: ${listed(unrecorded.map(describe))}`,
        details: { carlaVehicleFallbacks: unrecorded.slice(0, 50) },
      },
    };
  }
  return recorded;
}

/** Map identity modes that bind the CARLA world to the package XODR itself. */
const EXACT_MAP_IDENTITY_MODES = new Set(["xodr-byte-exact", "approved-cooked-digest"]);

/**
 * The CARLA worker attestation (`simforge.worker-attestation/v1`) must show a
 * scenario render on the pinned runtime image, in a world bound exactly to
 * the package XODR (never a generated bare-OpenDRIVE world), with the
 * requested environment applied exactly and a complete worker identity.
 * Mirrored by `simforge.carla_render_attestation_accepted` in SimCloud.
 */
export function carlaRuntimeEvidencePolicyFailure(attestation: unknown): RenderEvidenceRejection | null {
  const doc = record(attestation);
  if (!doc) {
    return { code: "carla_attestation_missing", message: "the CARLA manifest carries no worker attestation" };
  }
  if (doc.purpose !== "scenario-render") {
    return {
      code: "carla_run_not_scenario_render",
      message: `the CARLA worker attests purpose ${String(doc.purpose ?? "(missing)")}; only a scenario-render run is accepted as the scenario's render`,
      details: { purpose: doc.purpose ?? null },
    };
  }
  const runtime = record(doc.runtimeEvidence);
  if (!runtime || runtime.available !== true) {
    return {
      code: "carla_runtime_evidence_missing",
      message: "the CARLA worker attestation has no runtime evidence, so the rendered map, environment and runtime image are unverified",
    };
  }
  const map = record(runtime.map);
  if (!map) {
    return { code: "carla_runtime_evidence_missing", message: "the CARLA runtime evidence has no map evidence", details: { field: "runtimeEvidence.map" } };
  }
  if (map.identityMode === "generated-opendrive") {
    return {
      code: "carla_map_generated",
      message: `CARLA rendered a world generated from the bare OpenDRIVE (${String(map.loadedMapName ?? map.requestedMapName ?? "unknown map")}): no cooked buildings, props or signals, so it is not the scenario's map`,
      details: { identityMode: map.identityMode, requestedMapName: map.requestedMapName ?? null },
    };
  }
  if (map.exact !== true || map.binding !== "exact" || !EXACT_MAP_IDENTITY_MODES.has(String(map.identityMode))) {
    return {
      code: "carla_map_not_exact",
      message: `CARLA rendered ${String(map.loadedMapName ?? "a world")} with map binding ${String(map.binding ?? "(missing)")} (identity ${String(map.identityMode ?? "(missing)")}, exact ${String(map.exact ?? "(missing)")}); only a world bound exactly to the package XODR is accepted`,
      details: { binding: map.binding ?? null, identityMode: map.identityMode ?? null, exact: map.exact ?? null },
    };
  }
  const environment = record(runtime.environment);
  if (!environment || environment.exact !== true) {
    return {
      code: "carla_environment_not_exact",
      message: environment
        ? `CARLA did not apply the requested environment exactly (mode ${String(environment.mode ?? "unknown")}, reason ${String(environment.reason ?? "unknown")}); the render would show different lighting or weather than requested`
        : "the CARLA runtime evidence has no environment evidence, so the rendered weather and lighting are unverified",
      details: environment ? { mode: environment.mode ?? null, reason: environment.reason ?? null, requested: environment.requested ?? null } : { field: "runtimeEvidence.environment" },
    };
  }
  const image = record(runtime.runtimeImage);
  if (!image || image.exact !== true) {
    return {
      code: "carla_runtime_image_unverified",
      message: `the CARLA runtime image is not verified as the pinned manifest (configured ${String(image?.configuredManifestSha256 ?? "nothing")}, pinned ${String(image?.linuxAmd64ManifestSha256 ?? "unknown")}); set SIMFORGE_CARLA_IMAGE_MANIFEST_SHA256 in the worker image`,
      details: { configuredManifestSha256: image?.configuredManifestSha256 ?? null },
    };
  }
  if (doc.workerIdentityComplete !== true) {
    return {
      code: "carla_worker_identity_incomplete",
      message: `the CARLA worker attestation has no complete identity (image ${String(doc.workerImageDigest ?? "missing")}, revision ${String(doc.workerRevision ?? "missing")}); set SIMFORGE_WORKER_IMAGE_DIGEST and SIMFORGE_WORKER_REVISION on the worker`,
      details: { workerImageDigest: doc.workerImageDigest ?? null, workerRevision: doc.workerRevision ?? null },
    };
  }
  return null;
}

/** The parts of the native manifest and diagnostics these checks read (`@simforge-oss/render/native`). */
export type NativeNegotiatedEvidence = {
  manifest: {
    sceneSource?: string;
    timelineSha256?: string;
    capture?: unknown;
    encoder?: unknown;
  };
  diagnostics: {
    sceneSource?: string;
    timelineSha256?: string;
    parity?: { pass: boolean; comparedPoses: number; maxPositionErrorM: number; maxHeadingErrorDeg: number; presenceMismatches: number };
    timings: { stages?: unknown };
  };
};

function missingField(document: string, field: string, feature: string): RenderEvidenceRejection {
  return {
    code: "native_evidence_field_missing",
    message: `the native ${document} has no ${field}, although the lease negotiated ${feature}`,
    details: { document, field, feature },
  };
}

/**
 * Required-when-negotiated native evidence. For every feature the lease
 * listed, its field must be present; when the intent declares
 * `render.timeline`, the run must have rendered from that timeline and pose
 * parity must have been graded and passed. A legacy-sourced run (poses
 * re-lowered from the derived OpenSCENARIO export) is refused.
 */
export function nativeEvidencePolicyFailure(input: NativeNegotiatedEvidence & {
  features: ReadonlySet<string>;
  /** sha256 of the intent's `render.timeline` asset, or null when the intent declares none. */
  timelineSha256: string | null;
  /** The intent's `motionSource`: only `original-xosc` permits the legacy scene source. */
  motionSource?: string;
}): RenderEvidenceRejection | null {
  const { manifest, diagnostics, features, timelineSha256 } = input;
  const legacyReplay = input.motionSource === "original-xosc";
  if (features.has(RENDER_CONTROL_FEATURE_NATIVE_SCENE_SOURCE)) {
    if (!manifest.sceneSource) return missingField("manifest", "sceneSource", RENDER_CONTROL_FEATURE_NATIVE_SCENE_SOURCE);
    if (!diagnostics.sceneSource) return missingField("diagnostics", "sceneSource", RENDER_CONTROL_FEATURE_NATIVE_SCENE_SOURCE);
    if (manifest.sceneSource !== diagnostics.sceneSource || manifest.timelineSha256 !== diagnostics.timelineSha256) {
      return {
        code: "native_scene_source_mismatch",
        message: `the native manifest (${manifest.sceneSource}) and diagnostics (${diagnostics.sceneSource}) disagree on the scene source or timeline`,
      };
    }
    if (legacyReplay) {
      // The explicitly requested legacy replay of a revision without a
      // stored trace: it must say so, and there is no timeline to grade.
      if (manifest.sceneSource !== "openscenario-legacy" || timelineSha256) {
        return {
          code: "native_scene_source_mismatch",
          message: `the intent requests the legacy OpenSCENARIO replay but the render reports ${manifest.sceneSource}${timelineSha256 ? " and the intent also declares a render.timeline" : ""}`,
          details: { sceneSource: manifest.sceneSource },
        };
      }
      return null;
    }
    if (manifest.sceneSource === "openscenario-legacy") {
      return {
        code: "native_scene_source_legacy",
        message: timelineSha256
          ? "the native render re-lowered poses from the derived OpenSCENARIO export instead of the declared render timeline"
          : "the native render re-lowered poses from the derived OpenSCENARIO export (yaw-only rotation, class-default actors): the intent declares no render.timeline",
        details: { sceneSource: manifest.sceneSource },
      };
    }
    if (manifest.sceneSource !== "render-timeline" || !timelineSha256 || manifest.timelineSha256 !== timelineSha256) {
      return {
        code: "native_scene_source_mismatch",
        message: `the native render reports scene source ${manifest.sceneSource} with timeline ${manifest.timelineSha256 ?? "(none)"}, but the intent declares ${timelineSha256 ? `render.timeline ${timelineSha256}` : "no render.timeline"}`,
        details: { sceneSource: manifest.sceneSource, timelineSha256: manifest.timelineSha256 ?? null, declaredTimelineSha256: timelineSha256 },
      };
    }
  }
  if (timelineSha256 && features.has(RENDER_CONTROL_FEATURE_NATIVE_PARITY)) {
    const parity = diagnostics.parity;
    if (!parity) {
      return {
        code: "native_parity_missing",
        message: "the native render declares a render timeline but its diagnostics carry no pose parity: the render service did not report observed actor transforms, so actor poses were never graded",
        details: { feature: RENDER_CONTROL_FEATURE_NATIVE_PARITY },
      };
    }
    if (parity.comparedPoses <= 0) {
      return {
        code: "native_parity_ungraded",
        message: "the native pose parity compared no poses, so actor poses were never graded",
        details: { parity },
      };
    }
    if (!parity.pass) {
      return {
        code: "native_parity_failed",
        message: `the native render's actor poses do not match the render timeline: max ${parity.maxPositionErrorM} m / ${parity.maxHeadingErrorDeg} deg, ${parity.presenceMismatches} presence mismatch(es)`,
        details: { parity },
      };
    }
  }
  if (features.has(RENDER_CONTROL_FEATURE_NATIVE_CAPTURE_CLOCK) && manifest.capture === undefined) {
    return missingField("manifest", "capture", RENDER_CONTROL_FEATURE_NATIVE_CAPTURE_CLOCK);
  }
  if (features.has(RENDER_CONTROL_FEATURE_NATIVE_ENCODER) && manifest.encoder === undefined) {
    return missingField("manifest", "encoder", RENDER_CONTROL_FEATURE_NATIVE_ENCODER);
  }
  if (features.has(RENDER_CONTROL_FEATURE_NATIVE_STAGE_TIMINGS) && diagnostics.timings.stages === undefined) {
    return missingField("diagnostics", "timings.stages", RENDER_CONTROL_FEATURE_NATIVE_STAGE_TIMINGS);
  }
  return null;
}
