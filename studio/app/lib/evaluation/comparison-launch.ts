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
};

export type ComparisonColumnRefusal = {
  readonly modelVersionId: string;
  readonly target: 'local' | 'cloud';
  readonly code:
    | 'model_version_not_found'
    | 'no_local_endpoint'
    | 'kind_unsupported_on_target'
    | 'quant_unsupported_on_target'
    | 'compute_unavailable'
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
 */
export async function readComputeCapabilities(
  fetchImpl: typeof fetch,
  baseUrl: string,
): Promise<{ ok: true; capabilities: ComputeCapabilities } | { ok: false; reason: string }> {
  try {
    const response = await fetchImpl(`${baseUrl}/api/simforge/compute/capabilities`, {
      headers: { accept: 'application/json' },
    });
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

export type LaunchDependencies = {
  /** Submits a cloud job; returns its id. Injected so the route owns transport. */
  readonly submitComputeJob?: (body: unknown) => Promise<string>;
  readonly capabilities?: ComputeCapabilities | null;
  readonly capabilitiesReason?: string | null;
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
  // One refusal that applies to every column: without a frame source the
  // endpoint policy cannot run at all, and the alternative is fabricated
  // observations. Refuse the columns rather than submit runs that will fail.
  if (!request.frameSource) {
    return {
      campaignId: request.campaignId,
      kind: request.kind,
      launched: [],
      refused: request.columns.map((column) => ({
        modelVersionId: column.modelVersionId,
        target: column.target,
        code: 'no_frame_source' as const,
        reason:
          'A model comparison needs a real frame source (`dir:<path>` or `bevy:<rig.json>`); camera views are never synthesized.',
      })),
    };
  }
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
    if (!(family.kinds ?? []).includes(jobKind)) {
      refused.push({
        modelVersionId: column.modelVersionId,
        target: 'cloud',
        code: 'kind_unsupported_on_target',
        reason: `The deployed ${version.family} service does not run ${jobKind}. A worker that serves open-loop inference does not thereby serve the closed loop, which needs the policy socket and a renderer in the same image.`,
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
            model: {
              family: version.family,
              revision: family.pinnedRevision ?? null,
              quant: column.quant,
            },
            input: {
              spec: request.spec,
              seed,
              steps: request.steps,
              decisionHz: request.decisionHz,
              mode: request.mode,
              deadlineMs: request.deadlineMs,
              frameSource: request.frameSource,
              cameraProfile: column.rigProfile,
              campaignId: request.campaignId,
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
