import { describe, expect, it } from "vitest";
import {
  CONTROL_FEATURES_V1,
  CONTROL_FEATURE_NATIVE_CAPTURE_CLOCK,
  CONTROL_FEATURE_NATIVE_ENCODER,
  CONTROL_FEATURE_NATIVE_PARITY,
  CONTROL_FEATURE_NATIVE_SCENE_SOURCE,
  CONTROL_FEATURE_NATIVE_STAGE_TIMINGS,
  CONTROL_FEATURE_RENDER_SUBSTITUTIONS,
} from "@simforge-oss/render";
import { RENDER_SUBSTITUTION_KINDS } from "@simforge-oss/scenario";
import {
  CARLA_ACTOR_BODY_SUBSTITUTION,
  carlaRuntimeEvidencePolicyFailure,
  carlaSubstitutionVerdict,
  nativeEvidencePolicyFailure,
  RENDER_CONTROL_FEATURE_NATIVE_CAPTURE_CLOCK,
  RENDER_CONTROL_FEATURE_NATIVE_ENCODER,
  RENDER_CONTROL_FEATURE_NATIVE_PARITY,
  RENDER_CONTROL_FEATURE_NATIVE_SCENE_SOURCE,
  RENDER_CONTROL_FEATURE_NATIVE_STAGE_TIMINGS,
  RENDER_CONTROL_FEATURE_RENDER_SUBSTITUTIONS,
  RENDER_CONTROL_FEATURE_REQUIREMENTS,
  RENDER_SUBSTITUTION_GRANT_FIELD,
  renderSubstitutionsVerdict,
} from "../render-evidence-policy";

const TIMELINE = "c".repeat(64);
const ALL_FEATURES = new Set([
  RENDER_CONTROL_FEATURE_NATIVE_SCENE_SOURCE,
  RENDER_CONTROL_FEATURE_NATIVE_PARITY,
  RENDER_CONTROL_FEATURE_NATIVE_STAGE_TIMINGS,
  RENDER_CONTROL_FEATURE_NATIVE_CAPTURE_CLOCK,
  RENDER_CONTROL_FEATURE_NATIVE_ENCODER,
  RENDER_CONTROL_FEATURE_RENDER_SUBSTITUTIONS,
]);

function exactAttestation(overrides: Record<string, unknown> = {}, runtime: Record<string, unknown> = {}) {
  return {
    schema: "simforge.worker-attestation/v1",
    purpose: "scenario-render",
    workerImageDigest: `sha256:${"d".repeat(64)}`,
    workerRevision: "e".repeat(40),
    workerIdentityComplete: true,
    runtimeEvidence: {
      schema: "simforge.carla-runtime-evidence/v1",
      available: true,
      map: {
        schema: "simforge.carla-map-evidence/v1", available: true, identityMode: "xodr-byte-exact",
        binding: "exact", exact: true, loadedMapName: "yale_st",
      },
      environment: { schema: "simforge.environment-evidence/v1", available: true, exact: true },
      runtimeImage: { exact: true, configuredManifestSha256: "f".repeat(64) },
      ...runtime,
    },
    ...overrides,
  };
}

describe("feature names", () => {
  it("match the render package's CONTROL_FEATURE_* constants and substitution kinds", () => {
    expect(RENDER_CONTROL_FEATURE_NATIVE_SCENE_SOURCE).toBe(CONTROL_FEATURE_NATIVE_SCENE_SOURCE);
    expect(RENDER_CONTROL_FEATURE_NATIVE_PARITY).toBe(CONTROL_FEATURE_NATIVE_PARITY);
    expect(RENDER_CONTROL_FEATURE_NATIVE_STAGE_TIMINGS).toBe(CONTROL_FEATURE_NATIVE_STAGE_TIMINGS);
    expect(RENDER_CONTROL_FEATURE_NATIVE_CAPTURE_CLOCK).toBe(CONTROL_FEATURE_NATIVE_CAPTURE_CLOCK);
    expect(RENDER_CONTROL_FEATURE_RENDER_SUBSTITUTIONS).toBe(CONTROL_FEATURE_RENDER_SUBSTITUTIONS);
    expect(RENDER_CONTROL_FEATURE_NATIVE_ENCODER).toBe(CONTROL_FEATURE_NATIVE_ENCODER);
    expect(RENDER_SUBSTITUTION_KINDS).toContain(CARLA_ACTOR_BODY_SUBSTITUTION);
  });

  it("declare a requirement for every feature a lease lists (a new feature must decide its required field)", () => {
    expect(Object.keys(RENDER_CONTROL_FEATURE_REQUIREMENTS).sort()).toEqual([...CONTROL_FEATURES_V1].sort());
  });
});

describe("CARLA runtime evidence", () => {
  it("accepts an exact scenario render on the pinned image", () => {
    expect(carlaRuntimeEvidencePolicyFailure(exactAttestation())).toBeNull();
    expect(carlaRuntimeEvidencePolicyFailure(exactAttestation({}, {
      map: { identityMode: "approved-cooked-digest", binding: "exact", exact: true },
    }))).toBeNull();
  });

  it.each([
    ["no attestation", null, {}, "carla_attestation_missing", /no worker attestation/],
    ["physics validation", { purpose: "physics-validation" }, {}, "carla_run_not_scenario_render", /physics-validation/],
    ["no runtime evidence", { runtimeEvidence: { available: false } }, {}, "carla_runtime_evidence_missing", /unverified/],
    ["generated world", {}, { map: { identityMode: "generated-opendrive", binding: "exact", exact: true, loadedMapName: "OpenDriveMap" } }, "carla_map_generated", /bare OpenDRIVE \(OpenDriveMap\)/],
    ["approximate map", {}, { map: { identityMode: "approximate", binding: "approximate", exact: false, loadedMapName: "yale_st" } }, "carla_map_not_exact", /binding approximate/],
    ["baked environment", {}, { environment: { exact: false, mode: "cooked-baked-default", reason: "custom-map-baked-default-daylight" } }, "carla_environment_not_exact", /cooked-baked-default/],
    ["no environment evidence", {}, { environment: undefined }, "carla_environment_not_exact", /no environment evidence/],
    ["unpinned image", {}, { runtimeImage: { exact: false, configuredManifestSha256: null } }, "carla_runtime_image_unverified", /SIMFORGE_CARLA_IMAGE_MANIFEST_SHA256/],
    ["incomplete identity", { workerIdentityComplete: false, workerImageDigest: "unavailable" }, {}, "carla_worker_identity_incomplete", /SIMFORGE_WORKER_IMAGE_DIGEST/],
  ])("refuses %s", (_label, overrides, runtime, code, message) => {
    const attestation = overrides === null ? null : exactAttestation(overrides as Record<string, unknown>, runtime as Record<string, unknown>);
    const failure = carlaRuntimeEvidencePolicyFailure(attestation);
    expect(failure?.code).toBe(code);
    expect(failure?.message).toMatch(message);
  });
});

describe("CARLA actor body substitutions", () => {
  const fallback = { actorId: "ped_child", authoredCatalogId: "walker.child", fallbackCatalogId: "walker.adult", vehicleClass: "pedestrian", lengthDeltaM: 0 };
  // As the CARLA executor records it (`substitution_record` in runtime/policy.py).
  const record = { kind: CARLA_ACTOR_BODY_SUBSTITUTION, subject: "ped_child", requested: "walker.child", rendered: "walker.adult", allowedBy: RENDER_SUBSTITUTION_GRANT_FIELD };
  const allowed = [CARLA_ACTOR_BODY_SUBSTITUTION];

  it("accepts a render with no substituted body, in the current and the rc.73 manifest shapes", () => {
    expect(carlaSubstitutionVerdict({ fallbacks: undefined, substitutions: [], allowSubstitutions: [], substitutionsNegotiated: true }))
      .toEqual({ substitutions: [] });
    expect(carlaSubstitutionVerdict({ fallbacks: [], substitutions: undefined, allowSubstitutions: [], substitutionsNegotiated: false }))
      .toEqual({ substitutions: [] });
  });

  it("refuses a manifest that does not say whether any body was substituted", () => {
    expect(carlaSubstitutionVerdict({ fallbacks: undefined, substitutions: undefined, allowSubstitutions: [], substitutionsNegotiated: true }).rejection?.code)
      .toBe("carla_evidence_field_missing");
    expect(carlaSubstitutionVerdict({ fallbacks: [{ actorId: "x" }], substitutions: undefined, allowSubstitutions: [], substitutionsNegotiated: true }).rejection?.code)
      .toBe("carla_evidence_field_invalid");
  });

  it("refuses a substituted body the intent did not allow, naming the actor and both bodies", () => {
    const recordedOnly = carlaSubstitutionVerdict({ fallbacks: undefined, substitutions: [record], allowSubstitutions: [], substitutionsNegotiated: true });
    expect(recordedOnly.rejection?.code).toBe("render_substitution_not_allowed");
    expect(recordedOnly.rejection?.message).toMatch(/ped_child carla-actor-body walker\.child -> walker\.adult/);
    const legacy = carlaSubstitutionVerdict({ fallbacks: [fallback], substitutions: undefined, allowSubstitutions: [], substitutionsNegotiated: true });
    expect(legacy.rejection?.code).toBe("carla_actor_body_substituted");
    expect(legacy.rejection?.message).toMatch(/ped_child: walker\.child -> walker\.adult/);
  });

  it("refuses a record that names a grant other than allowSubstitutions", () => {
    expect(carlaSubstitutionVerdict({ fallbacks: undefined, substitutions: [{ ...record, allowedBy: "worker-config" }], allowSubstitutions: allowed, substitutionsNegotiated: true }).rejection?.code)
      .toBe("render_substitution_not_allowed");
  });

  it("refuses an allowed substitution the manifest does not record, or a lease that could not record it", () => {
    expect(carlaSubstitutionVerdict({ fallbacks: [fallback], substitutions: [], allowSubstitutions: allowed, substitutionsNegotiated: true }).rejection?.code)
      .toBe("render_substitution_unrecorded");
    expect(carlaSubstitutionVerdict({ fallbacks: [fallback], substitutions: [{ ...record, rendered: "walker.other" }], allowSubstitutions: allowed, substitutionsNegotiated: true }).rejection?.code)
      .toBe("render_substitution_unrecorded");
    const legacy = carlaSubstitutionVerdict({ fallbacks: [fallback], substitutions: undefined, allowSubstitutions: allowed, substitutionsNegotiated: false });
    expect(legacy.rejection?.code).toBe("render_substitution_unrecorded");
    expect(legacy.rejection?.message).toMatch(/render-evidence\.substitutions/);
    expect(carlaSubstitutionVerdict({ fallbacks: undefined, substitutions: [record], allowSubstitutions: allowed, substitutionsNegotiated: false }).rejection?.code)
      .toBe("render_substitution_unrecorded");
  });

  it("accepts an allowed, recorded substitution and returns it for the job result", () => {
    for (const fallbacks of [undefined, [fallback]]) {
      const verdict = carlaSubstitutionVerdict({
        fallbacks, substitutions: [{ ...record, details: { reason: "this CARLA runtime cannot place walker.child" } }],
        allowSubstitutions: allowed, substitutionsNegotiated: true,
      });
      expect(verdict.rejection).toBeUndefined();
      expect(verdict.substitutions).toEqual([record]);
    }
  });

  it("refuses a malformed substitutions list", () => {
    expect(renderSubstitutionsVerdict([{ kind: "x" }], allowed).rejection?.code).toBe("render_substitutions_invalid");
    expect(renderSubstitutionsVerdict({}, []).rejection?.code).toBe("render_substitutions_invalid");
  });
});

describe("native negotiated evidence", () => {
  const parity = { pass: true, comparedPoses: 1200, maxPositionErrorM: 0.0002, maxHeadingErrorDeg: 0.01, presenceMismatches: 0 };
  function evidence(overrides: {
    manifest?: Record<string, unknown>;
    diagnostics?: Record<string, unknown>;
  } = {}) {
    return {
      manifest: { sceneSource: "render-timeline", timelineSha256: TIMELINE, capture: { clock: "simulation-time" }, encoder: { binary: "ffmpeg" }, ...overrides.manifest },
      diagnostics: {
        sceneSource: "render-timeline", timelineSha256: TIMELINE, parity,
        timings: { stages: { render: 1 } },
        ...overrides.diagnostics,
      },
    } as Parameters<typeof nativeEvidencePolicyFailure>[0];
  }

  it("accepts a timeline-sourced, graded render when every feature was negotiated", () => {
    expect(nativeEvidencePolicyFailure({ ...evidence(), features: ALL_FEATURES, timelineSha256: TIMELINE })).toBeNull();
  });

  it("accepts an older worker that was never asked for the newer fields", () => {
    const baseline = {
      manifest: {},
      diagnostics: { timings: {} },
    } as Parameters<typeof nativeEvidencePolicyFailure>[0];
    expect(nativeEvidencePolicyFailure({ ...baseline, features: new Set(), timelineSha256: TIMELINE })).toBeNull();
  });

  it.each([
    ["manifest sceneSource", { manifest: { sceneSource: undefined } }, "native_evidence_field_missing", /manifest has no sceneSource/],
    ["diagnostics sceneSource", { diagnostics: { sceneSource: undefined } }, "native_evidence_field_missing", /diagnostics has no sceneSource/],
    ["capture", { manifest: { capture: undefined } }, "native_evidence_field_missing", /capture-clock/],
    ["encoder", { manifest: { encoder: undefined } }, "native_evidence_field_missing", /native-evidence\.encoder/],
    ["stage timings", { diagnostics: { timings: {} } }, "native_evidence_field_missing", /timings\.stages/],
  ])("refuses a negotiated field that is missing (%s)", (_label, overrides, code, message) => {
    const failure = nativeEvidencePolicyFailure({ ...evidence(overrides), features: ALL_FEATURES, timelineSha256: TIMELINE });
    expect(failure?.code).toBe(code);
    expect(failure?.message).toMatch(message);
  });

  it("refuses a render re-lowered from the OpenSCENARIO export", () => {
    const legacy = evidence({ manifest: { sceneSource: "openscenario-legacy", timelineSha256: undefined }, diagnostics: { sceneSource: "openscenario-legacy", timelineSha256: undefined, parity: undefined } });
    expect(nativeEvidencePolicyFailure({ ...legacy, features: ALL_FEATURES, timelineSha256: TIMELINE })?.code).toBe("native_scene_source_legacy");
    expect(nativeEvidencePolicyFailure({ ...legacy, features: ALL_FEATURES, timelineSha256: null })?.code).toBe("native_scene_source_legacy");
  });

  it("accepts the legacy OpenSCENARIO replay only when the intent requested it", () => {
    const legacy = evidence({ manifest: { sceneSource: "openscenario-legacy", timelineSha256: undefined }, diagnostics: { sceneSource: "openscenario-legacy", timelineSha256: undefined, parity: undefined } });
    expect(nativeEvidencePolicyFailure({ ...legacy, features: ALL_FEATURES, timelineSha256: null, motionSource: "original-xosc" })).toBeNull();
    // Requested, but the run rendered from a timeline, or the intent also declares one.
    expect(nativeEvidencePolicyFailure({ ...evidence(), features: ALL_FEATURES, timelineSha256: null, motionSource: "original-xosc" })?.code).toBe("native_scene_source_mismatch");
    expect(nativeEvidencePolicyFailure({ ...legacy, features: ALL_FEATURES, timelineSha256: TIMELINE, motionSource: "original-xosc" })?.code).toBe("native_scene_source_mismatch");
  });

  it("refuses a render from a different timeline than the intent declared", () => {
    const other = evidence({ manifest: { timelineSha256: "d".repeat(64) }, diagnostics: { timelineSha256: "d".repeat(64) } });
    expect(nativeEvidencePolicyFailure({ ...other, features: ALL_FEATURES, timelineSha256: TIMELINE })?.code).toBe("native_scene_source_mismatch");
    expect(nativeEvidencePolicyFailure({ ...evidence({ diagnostics: { timelineSha256: "d".repeat(64) } }), features: ALL_FEATURES, timelineSha256: TIMELINE })?.code)
      .toBe("native_scene_source_mismatch");
  });

  it("refuses ungraded, empty or failed pose parity when a timeline is declared", () => {
    expect(nativeEvidencePolicyFailure({ ...evidence({ diagnostics: { parity: undefined } }), features: ALL_FEATURES, timelineSha256: TIMELINE })?.code)
      .toBe("native_parity_missing");
    expect(nativeEvidencePolicyFailure({ ...evidence({ diagnostics: { parity: { ...parity, comparedPoses: 0 } } }), features: ALL_FEATURES, timelineSha256: TIMELINE })?.code)
      .toBe("native_parity_ungraded");
    const failed = nativeEvidencePolicyFailure({ ...evidence({ diagnostics: { parity: { ...parity, pass: false, presenceMismatches: 2 } } }), features: ALL_FEATURES, timelineSha256: TIMELINE });
    expect(failed?.code).toBe("native_parity_failed");
    expect(failed?.message).toMatch(/2 presence mismatch/);
  });
});
