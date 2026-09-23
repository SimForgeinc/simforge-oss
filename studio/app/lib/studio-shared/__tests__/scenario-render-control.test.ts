import { describe, expect, it } from "vitest";
import {
  isScenarioParityEvidenceAccepted,
  isScenarioRenderEvidence,
  scenarioParityEvidencePolicyFailure,
  SCENARIO_REPLAY_PARITY_LIMITS,
  SCENARIO_NATIVE_PHYSICS_ACCEPTANCE_LIMITS,
  SCENARIO_REFERENCE_EQUIVALENCE_LIMITS,
  ScenarioParityEvidenceV1Schema,
  ScenarioRenderResourceRequestSchema,
  ScenarioRenderWorkerIdentitySchema,
} from "../scenario-render-control";

const digest = "a".repeat(64);

function acceptedEvidence() {
  return {
    schema: "uniscenario.parity-evidence/v1" as const,
    identity: {
      revisionId: "usrv_1",
      executionPackageId: "usep_1",
      executionPackageControlSha256: digest,
      sourceInputDigest: digest,
      planSha256: digest,
    },
    execution: { mode: "native-physics" as const, purpose: "physics-validation" as const, fixedTimestepS: 0.02 as const, mapBinding: "exact" },
    semantics: {
      verdict: "pass" as const,
      evaluatedInteractionCount: 3,
      unclassifiedDifferenceCount: 0,
      failedCheckIds: [],
    },
    trajectory: {
      verdict: "pass" as const,
      evaluatedActorCount: 2,
      failedActorIds: [],
      droppedActorIds: [],
      metrics: { maxPositionM: 0.12 },
    },
    collisions: { verdict: "pass" as const, evaluatedPairCount: 1, failedPairs: [] },
    artifacts: { verdict: "pass" as const, verifiedKinds: ["trace", "manifest"], missingKinds: [] },
    divergences: [{ code: "post_contact_tail", classification: "expected-carla-physics" as const }],
    verdict: "pass" as const,
  };
}

function replayEvidence() {
  return {
    ...acceptedEvidence(),
    execution: { mode: "trace-replay" as const, purpose: "scenario-render" as const, fixedTimestepS: 0.02 as const, mapBinding: "exact" as string | null },
    trajectory: {
      verdict: "pass" as const,
      acceptanceGate: "replay-sampler-parity" as const,
      evaluatedActorCount: 3,
      failedActorIds: [],
      droppedActorIds: [] as string[],
      nudgedActorIds: [] as string[],
      postContactClassification: "not-applicable" as const,
      metrics: { "max.positionM": 0.0004, "max.rotationDeg": 0.02 },
    },
    collisions: { verdict: "pass" as const, source: "timeline" as const, evaluatedPairCount: 0, failedPairs: [] },
    divergences: [{ code: "spawn-placement:staged:ped", classification: "informational" as const }] as Array<{ code: string; classification: string }>,
  };
}

describe("managed render control contracts", () => {
  it("parses a passing physics-validation run but never accepts it as the scenario render", () => {
    const parsed = ScenarioParityEvidenceV1Schema.parse(acceptedEvidence());
    expect(parsed.verdict).toBe("pass");
    expect(isScenarioParityEvidenceAccepted(parsed)).toBe(false);
    expect(scenarioParityEvidencePolicyFailure(parsed)?.code).toBe("carla_run_not_scenario_render");
  });

  it("requires purpose, mapBinding and droppedActorIds, and tolerates no missing key", () => {
    const evidence = acceptedEvidence();
    const { purpose: _purpose, ...withoutPurpose } = evidence.execution;
    expect(ScenarioParityEvidenceV1Schema.safeParse({ ...evidence, execution: withoutPurpose }).success).toBe(false);
    const { mapBinding: _binding, ...withoutBinding } = evidence.execution;
    expect(ScenarioParityEvidenceV1Schema.safeParse({ ...evidence, execution: withoutBinding }).success).toBe(false);
    const { droppedActorIds: _dropped, ...withoutDropped } = evidence.trajectory;
    expect(ScenarioParityEvidenceV1Schema.safeParse({ ...evidence, trajectory: withoutDropped }).success).toBe(false);
  });

  it("keeps reference equivalence distinct from the bounded native-physics ceiling", () => {
    expect(SCENARIO_REFERENCE_EQUIVALENCE_LIMITS).toEqual({
      positionM: 0.25,
      headingDeg: 2,
      speedMps: 0.25,
    });
    // Calibrated 2026-08-12: sample-wise 5°/1 mps gates are unattainable for native physics
    // tracking the kinematic browser-sim reference (sub-2 m turn radii swing heading ~41° in a
    // second at 2 m/s). Position stays strict; see scenario-render-control.ts for rationale.
    expect(SCENARIO_NATIVE_PHYSICS_ACCEPTANCE_LIMITS).toEqual({
      positionM: 2,
      headingDeg: 45,
      speedMps: 2,
    });
  });

  it("rejects a claimed pass with an unclassified semantic difference", () => {
    expect(() => ScenarioParityEvidenceV1Schema.parse({
      ...acceptedEvidence(),
      semantics: {
        ...acceptedEvidence().semantics,
        unclassifiedDifferenceCount: 1,
      },
    })).toThrow(/verdict/i);
  });

  it("keeps a truthful failed evidence document parseable for durable diagnosis", () => {
    const failed = ScenarioParityEvidenceV1Schema.parse({
      ...acceptedEvidence(),
      trajectory: {
        ...acceptedEvidence().trajectory,
        verdict: "fail",
        failedActorIds: ["ego"],
      },
      verdict: "fail",
    });
    expect(isScenarioParityEvidenceAccepted(failed)).toBe(false);
  });

  it("keeps diagnostic replay evidence transportable but never accepted", () => {
    const diagnostic = ScenarioParityEvidenceV1Schema.parse({
      ...acceptedEvidence(),
      execution: { mode: "diagnostic-replay", purpose: "scenario-render", fixedTimestepS: 0.02, mapBinding: "exact" },
      verdict: "fail",
    });
    expect(diagnostic.execution.mode).toBe("diagnostic-replay");
    expect(isScenarioParityEvidenceAccepted(diagnostic)).toBe(false);
    expect(() => ScenarioParityEvidenceV1Schema.parse({
      ...diagnostic,
      verdict: "pass",
    })).toThrow(/verdict/i);
  });

  it("accepts trace replay as the scenario render only inside the blocking replay limits", () => {
    const replay = {
      ...acceptedEvidence(),
      execution: { mode: "trace-replay" as const, purpose: "scenario-render" as const, fixedTimestepS: 0.02 as const, mapBinding: "exact" as const },
      trajectory: {
        verdict: "pass" as const,
        acceptanceGate: "replay-sampler-parity" as const,
        evaluatedActorCount: 3,
        failedActorIds: [],
        droppedActorIds: [],
        nudgedActorIds: [],
        postContactClassification: "not-applicable" as const,
        metrics: { "max.positionM": 0.0004, "max.rotationDeg": 0.02 },
      },
      collisions: { verdict: "pass" as const, source: "timeline" as const, evaluatedPairCount: 0, failedPairs: [] },
      divergences: [{ code: "spawn-placement:staged:ped", classification: "informational" as const }],
    };
    const parsed = ScenarioParityEvidenceV1Schema.parse(replay);
    expect(isScenarioParityEvidenceAccepted(parsed)).toBe(true);
    expect(isScenarioRenderEvidence(parsed)).toBe(true);
    expect(SCENARIO_REPLAY_PARITY_LIMITS).toEqual({ positionM: 0.01, rotationDeg: 0.1 });
    // A worker claiming pass outside the limits is not believed.
    expect(ScenarioParityEvidenceV1Schema.safeParse({
      ...replay,
      trajectory: { ...replay.trajectory, metrics: { "max.positionM": 0.02, "max.rotationDeg": 0.02 } },
    }).success).toBe(false);
    expect(ScenarioParityEvidenceV1Schema.safeParse({
      ...replay,
      trajectory: { ...replay.trajectory, metrics: {} },
    }).success).toBe(false);
  });

  it("never presents a physics-validation run as the scenario render", () => {
    const parsed = ScenarioParityEvidenceV1Schema.parse(acceptedEvidence());
    expect(isScenarioParityEvidenceAccepted(parsed)).toBe(false);
    expect(isScenarioRenderEvidence(parsed)).toBe(false);
    // Trace replay that claims a physics-validation purpose is not a render either.
    const mislabelled = ScenarioParityEvidenceV1Schema.parse({
      ...replayEvidence(),
      execution: { ...replayEvidence().execution, purpose: "physics-validation" },
    });
    expect(isScenarioRenderEvidence(mislabelled)).toBe(false);
    expect(scenarioParityEvidencePolicyFailure(mislabelled)?.code).toBe("carla_run_not_scenario_render");
  });

  it("refuses every recorded degradation in accepted-verdict replay evidence, naming it", () => {
    const cases: Array<[string, Record<string, unknown>, string, RegExp]> = [
      ["approximate map", { execution: { ...replayEvidence().execution, mapBinding: "approximate" } }, "carla_map_binding_not_exact", /approximate/],
      ["no map evidence", { execution: { ...replayEvidence().execution, mapBinding: null } }, "carla_map_binding_not_exact", /no map binding/],
      ["dropped actor", { trajectory: { ...replayEvidence().trajectory, droppedActorIds: ["ped_child"] } }, "carla_actors_dropped", /ped_child/],
      ["nudged actor", { trajectory: { ...replayEvidence().trajectory, nudgedActorIds: ["car_2"] } }, "carla_actors_nudged", /car_2/],
      ["approximate-map divergence", { divergences: [{ code: "map-binding:approximate", classification: "approximate-map" }] }, "carla_render_divergence", /map-binding:approximate/],
      ["spawn drop divergence", { divergences: [{ code: "spawn-placement:dropped-unplaceable:ped", classification: "spawn-placement-drop" }] }, "carla_render_divergence", /spawn-placement-drop/],
    ];
    for (const [label, override, code, message] of cases) {
      const parsed = ScenarioParityEvidenceV1Schema.parse({ ...replayEvidence(), ...override });
      const failure = scenarioParityEvidencePolicyFailure(parsed);
      expect(failure?.code, label).toBe(code);
      expect(failure?.message, label).toMatch(message);
      expect(isScenarioParityEvidenceAccepted(parsed), label).toBe(false);
    }
    // An informational note (a staged spawn) is not a degradation.
    const staged = ScenarioParityEvidenceV1Schema.parse(replayEvidence());
    expect(scenarioParityEvidencePolicyFailure(staged)).toBeNull();
    expect(isScenarioParityEvidenceAccepted(staged)).toBe(true);
  });

  it("carries an unknown map binding value to the policy instead of a schema error", () => {
    const parsed = ScenarioParityEvidenceV1Schema.parse({
      ...replayEvidence(),
      execution: { ...replayEvidence().execution, mapBinding: "generated" },
    });
    expect(scenarioParityEvidencePolicyFailure(parsed)?.code).toBe("carla_map_binding_not_exact");
  });

  it("keeps resource admission and worker identity provider neutral", () => {
    expect(ScenarioRenderResourceRequestSchema.parse({
      schema: "simforge.render-resource-request/v1",
      durationS: 10,
      sensors: 1,
      captureFrames: 300,
      actors: 256,
      actorFrameStates: 128_000,
      sensorPixels: 622_080_000,
      outputBytes: 2_147_483_648,
      maxCameraWidth: 1920,
      maxCameraHeight: 1080,
      pixelsPerFrame: 2_073_600,
    })).not.toHaveProperty("provider");
    expect(ScenarioRenderWorkerIdentitySchema.parse({
      workerVersion: "b".repeat(40),
      imageDigest: `sha256:${"c".repeat(64)}`,
      hardwareProfile: "rtx3080-10gb-v1",
    })).not.toHaveProperty("hostName");
    expect(ScenarioRenderWorkerIdentitySchema.parse({
      workerVersion: "b".repeat(40),
      imageDigest: `sha256:${"c".repeat(64)}`,
      hardwareProfile: "rtx5080-16gb-local-v1",
    }).hardwareProfile).toBe("rtx5080-16gb-local-v1");
    expect(ScenarioRenderWorkerIdentitySchema.safeParse({
      workerVersion: "b".repeat(40),
      imageDigest: `sha256:${"c".repeat(64)}`,
      hardwareProfile: "generic-local-gpu",
    }).success).toBe(false);
  });
});
