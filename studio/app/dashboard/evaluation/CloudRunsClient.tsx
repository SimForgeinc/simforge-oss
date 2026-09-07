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
import { useRouter } from "next/navigation";
import { EvaluationWorkspace } from "@simforge-oss/studio-ui/evaluation";
import { RefusalNotice } from "@simforge-oss/studio-ui/evaluation";
import { SelectMenu } from "@simforge-oss/studio-ui/components/ui/select-menu";
import { useEvaluationGateway, useHostExecutionSnapshot } from "@/app/lib/host/evaluation";

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

  const openJob = useCallback(
    (jobId: string) => router.push(`/dashboard/evaluation/runs/${jobId}`),
    [router],
  );

  return (
    <div className="space-y-6">
      {error ? <RefusalNotice tone="warn" title="SimCloud" reasons={[error]} /> : null}

      {workspaces && workspaces.length > 0 ? (
        <div className="max-w-sm space-y-1.5">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Workspace</span>
          <SelectMenu
            label="SimCloud workspace"
            value={workspaceId ?? ""}
            options={workspaces.map((workspace) => ({
              value: workspace.id,
              label: `${workspace.name} (${workspace.role})`,
            }))}
            onChange={setWorkspaceId}
          />
          <p className="text-xs leading-5 text-muted-foreground">
            Runs belong to the workspace, not to this app session. Everyone in it sees them, and
            closing the app does not stop them.
          </p>
        </div>
      ) : null}

      <EvaluationWorkspace gateway={gateway} host={host} runtime={null} onOpenJob={openJob} />
    </div>
  );
}
