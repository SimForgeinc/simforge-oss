import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const ImageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const SCENARIO_RENDER_RESOURCE_REQUEST_VERSION =
  "simforge.render-resource-request/v1" as const;

/**
 * Provider-neutral admission envelope derived by the control plane from the
 * immutable scenario revision and render specification. It deliberately does
 * not contain a host, GPU slot, rental identifier, or cloud-provider name.
 */
export const ScenarioRenderResourceRequestSchema = z.strictObject({
  schema: z.literal(SCENARIO_RENDER_RESOURCE_REQUEST_VERSION),
  durationS: z.number().finite().positive().max(300),
  sensors: z.number().int().nonnegative().max(64),
  captureFrames: z.number().int().nonnegative(),
  actors: z.number().int().positive(),
  actorFrameStates: z.number().int().positive(),
  sensorPixels: z.number().int().nonnegative(),
  outputBytes: z.number().int().positive(),
  maxCameraWidth: z.number().int().nonnegative(),
  maxCameraHeight: z.number().int().nonnegative(),
  pixelsPerFrame: z.number().int().nonnegative(),
});
export type ScenarioRenderResourceRequest = z.infer<
  typeof ScenarioRenderResourceRequestSchema
>;

// historical name retained for stored-data compat: the CARLA worker emits this
// tag and `simforge.render_evidence_accepted` pins it, so it is not renamed.
export const SCENARIO_PARITY_EVIDENCE_VERSION =
  "uniscenario.parity-evidence/v1" as const;

/**
 * CARLA execution modes. `trace-replay` is the default and the only mode whose
 * output is the scenario's render: every actor is kinematic and posed from the
 * shared timeline sampler. `native-physics` is the opt-in physics-validation
 * mode; it is never presented as the scenario render. `diagnostic-replay` is
 * the historical name of trace replay.
 */
export const SCENARIO_CARLA_EXECUTION_MODES = ["trace-replay", "native-physics", "diagnostic-replay"] as const;
export type ScenarioCarlaExecutionMode = (typeof SCENARIO_CARLA_EXECUTION_MODES)[number];

/** Blocking replay parity: observed CARLA transforms against the sampler. */
export const SCENARIO_REPLAY_PARITY_LIMITS = {
  positionM: 0.01,
  rotationDeg: 0.1,
} as const;

/**
 * Hard acceptance ceiling for CARLA-owned vehicle motion. The tighter
 * 0.25 m / 2 degree / 0.25 mps reference band remains part of worker evidence;
 * these values only classify bounded native-physics lag instead of forcing
 * actors onto authored poses.
 *
 * Position is the load-bearing guarantee and stays at 2 m over every sample.
 * Heading and speed must tolerate turn and stop transients: the authoring
 * sim's kinematic reference can swing tens of degrees within a half second at
 * walking speeds (an unreachable sub-2 m turning radius for any real vehicle),
 * so a physical vehicle that holds the 2 m position band still lags the
 * reference heading through sharp turns and carries speed into stops a little
 * longer. 45 degrees / 2 mps bounds those transients without letting an actor
 * leave its path.
 */
export const SCENARIO_NATIVE_PHYSICS_ACCEPTANCE_LIMITS = {
  positionM: 2,
  headingDeg: 45,
  speedMps: 2,
} as const;

export const SCENARIO_REFERENCE_EQUIVALENCE_LIMITS = {
  positionM: 0.25,
  headingDeg: 2,
  speedMps: 0.25,
} as const;

const ComparisonVerdictSchema = z.enum(["pass", "fail"]);

export const ScenarioParityEvidenceV1Schema = z
  .strictObject({
    schema: z.literal(SCENARIO_PARITY_EVIDENCE_VERSION),
    identity: z.strictObject({
      revisionId: z.string().trim().min(1),
      executionPackageId: z.string().trim().min(1),
      executionPackageControlSha256: Sha256Schema,
      sourceInputDigest: Sha256Schema,
      planSha256: Sha256Schema,
    }),
    execution: z.strictObject({
      mode: z.enum(SCENARIO_CARLA_EXECUTION_MODES),
      // Required: a run that does not say what it was for is never accepted as
      // the scenario's render (docs/engineering/no-silent-fallbacks.md).
      purpose: z.enum(["scenario-render", "physics-validation"]),
      fixedTimestepS: z.literal(0.02),
      // How the CARLA world is bound to the package XODR. Required; null means
      // the worker had no runtime map evidence. Any value but `exact` (for
      // example `approximate`, or a generated bare-OpenDRIVE world) is
      // rejected by `scenarioParityEvidencePolicyFailure`, so an unknown value
      // is carried to that check instead of failing as a schema error.
      mapBinding: z.string().trim().min(1).max(64).nullable(),
    }),
    semantics: z.strictObject({
      verdict: ComparisonVerdictSchema,
      evaluatedInteractionCount: z.number().int().nonnegative(),
      unclassifiedDifferenceCount: z.number().int().nonnegative(),
      failedCheckIds: z.array(z.string().trim().min(1)).max(10_000),
    }),
    trajectory: z.strictObject({
      verdict: ComparisonVerdictSchema,
      acceptanceGate: z.enum(["full-trajectory", "through-first-contact", "replay-sampler-parity"]).optional(),
      evaluatedActorCount: z.number().int().nonnegative(),
      failedActorIds: z.array(z.string().trim().min(1)).max(10_000),
      // Grounded-spawn placement evidence from the CARLA worker: actors the
      // runtime dropped (unplaceable) or nudged onto valid ground before
      // execution. `droppedActorIds` is required so a missing list can never
      // read as "nothing dropped"; a non-empty list of either is rejected.
      droppedActorIds: z.array(z.string().trim().min(1)).max(10_000),
      nudgedActorIds: z.array(z.string().trim().min(1)).max(10_000).optional(),
      postContactFailedActorIds: z.array(z.string().trim().min(1)).max(10_000).optional(),
      postContactClassification: z.enum(["blocking", "expected-carla-physics", "not-applicable"]).optional(),
      metrics: z.record(z.string(), z.number().finite().nonnegative()),
    }),
    collisions: z.strictObject({
      verdict: ComparisonVerdictSchema,
      // Trace replay simulates nothing: contacts are the trace's own events.
      source: z.literal("timeline").optional(),
      evaluatedPairCount: z.number().int().nonnegative(),
      failedPairs: z.array(z.tuple([z.string().trim().min(1), z.string().trim().min(1)])).max(10_000),
    }),
    artifacts: z.strictObject({
      verdict: ComparisonVerdictSchema,
      verifiedKinds: z.array(z.string().trim().min(1)).min(1).max(100),
      missingKinds: z.array(z.string().trim().min(1)).max(100),
    }),
    divergences: z
      .array(
        z.strictObject({
          code: z.string().trim().min(1).max(200),
          classification: z.enum([
            "expected-carla-physics",
            "unclassified",
            "spawn-placement-drop",
            "spawn-placement-nudge",
            "approximate-map",
            "informational",
          ]),
          actorId: z.string().trim().min(1).max(200).optional(),
          details: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .max(10_000),
    verdict: ComparisonVerdictSchema,
  })
  .superRefine((evidence, context) => {
    const hasUnclassifiedDivergence = evidence.divergences.some(
      (item) => item.classification === "unclassified",
    );
    // Trace replay is accepted only inside the replay parity limits, whatever
    // the worker claims; the historical `diagnostic-replay` tag predates the
    // blocking gate and is never accepted.
    const replayWithinLimits =
      evidence.execution.mode !== "trace-replay" || (
        evidence.trajectory.acceptanceGate === "replay-sampler-parity" &&
        (evidence.trajectory.metrics["max.positionM"] ?? Infinity) <= SCENARIO_REPLAY_PARITY_LIMITS.positionM &&
        (evidence.trajectory.metrics["max.rotationDeg"] ?? Infinity) <= SCENARIO_REPLAY_PARITY_LIMITS.rotationDeg
      );
    const accepted =
      evidence.execution.mode !== "diagnostic-replay" &&
      replayWithinLimits &&
      evidence.semantics.verdict === "pass" &&
      evidence.semantics.unclassifiedDifferenceCount === 0 &&
      evidence.semantics.failedCheckIds.length === 0 &&
      evidence.trajectory.verdict === "pass" &&
      evidence.trajectory.failedActorIds.length === 0 &&
      evidence.collisions.verdict === "pass" &&
      evidence.collisions.failedPairs.length === 0 &&
      evidence.artifacts.verdict === "pass" &&
      evidence.artifacts.missingKinds.length === 0 &&
      !hasUnclassifiedDivergence;
    if ((evidence.verdict === "pass") !== accepted) {
      context.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "The parity verdict must be derived from every required comparison.",
      });
    }
  });

export type ScenarioParityEvidenceV1 = z.infer<
  typeof ScenarioParityEvidenceV1Schema
>;

/**
 * A render the control plane refuses to accept, with a machine code that
 * names the degradation (`carla_*`, `native_*` or `render_*`, reported to the
 * job as `render.<code>`) and a message that names the actor, field or value
 * involved. See docs/engineering/no-silent-fallbacks.md.
 */
export type RenderEvidenceRejection = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

/**
 * Whether a CARLA run is the scenario's render: kinematic trace replay whose
 * declared purpose is the scenario render. A physics-validation run (CARLA
 * physics drives the vehicles) is never presented as the render of the
 * scenario; it would have to be an explicitly requested job type of its own,
 * and no such job type exists.
 */
export function isScenarioRenderEvidence(evidence: ScenarioParityEvidenceV1): boolean {
  return evidence.execution.mode === "trace-replay" && evidence.execution.purpose === "scenario-render";
}

/** Divergence classes that record a degraded render; only `informational` notes are acceptable. */
const BLOCKING_DIVERGENCE_CLASSIFICATIONS = new Set([
  "expected-carla-physics",
  "unclassified",
  "spawn-placement-drop",
  "spawn-placement-nudge",
  "approximate-map",
]);

function listed(values: readonly string[], limit = 20): string {
  const head = values.slice(0, limit).join(", ");
  return values.length > limit ? `${head} (+${values.length - limit} more)` : head;
}

/**
 * The degradations recorded in CARLA parity evidence that must never become
 * a succeeded render, whatever the worker's own verdict says. Mirrored by
 * `simforge.render_evidence_accepted` in SimCloud (migration
 * 20260922200000_render_evidence_no_silent_degradation.sql).
 */
export function scenarioParityEvidencePolicyFailure(
  evidence: ScenarioParityEvidenceV1,
): RenderEvidenceRejection | null {
  const { execution, trajectory } = evidence;
  if (!isScenarioRenderEvidence(evidence)) {
    return {
      code: "carla_run_not_scenario_render",
      message: `CARLA ran in ${execution.mode} mode with purpose ${execution.purpose}; only trace replay with purpose scenario-render is accepted as the scenario's render (a physics-validation or diagnostic run is never accepted as a render)`,
      details: { mode: execution.mode, purpose: execution.purpose },
    };
  }
  if (execution.mapBinding !== "exact") {
    return {
      code: "carla_map_binding_not_exact",
      message: execution.mapBinding === null
        ? "CARLA parity evidence has no map binding: the worker recorded no runtime map evidence, so the rendered world is not known to be the package XODR"
        : `CARLA rendered a world whose binding to the package XODR is ${execution.mapBinding}, not exact`,
      details: { mapBinding: execution.mapBinding },
    };
  }
  if (trajectory.droppedActorIds.length > 0) {
    return {
      code: "carla_actors_dropped",
      message: `CARLA dropped ${trajectory.droppedActorIds.length} actor(s) it could not spawn, so they are missing from the render: ${listed(trajectory.droppedActorIds)}`,
      details: { droppedActorIds: trajectory.droppedActorIds },
    };
  }
  const nudged = trajectory.nudgedActorIds ?? [];
  if (nudged.length > 0) {
    return {
      code: "carla_actors_nudged",
      message: `CARLA moved ${nudged.length} actor(s) away from their authored spawn pose: ${listed(nudged)}`,
      details: { nudgedActorIds: nudged },
    };
  }
  const blocking = evidence.divergences.filter((item) => BLOCKING_DIVERGENCE_CLASSIFICATIONS.has(item.classification));
  if (blocking.length > 0) {
    return {
      code: "carla_render_divergence",
      message: `CARLA evidence records ${blocking.length} divergence(s) from the scenario: ${listed(blocking.map((item) => `${item.code} (${item.classification})`))}`,
      details: { divergences: blocking.slice(0, 50) },
    };
  }
  return null;
}

/**
 * Whether CARLA evidence is an accepted scenario render: the worker's verdict
 * (itself re-derived by the schema) passes and no recorded degradation is
 * present (`scenarioParityEvidencePolicyFailure`).
 */
export function isScenarioParityEvidenceAccepted(
  evidence: ScenarioParityEvidenceV1,
): boolean {
  return evidence.execution.mode !== "diagnostic-replay"
    && evidence.verdict === "pass"
    && scenarioParityEvidencePolicyFailure(evidence) === null;
}

export const SIMFORGE_RTX3080_HARDWARE_PROFILE = "rtx3080-10gb-v1" as const;
export const SIMFORGE_LOCAL_RTX5080_HARDWARE_PROFILE =
  "rtx5080-16gb-local-v1" as const;
/** Rented 24 GiB cloud card; the fleet's only non-workstation profile. */
export const SIMFORGE_RTX3090_HARDWARE_PROFILE = "rtx3090-24gb-v1" as const;

export const ScenarioRenderHardwareProfileSchema = z.enum([
  SIMFORGE_RTX3080_HARDWARE_PROFILE,
  SIMFORGE_LOCAL_RTX5080_HARDWARE_PROFILE,
  SIMFORGE_RTX3090_HARDWARE_PROFILE,
]);
export type ScenarioRenderHardwareProfile = z.infer<
  typeof ScenarioRenderHardwareProfileSchema
>;

/** Exact runtime identity submitted at registration and completion. */
export const ScenarioRenderWorkerIdentitySchema = z.strictObject({
  workerVersion: z.string().regex(/^[a-f0-9]{40}$/),
  imageDigest: ImageDigestSchema,
  hardwareProfile: ScenarioRenderHardwareProfileSchema,
});
export type ScenarioRenderWorkerIdentity = z.infer<
  typeof ScenarioRenderWorkerIdentitySchema
>;

const scenarioRenderControl = {
  SCENARIO_NATIVE_PHYSICS_ACCEPTANCE_LIMITS,
  SCENARIO_REFERENCE_EQUIVALENCE_LIMITS,
} as const;

export default scenarioRenderControl;
