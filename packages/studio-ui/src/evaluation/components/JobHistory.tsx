"use client";

/**
 * One workspace-scoped job history, shared by both hosts.
 *
 * A run belongs to the workspace, not to the tab or the desktop session that
 * started it: closing the app or signing out does not lose it, and a job
 * submitted from the desktop appears here with `origin: 'desktop'`. That is why
 * this list is the same component in both places and reads one endpoint.
 *
 * Polling stops as soon as nothing is live, and only runs while the tab is
 * visible.
 */

import { useCallback, useState } from "react";
import { Ban, ExternalLink, Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { useVisiblePolling } from "../../lib/use-visible-polling";
import type { ComputeJob } from "../contracts";
import type { EvaluationGateway } from "../gateway";
import { ComputeApiError } from "../gateway";
import {
  elapsedSeconds,
  formatCents,
  formatSeconds,
  jobStatusPresentation,
} from "../presentation";
import type { JobStatusTone } from "../presentation";
import { RefusalNotice } from "./RefusalNotice";

const POLL_INTERVAL_MS = 4000;

const TONE_CLASSES: Record<JobStatusTone, string> = {
  neutral: "border-border text-muted-foreground",
  active: "border-primary/50 text-primary",
  good: "border-emerald-500/50 text-emerald-600 dark:text-emerald-400",
  warn: "border-amber-500/50 text-amber-600 dark:text-amber-500",
  bad: "border-destructive/50 text-destructive",
};

export function JobStatusBadge({ job }: { job: ComputeJob }) {
  const presentation = jobStatusPresentation(job.status);
  return (
    <span className="inline-flex items-center gap-2">
      <Badge variant="outline" className={TONE_CLASSES[presentation.tone]}>
        {presentation.label}
      </Badge>
      {presentation.live ? (
        <Loader2 aria-hidden="true" className="size-3.5 animate-spin text-muted-foreground" />
      ) : null}
    </span>
  );
}

export function JobHistory({
  gateway,
  onOpenJob,
  refreshToken,
  className,
}: {
  gateway: EvaluationGateway;
  onOpenJob: (jobId: string) => void;
  /** Change this after a submission to pull the new job in immediately. */
  refreshToken?: unknown;
  className?: string;
}) {
  const [jobs, setJobs] = useState<ComputeJob[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const refresh = useCallback(
    async (signal: AbortSignal) => {
      try {
        const page = await gateway.listJobs({ limit: 25, signal });
        setJobs(page.jobs);
        setNextCursor(page.nextCursor);
        setError(null);
      } catch (cause) {
        if (signal.aborted) return;
        setError(
          cause instanceof ComputeApiError ? cause.message : "The job list could not be loaded.",
        );
      }
    },
    [gateway],
  );

  const anyLive = jobs?.some((job) => jobStatusPresentation(job.status).live) ?? true;
  useVisiblePolling(refresh, POLL_INTERVAL_MS, true, `${anyLive}:${String(refreshToken)}`);

  const loadMore = async () => {
    if (!nextCursor) return;
    try {
      const page = await gateway.listJobs({ limit: 25, cursor: nextCursor });
      setJobs((current) => [...(current ?? []), ...page.jobs]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof ComputeApiError ? cause.message : "More jobs could not be loaded.");
    }
  };

  const cancel = async (job: ComputeJob) => {
    setCancelling(job.id);
    try {
      const result = await gateway.cancelJob(job.id);
      setJobs((current) =>
        (current ?? []).map((entry) =>
          entry.id === job.id ? { ...entry, status: result.status, cancellable: false } : entry,
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof ComputeApiError
          ? cause.message
          : `${job.id} could not be cancelled: ${String(cause)}`,
      );
    } finally {
      setCancelling(null);
    }
  };

  if (jobs === null) {
    return (
      <p className={cn("inline-flex items-center gap-2 text-sm text-muted-foreground", className)}>
        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
        Loading runs…
      </p>
    );
  }

  return (
    <div className={cn("space-y-4", className)} data-testid="job-history">
      {error ? <RefusalNotice tone="warn" title="Job list" reasons={[error]} /> : null}

      {jobs.length === 0 ? (
        <EmptyState
          title="No runs yet"
          description="Runs you submit here and from the desktop app both appear in this list, for everyone in the workspace."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Run</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Submitted</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="w-px" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((job) => {
              const presentation = jobStatusPresentation(job.status);
              const elapsed = elapsedSeconds(job.startedAt, job.finishedAt);
              return (
                <TableRow key={job.id} data-testid={`job-row-${job.id}`}>
                  <TableCell className="align-top">
                    <button
                      type="button"
                      onClick={() => onOpenJob(job.id)}
                      className="text-left font-medium text-foreground underline-offset-4 hover:underline"
                    >
                      {job.kind === "alpamayo.text" ? "Text analysis" : "Open loop"}
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {job.id.slice(0, 8)}
                      </span>
                    </button>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <Badge variant="outline">{job.origin}</Badge>
                      {job.scored === false ? <Badge variant="outline">not scored</Badge> : null}
                      {job.inputs.length > 1 ? <span>{job.inputs.length} inputs</span> : null}
                    </div>
                  </TableCell>
                  <TableCell className="align-top text-sm">
                    <div className="text-foreground">{job.model.family}</div>
                    <div className="text-xs text-muted-foreground">
                      {job.model.quant} · {job.model.revision.slice(0, 12)}
                    </div>
                  </TableCell>
                  <TableCell className="align-top">
                    <JobStatusBadge job={job} />
                    {presentation.detail ? (
                      <p className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">
                        {presentation.detail}
                      </p>
                    ) : null}
                    {job.error ? (
                      <p className="mt-1 max-w-xs text-xs leading-5 text-destructive">
                        {job.error.message}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell className="align-top text-sm">
                    <div className="text-foreground">
                      {new Date(job.createdAt).toLocaleString()}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {job.submittedByEmail ?? job.submittedByUserId}
                      {elapsed !== null ? ` · ${formatSeconds(elapsed)}` : ""}
                    </div>
                  </TableCell>
                  <TableCell className="align-top text-right text-sm tabular-nums">
                    <div className="text-foreground">
                      {job.settledCents !== null
                        ? formatCents(job.settledCents)
                        : formatCents(job.reservedCents)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {job.settledCents !== null ? "settled" : "reserved"}
                    </div>
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="flex items-center gap-1">
                      {job.cancellable ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={cancelling === job.id}
                          onClick={() => void cancel(job)}
                          aria-label={`Cancel run ${job.id}`}
                        >
                          {cancelling === job.id ? (
                            <Loader2 aria-hidden="true" className="animate-spin" />
                          ) : (
                            <Ban aria-hidden="true" />
                          )}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => onOpenJob(job.id)}
                        aria-label={`Open run ${job.id}`}
                      >
                        <ExternalLink aria-hidden="true" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {nextCursor ? (
        <Button type="button" variant="outline" size="sm" onClick={() => void loadMore()}>
          Load older runs
        </Button>
      ) : null}
    </div>
  );
}
