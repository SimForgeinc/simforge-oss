"use client";

/**
 * The evaluation screen: submit a run, then watch the workspace's runs.
 *
 * This is the whole product surface the web portal offers beyond account
 * management, and it is the same component the desktop app mounts — the host
 * differences (a local model store, a local execution target) arrive as props
 * rather than as a second implementation.
 */

import { useState } from "react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import type { ComputeJob } from "../contracts";
import type { EvaluationGateway } from "../gateway";
import type { HostExecutionSnapshot, ModelRuntimeSnapshot } from "../presentation";
import { EvaluationLauncher, type LocalRunLauncher } from "./EvaluationLauncher";
import { JobHistory } from "./JobHistory";

export function EvaluationWorkspace({
  gateway,
  host,
  runtime,
  onOpenJob,
  onRunLocally,
  notice,
  className,
}: {
  gateway: EvaluationGateway;
  host: HostExecutionSnapshot;
  /** Desktop only; the browser portal has no local model store. */
  runtime: ModelRuntimeSnapshot | null;
  onOpenJob: (jobId: string) => void;
  onRunLocally?: LocalRunLauncher;
  /** Host-specific banner, e.g. the desktop's "connect an account" prompt. */
  notice?: ReactNode;
  className?: string;
}) {
  const [lastSubmitted, setLastSubmitted] = useState<ComputeJob | null>(null);

  return (
    <div className={cn("space-y-10", className)} data-testid="evaluation-workspace">
      {notice}

      <section className="space-y-5">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">New run</h1>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            Upload a clip, choose a model, confirm the cost bound and submit. Open-loop prediction
            is scored only against a reference future that the input actually contains; a plain
            video supports the model&apos;s text analysis instead.
          </p>
        </div>
        <EvaluationLauncher
          gateway={gateway}
          host={host}
          runtime={runtime}
          onSubmitted={(job) => {
            setLastSubmitted(job);
            onOpenJob(job.id);
          }}
          onRunLocally={onRunLocally}
        />
      </section>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">Runs</h2>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            Every run in this workspace, from the web portal and from the desktop app. Runs outlive
            the tab and the app session; signing out does not cancel them.
          </p>
        </div>
        <JobHistory gateway={gateway} onOpenJob={onOpenJob} refreshToken={lastSubmitted?.id} />
      </section>
    </div>
  );
}
