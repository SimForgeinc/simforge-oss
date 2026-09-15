/**
 * Launch a closed-loop comparison: pick N model configurations and a scenario
 * set, submit real runs, and link the results as comparison columns.
 *
 * This is the other half of the compare page. Comparing past runs answers "what
 * happened"; a comparison a person can START is what the request was actually
 * about, and it has one hard requirement: a column may only be offered when a
 * run of THAT KIND on THAT TARGET can actually execute.
 *
 * READINESS IS PER (KIND, TARGET), NOT PER FAMILY. "The family has an endpoint"
 * is not "closed loop works here":
 *
 * - A cloud worker that serves `alpamayo.openloop` does NOT thereby serve
 *   `alpamayo.closedloop-episode`; the closed loop needs the msgpack policy
 *   socket and a renderer in the same image. So the cloud target reads
 *   CloudCompute's capabilities and requires the SPECIFIC kind in that family's
 *   `kinds[]` and the requested quant in `quants[]`.
 * - The local target requires an enabled endpoint row for the model version in
 *   THIS workspace, which is what the desktop worker leases. A family installed
 *   but with no endpoint cannot run.
 *
 * A configuration that fails either check is returned as a REFUSED column with
 * the reason verbatim — never as a column that looks launchable, and never as a
 * placeholder column in the comparison. No fake columns: a comparison has as
 * many columns as it has submitted runs.
 */

import type { AppContext } from '../db/app-context';
import { listModelEndpoints, listModelVersions } from '../models/model-registry-store';
import { createModelRun } from '../models/model-run-store';
import { CreateModelRunSchema } from '../models/contracts';

/** What a person picked for one column. */
export type ComparisonColumnRequest = {
  readonly modelVersionId: string;
  /** `local` leases the desktop endpoint; `cloud` submits a compute job. */
  readonly target: 'local' | 'cloud';
  /** Rig preset the run renders with, e.g. `alpamayo-4cam`. */
  readonly rigProfile: string;
  readonly quant: string;
  /** Optional label for the column header; the model name is used otherwise. */
  readonly label?: string;
};

export type ComparisonLaunchRequest = {
  /** Campaign the columns are recorded under; the comparison reads it back. */
  readonly campaignId: string;
  readonly kind: 'closedloop-episode' | 'openloop';
  readonly columns: readonly ComparisonColumnRequest[];
  /** Episode spec each column runs, and the seeds; identical across columns. */
  readonly spec: string;
  readonly seeds: readonly number[];
  readonly steps: number;
  readonly decisionHz: number;
  readonly mode: 'offline-simtime' | 'realtime';
  /** Required by `realtime`, forbidden by `offline-simtime`; the runner enforces it. */
  readonly deadlineMs: number | null;
  /**
   * `dir:<path>` | `bevy:<rig.json>`. The endpoint policy has no default: camera
   * views are never synthesized, so a comparison with no frame source is
   * refused at submission rather than run against invented pixels.
   */
  readonly frameSource: string | null;
  /**
   * Cloud inputs, as ARTIFACT IDS by role — never paths.
   *
   * The compute params schema rejects anything path- or URL-shaped, because the
   * worker dereferences nothing from params: a file reaches it only as an
   * uploaded artifact bound to a role. So a local column runs from `spec` and
   * `frameSource` on this machine, while a cloud column runs from these, and a
   * cloud column requested without them is refused rather than submitted with a
   * path the worker could not read.
   *
   * Closed loop takes scenario / scene / replay-context / nav-raster (0..1
   * each); open loop takes 1..32 clip-bundle entries plus an optional
   * nav-raster, and its params carry `items[]` naming those roles.
   */
  readonly cloudInputs?: readonly { readonly role: string; readonly artifactId: string }[];
};

export type ComparisonColumnRefusal = {
  readonly modelVersionId: string;
  readonly target: 'local' | 'cloud';
  readonly code:
    | 'model_version_not_found'
    | 'no_local_endpoint'
    | 'weights_not_installed'
    | 'weights_unverified'
    | 'local_execution_ineligible'
    | 'kind_unsupported_on_target'
    | 'quant_unsupported_on_target'
    | 'compute_unavailable'
    | 'cloud_inputs_required'
    | 'no_frame_source'
    | 'submission_failed';
  /** Written to be shown to the person who picked the column. */
  readonly reason: string;
};

export type ComparisonColumnLaunched = {
  readonly modelVersionId: string;
  readonly target: 'local' | 'cloud';
  readonly label: string;
  /** Desktop run ids or cloud job ids, one per seed, in seed order. */
  readonly runIds: readonly string[];
  /** Identity persisted with the column so the comparison reads facts, not the request. */
  readonly identity: {
    readonly family: string;
    readonly revision: string | null;
    readonly quant: string;
    readonly checkpointDigest: string | null;
    readonly rigProfile: string;
  };
};

export type ComparisonLaunchResult = {
  readonly campaignId: string;
  readonly kind: ComparisonLaunchRequest['kind'];
  readonly launched: readonly ComparisonColumnLaunched[];
  readonly refused: readonly ComparisonColumnRefusal[];
};

/** CloudCompute's `/api/simforge/compute/capabilities`, as this module reads it. */
export type ComputeCapabilities = {
  readonly enabled: boolean;
  readonly reason?: string | null;
  readonly families?: readonly {
    readonly family: string;
    readonly available: boolean;
    readonly unavailableReason?: string | null;
    /**
     * Job kinds this deployment's service actually runs for the family.
     *
     * ABSENT IS NOT PERMISSIVE: an unreported capability is refused, not
     * offered. Matches ProductSurface's picker rule so the two gates cannot
     * disagree about one deployment.
     */
    readonly kinds?: readonly string[];
    readonly quants?: readonly string[];
    readonly pinnedRevision?: string | null;
  }[];
};

/**
 * Read compute capabilities, treating every unreachable shape as unavailable.
 *
 * Route-absent, non-200 and non-JSON all mean "no cloud target here" — the
 * surface is deliberately absent in some deployments, and a page that threw
 * would fail exactly where the notice matters most.
 *
 * The read is INJECTED because the capabilities route lives on SimCloud's
 * origin, never on this host: `/api/simforge/compute/**` has no handler in
 * this app, so asking this host's own origin for it could only ever 404.
 * The caller supplies the authenticated cloud transport.
 */
export async function readComputeCapabilities(
  read: () => Promise<Response>,
): Promise<{ ok: true; capabilities: ComputeCapabilities } | { ok: false; reason: string }> {
  try {
    const response = await read();
    if (!response.ok) {
      return { ok: false, reason: `compute capabilities unavailable (HTTP ${String(response.status)})` };
    }
    const text = await response.text();
    try {
      return { ok: true, capabilities: JSON.parse(text) as ComputeCapabilities };
    } catch {
      return { ok: false, reason: 'compute capabilities did not return JSON (no service in this deployment)' };
    }
  } catch (error) {
    return {
      ok: false,
      reason: `compute capabilities unreachable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** The compute job kind a comparison kind submits. */
const JOB_KIND: Record<ComparisonLaunchRequest['kind'], string> = {
  'closedloop-episode': 'alpamayo.closedloop-episode',
  openloop: 'alpamayo.openloop',
};

/** The desktop run kind a comparison kind submits. */
const RUN_KIND: Record<ComparisonLaunchRequest['kind'], string> = {
  'closedloop-episode': 'policy_episode',
  openloop: 'openloop',
};

/**
 * The desktop model store's own verdicts, injected rather than imported.
 *
 * `@simforge-oss/model-store` reads the local disk and probes the GPU, so it is
 * passed in: the route calls it, and tests exercise every verdict without a
 * card. There is no second implementation of the predicate here — this module
 * only decides what a verdict MEANS for a launch.
 */
export type LocalReadiness = {
  /** `installState(family)` from the model store. */
  readonly install: { readonly state: string; readonly digestVerifiedAt?: string | null };
  /**
   * `qualify()`/`preflight()` for this family+quant. Closed loop MUST be asked
   * with `reserveRenderer: true`: whether the model fits alone is a different
   * question from whether it fits with the native renderer resident on the same
   * device, and only the second one answers a closed-loop launch.
   */
  readonly eligibility: {
    readonly executionEligible: boolean;
    readonly qualification: string;
    readonly reasons: readonly string[];
  } | null;
};

export type LaunchDependencies = {
  /** Submits a cloud job; returns its id. Injected so the route owns transport. */
  readonly submitComputeJob?: (body: unknown) => Promise<string>;
  readonly capabilities?: ComputeCapabilities | null;
  readonly capabilitiesReason?: string | null;
  /**
   * Per-family local readiness from the model store, asked for the KIND being
   * launched (closed loop with the renderer reserved). Absent means the caller
   * could not consult the store — which is refused, not assumed ready.
   */
  readonly localReadiness?: Readonly<Record<string, LocalReadiness | undefined>>;
};

/**
 * Launch the requested columns, refusing the ones that cannot execute.
 *
 * Submits through the EXISTING job paths — `createModelRun` for the desktop
 * lease, the compute jobs API for cloud — rather than a comparison-specific
 * executor, so a comparison run is the same artifact as any other run and the
 * compare page reads it the same way.
 */
export async function launchComparison(
  context: AppContext,
  request: ComparisonLaunchRequest,
  deps: LaunchDependencies = {},
): Promise<ComparisonLaunchResult> {
  const launched: ComparisonColumnLaunched[] = [];
  const refused: ComparisonColumnRefusal[] = [];
  const versions = await listModelVersions(context);
  const endpoints = await listModelEndpoints(context);
  for (const column of request.columns) {
    const version = versions.find((candidate) => candidate.id === column.modelVersionId);
    if (!version) {
      refused.push({
        modelVersionId: column.modelVersionId,
        target: column.target,
        code: 'model_version_not_found',
        reason: 'That model version is not in this workspace registry.',
      });
      continue;
    }

    if (column.target === 'local') {
      // A local run reads frames from this machine, and without a source there
      // is nothing to read: the alternative is fabricated observations, so the
      // column is refused instead of submitted. Cloud columns are unaffected —
      // they read uploaded artifacts, which is a different question.
      if (!request.frameSource) {
        refused.push({
          modelVersionId: column.modelVersionId,
          target: 'local',
          code: 'no_frame_source',
          reason:
            'A local run needs a real frame source (`dir:<path>` or `bevy:<rig.json>`); camera views are never synthesized.',
        });
        continue;
      }
      // AN ENABLED ENDPOINT ROW IS NOT READINESS. `createModelRun` checks only
      // that the row exists, is enabled and belongs to this workspace (see
      // model-run-store.ts: SELECT id FROM simforge.model_endpoints WHERE id
      // = :id AND workspace_id = :workspace_id AND model_version_id =
      // :model_version_id AND enabled). The row can outlive the weights, name a
      // half-verified install, or point at a device that cannot hold the model
      // with the renderer resident. The worker discovers that at lease time,
      // after a person has been told the run started.
      //
      // So the store's own verdicts decide what may be OFFERED, and the lease
      // remains the authority on what may execute. No duplicate predicate: the
      // install state and eligibility below are computed by
      // '@simforge-oss/model-store' and passed in.
      const readiness = deps.localReadiness?.[version.family];
      if (!readiness) {
        refused.push({
          modelVersionId: column.modelVersionId,
          target: 'local',
          code: 'local_execution_ineligible',
          reason:
            'Local readiness for this model was not reported: the desktop model store could not be consulted, and unknown is not ready.',
        });
        continue;
      }
      if (readiness.install.state !== 'installed') {
        refused.push({
          modelVersionId: column.modelVersionId,
          target: 'local',
          code: 'weights_not_installed',
          reason: `The weights for ${version.family} are ${readiness.install.state.replace('_', ' ')} on this machine. Install them before a local column can run.`,
        });
        continue;
      }
      if (!readiness.install.digestVerifiedAt) {
        // Present but unverified: the bytes on disk have not been proven to be
        // the checkpoint the column would claim to have run.
        refused.push({
          modelVersionId: column.modelVersionId,
          target: 'local',
          code: 'weights_unverified',
          reason: `The ${version.family} install has not been digest-verified, so a run could not honestly claim which checkpoint it used. Verify the install first.`,
        });
        continue;
      }
      if (!readiness.eligibility || !readiness.eligibility.executionEligible) {
        refused.push({
          modelVersionId: column.modelVersionId,
          target: 'local',
          code: 'local_execution_ineligible',
          // The store's own words, kept rather than summarised: they name the
          // device, the VRAM and the renderer headroom this kind needs.
          reason:
            readiness.eligibility?.reasons.join(' ') ??
            `This machine has no execution verdict for ${version.family}.`,
        });
        continue;
      }
      const endpoint = endpoints.find(
        (candidate) => candidate.modelVersionId === column.modelVersionId && candidate.enabled,
      );
      if (!endpoint) {
        refused.push({
          modelVersionId: column.modelVersionId,
          target: 'local',
          code: 'no_local_endpoint',
          reason:
            'No enabled local endpoint for this model version. Install it and register an endpoint before a local run can be leased.',
        });
        continue;
      }
      const runIds: string[] = [];
      let failure: string | null = null;
      for (const seed of request.seeds) {
        const created = await createModelRun(
          context,
          CreateModelRunSchema.parse({
            modelVersionId: column.modelVersionId,
            endpointId: endpoint.id,
            kind: RUN_KIND[request.kind],
            seed,
            params: {
              spec: request.spec,
              steps: request.steps,
              seed,
              policySeed: seed,
              decisionHz: request.decisionHz,
              mode: request.mode,
              deadlineMs: request.deadlineMs,
              runnerPolicy: 'endpoint',
              frameSource: request.frameSource,
              cameraProfile: column.rigProfile,
            },
          }),
        );
        if (created.kind !== 'created') {
          failure = 'The endpoint disappeared between the readiness check and submission.';
          break;
        }
        runIds.push(created.run.id);
      }
      if (failure !== null) {
        refused.push({
          modelVersionId: column.modelVersionId,
          target: 'local',
          code: 'submission_failed',
          // Partially submitted runs are NOT discarded: they exist and will be
          // leased, so the reason says so rather than implying nothing ran.
          reason: `${failure}${runIds.length > 0 ? ` ${String(runIds.length)} run(s) were already queued and will still execute.` : ''}`,
        });
        continue;
      }
      launched.push({
        modelVersionId: column.modelVersionId,
        target: 'local',
        label: column.label ?? `${version.family} ${column.quant} (local)`,
        runIds,
        identity: {
          family: version.family,
          revision: null,
          quant: column.quant,
          checkpointDigest: version.checkpointDigest,
          rigProfile: column.rigProfile,
        },
      });
      continue;
    }

    // Cloud: readiness is per kind AND per quant, from the control plane.
    const capabilities = deps.capabilities ?? null;
    if (!capabilities || !capabilities.enabled) {
      refused.push({
        modelVersionId: column.modelVersionId,
        target: 'cloud',
        code: 'compute_unavailable',
        reason:
          deps.capabilitiesReason ??
          capabilities?.reason ??
          'No compute service is deployed in this environment.',
      });
      continue;
    }
    const family = capabilities.families?.find((entry) => entry.family === version.family);
    if (!family || !family.available) {
      refused.push({
        modelVersionId: column.modelVersionId,
        target: 'cloud',
        code: 'compute_unavailable',
        reason: family?.unavailableReason ?? `No compute service is deployed for ${version.family}.`,
      });
      continue;
    }
    const jobKind = JOB_KIND[request.kind];
    // UNKNOWN IS NOT READY. A deployment that has not reported its kinds for
    // this family has not said it can run anything, and treating silence as
    // permission is how a person is offered a closed-loop cloud target that
    // does not exist. Reported-and-excluded and never-reported are refused for
    // different stated reasons, so a reader can tell which it is.
    if (family.kinds === undefined) {
      refused.push({
        modelVersionId: column.modelVersionId,
        target: 'cloud',
        code: 'kind_unsupported_on_target',
        reason: `Required execution capability not reported for ${version.family}: this deployment has not said which job kinds its service runs.`,
      });
      continue;
    }
    if (family.kinds.length === 0) {
      refused.push({
        modelVersionId: column.modelVersionId,
        target: 'cloud',
        code: 'kind_unsupported_on_target',
        reason: `No cloud service in this deployment runs ${version.family}.`,
      });
      continue;
    }
    if (!family.kinds.includes(jobKind)) {
      refused.push({
        modelVersionId: column.modelVersionId,
        target: 'cloud',
        code: 'kind_unsupported_on_target',
        reason: `The deployed ${version.family} service runs ${family.kinds.join(', ')}, not ${jobKind}. A worker that serves open-loop inference does not thereby serve the closed loop, which needs the policy socket and a renderer in the same image.`,
      });
      continue;
    }
    if (!(family.quants ?? []).includes(column.quant)) {
      refused.push({
        modelVersionId: column.modelVersionId,
        target: 'cloud',
        code: 'quant_unsupported_on_target',
        reason: `The deployed ${version.family} service does not serve ${column.quant}; it serves ${(family.quants ?? []).join(', ') || 'no quantization'}.`,
      });
      continue;
    }
    const submit = deps.submitComputeJob;
    if (!submit) {
      refused.push({
        modelVersionId: column.modelVersionId,
        target: 'cloud',
        code: 'compute_unavailable',
        reason: 'No compute submission transport is configured for this request.',
      });
      continue;
    }
    // Inputs must be artifact ids bound to roles. Closed loop needs at least
    // one world to drive (scenario, scene or replay-context); open loop needs
    // at least one clip bundle. Refuse here rather than let the control plane
    // reject a job we could tell was unsubmittable.
    const cloudInputs = request.cloudInputs ?? [];
    const roles = new Set(cloudInputs.map((entry) => entry.role));
    const clipBundles = cloudInputs.filter((entry) => entry.role.startsWith('clip-bundle'));
    const missingInputs =
      request.kind === 'openloop'
        ? clipBundles.length === 0
          ? 'at least one uploaded clip bundle'
          : null
        : roles.has('scenario') || roles.has('scene') || roles.has('replay-context')
          ? null
          : 'an uploaded scenario, scene or replay-context bundle';
    if (missingInputs !== null) {
      refused.push({
        modelVersionId: column.modelVersionId,
        target: 'cloud',
        code: 'cloud_inputs_required',
        reason: `A cloud run needs ${missingInputs}. Cloud workers read uploaded artifacts, never a path on this machine.`,
      });
      continue;
    }

    const runIds: string[] = [];
    let submissionError: string | null = null;
    for (const seed of request.seeds) {
      try {
        runIds.push(
          await submit({
            kind: jobKind,
            // One idempotency key per (campaign, column, seed): a retried
            // submission joins the existing job instead of creating a rival.
            idempotencyKey: `${request.campaignId}:${column.modelVersionId}:${String(seed)}`,
            // `model` and `inputs` live INSIDE `input`; everything else is
            // `params`, and params carry no path or URL because the worker
            // dereferences nothing from them.
            input: {
              model: {
                family: version.family,
                revision: family.pinnedRevision ?? null,
                quant: column.quant,
              },
              inputs: cloudInputs.map((entry) => ({ role: entry.role, artifactId: entry.artifactId })),
              params: {
                seed,
                steps: request.steps,
                decisionHz: request.decisionHz,
                mode: request.mode,
                deadlineMs: request.deadlineMs,
                cameraProfile: column.rigProfile,
                campaignId: request.campaignId,
                // Open loop binds each item to one of the submitted roles; the
                // control plane validates the binding, so an unbound item is
                // refused before a cold start rather than after it.
                ...(request.kind === 'openloop'
                  ? { items: clipBundles.map((entry) => ({ role: entry.role })) }
                  : {}),
              },
            },
          }),
        );
      } catch (error) {
        submissionError = error instanceof Error ? error.message : String(error);
        break;
      }
    }
    if (submissionError !== null) {
      refused.push({
        modelVersionId: column.modelVersionId,
        target: 'cloud',
        code: 'submission_failed',
        reason: `${submissionError}${runIds.length > 0 ? ` ${String(runIds.length)} job(s) were already accepted and will still execute.` : ''}`,
      });
      continue;
    }
    launched.push({
      modelVersionId: column.modelVersionId,
      target: 'cloud',
      label: column.label ?? `${version.family} ${column.quant} (cloud)`,
      runIds,
      // The control plane runs its pinned revision, so the column records THAT
      // rather than whatever the request hoped for.
      identity: {
        family: version.family,
        revision: family.pinnedRevision ?? null,
        quant: column.quant,
        checkpointDigest: version.checkpointDigest,
        rigProfile: column.rigProfile,
      },
    });
  }

  return { campaignId: request.campaignId, kind: request.kind, launched, refused };
}
