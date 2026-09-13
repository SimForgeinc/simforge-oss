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
import * as stylex from "@stylexjs/stylex";
import { Ban, ExternalLink, Loader2 } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { styles as s } from "./evaluation-components.stylex";
import type { XStyle } from "../../components/stylex/surface";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { EmptyState } from "../../components/ui/empty-state";
import { cn } from "../../lib/utils";
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

const TONE_STYLES: Record<JobStatusTone, XStyle> = {
  neutral: s.toneNeutral,
  active: s.toneActive,
  good: s.toneGood,
  warn: s.toneWarn,
  bad: s.toneBad,
};

export function JobStatusBadge({ job }: { job: ComputeJob }) {
  const presentation = jobStatusPresentation(job.status);
  return (
    <span {...stylex.props(s.inlineGap2)}>
      <Badge variant="outline" xstyle={TONE_STYLES[presentation.tone]}>
        {presentation.label}
      </Badge>
      {presentation.live ? <Loader2 aria-hidden="true" {...stylex.props(s.icon14, s.spinner, s.textMuted)} /> : null}
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
      <p className={cn(stylex.props(s.inlineGap2, s.textSm, s.textMuted).className, className)} style={stylex.props(s.inlineGap2, s.textSm, s.textMuted).style}>
        <Loader2 aria-hidden="true" {...stylex.props(s.iconPlain, s.spinner)} />Loading runs…
      </p>
    );
  }

  return (
    <div className={cn(stylex.props(s.section4).className, className)} data-testid="job-history">
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
              <TableHead {...stylex.props(s.tableRight)}>Cost</TableHead>
              <TableHead {...stylex.props(s.shrink0)} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((job) => {
              const presentation = jobStatusPresentation(job.status);
              const elapsed = elapsedSeconds(job.startedAt, job.finishedAt);
              return (
                <TableRow key={job.id} data-testid={`job-row-${job.id}`}>
                  <TableCell {...stylex.props(s.tableTop)}>
                    <button
                      type="button"
                      onClick={() => onOpenJob(job.id)}
                      {...stylex.props(s.linkButton)}
                    >
                      {job.kind === "alpamayo.text" ? "Text analysis" : "Open loop"}
                      <span {...stylex.props(s.mono, s.textXs, s.textMuted, s.ml2)}>
                        {job.id.slice(0, 8)}
                      </span>
                    </button>
                    <div {...stylex.props(s.mt05, s.flexWrapCenterGap15, s.textXs, s.textMuted)}>
                      <Badge variant="outline">{job.origin}</Badge>
                      {job.scored === false ? <Badge variant="outline">not scored</Badge> : null}
                      {job.inputs.length > 1 ? <span>{job.inputs.length} inputs</span> : null}
                    </div>
                  </TableCell>
                  <TableCell {...stylex.props(s.alignTopTextSm)}>
                    <div {...stylex.props(s.textFg)}>{job.model.family}</div>
                    <div {...stylex.props(s.textXs, s.textMuted)}>
                      {job.model.quant} · {job.model.revision.slice(0, 12)}
                    </div>
                  </TableCell>
                  <TableCell {...stylex.props(s.tableTop)}>
                    <JobStatusBadge job={job} />
                    {presentation.detail ? (
                      <p {...stylex.props(s.mt1, s.maxXs, s.textXs, s.leading5, s.textMuted)}>
                        {presentation.detail}
                      </p>
                    ) : null}
                    {job.error ? (
                      <p {...stylex.props(s.mt1, s.maxXs, s.textXs, s.leading5, s.textDestructive)}>
                        {job.error.message}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell {...stylex.props(s.alignTopTextSm)}>
                    <div {...stylex.props(s.textFg)}>
                      {new Date(job.createdAt).toLocaleString()}
                    </div>
                    <div {...stylex.props(s.textXs, s.textMuted)}>
                      {job.submittedByEmail ?? job.submittedByUserId}
                      {elapsed !== null ? ` · ${formatSeconds(elapsed)}` : ""}
                    </div>
                  </TableCell>
                  <TableCell {...stylex.props(s.justifyEndSm, s.tabular)}>
                    <div {...stylex.props(s.textFg)}>
                      {job.settledCents !== null
                        ? formatCents(job.settledCents)
                        : formatCents(job.reservedCents)}
                    </div>
                    <div {...stylex.props(s.textXs, s.textMuted)}>
                      {job.settledCents !== null ? "settled" : "reserved"}
                    </div>
                  </TableCell>
                  <TableCell {...stylex.props(s.tableTop)}>
                    <div {...stylex.props(s.flexGap1)}>
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
                            <Loader2 aria-hidden="true" {...stylex.props(s.spinner)} />
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
