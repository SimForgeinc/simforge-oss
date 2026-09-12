"use client";

/**
 * Cloud and local runs on the desktop, using the shared evaluation surface.
 *
 * The workspace choice is explicit and required for submission: after the
 * tenancy fix a desktop write with no named workspace is refused with
 * `workspace_required`, and silently guessing one would be the bug that
 * refusal exists to prevent.
 */

import { useCallback, useEffect, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "next/navigation";
import { EvaluationWorkspace, RefusalNotice } from "@simforge-oss/studio-ui/evaluation";
import type { LocalRunLauncher } from "@simforge-oss/studio-ui/evaluation";
import { SelectMenu } from "@simforge-oss/studio-ui/components/ui/select-menu";
import { useEvaluationGateway, useHostExecutionSnapshot } from "@/app/lib/host/evaluation";
import { LocalRunUnavailable, startLocalRun } from "@/app/lib/host/local-runs";
import { styles } from "./cloud-runs.stylex";
type CloudWorkspace = { id: string; name: string; role: string };

export function CloudRunsClient() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<CloudWorkspace[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const gateway = useEvaluationGateway(workspaceId);
  const host = useHostExecutionSnapshot(workspaceId);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/simforge/cloud/workspaces", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`workspaces request failed (${response.status})`);
        const payload = (await response.json()) as { workspaces?: CloudWorkspace[] };
        const list = payload.workspaces ?? [];
        setWorkspaces(list);
        setWorkspaceId((current) => current ?? list[0]?.id ?? null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setWorkspaces([]);
        setError(
          cause instanceof Error
            ? `Your SimCloud workspaces could not be listed: ${cause.message}`
            : "Your SimCloud workspaces could not be listed.",
        );
      });
    return () => controller.abort();
  }, []);

  /**
   * Start the run on this machine. Local execution is a real path, not a label:
   * the inputs are staged on disk, the local model-run queue leases the run, and
   * the worker writes the same result manifest a cloud run produces.
   */
  const runLocally = useCallback<LocalRunLauncher>(
    async ({ selection, prepared, params }) => {
      try {
        const started = await startLocalRun({
          family: selection.family,
          quant: selection.quant,
          files: prepared.sourceFiles,
          params,
          seed: typeof params.seed === "number" ? params.seed : 0,
        });
        setError(null);
        router.push(`/dashboard/evaluation/local/${started.runId}`);
      } catch (cause) {
        setError(
          cause instanceof LocalRunUnavailable
            ? cause.message
            : `The local run could not be started: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    },
    [router],
  );

  const openJob = useCallback(
    (jobId: string) => router.push(`/dashboard/evaluation/runs/${jobId}`),
    [router],
  );

  return (
    <div {...stylex.props(styles.root)}>
      {error ? <RefusalNotice tone="warn" title="SimCloud" reasons={[error]} /> : null}

      {workspaces && workspaces.length > 0 ? (
        <div {...stylex.props(styles.selector)}>
          <span {...stylex.props(styles.label)}>Workspace</span>
          <SelectMenu
            label="SimCloud workspace"
            value={workspaceId ?? ""}
            options={workspaces.map((workspace) => ({
              value: workspace.id,
              label: `${workspace.name} (${workspace.role})`,
            }))}
            onChange={setWorkspaceId}
          />
          <p {...stylex.props(styles.help)}>
            Runs belong to the workspace, not to this app session. Everyone in it sees them, and
            closing the app does not stop them.
          </p>
        </div>
      ) : null}

      <EvaluationWorkspace
        gateway={gateway}
        host={host}
        runtime={null}
        onOpenJob={openJob}
        onRunLocally={runLocally}
      />
    </div>
  );
}
