"use client";

/**
 * One workspace's job list, live.
 *
 * Extracted from `JobHistory` because the rail and the table are two views of
 * exactly the same thing: the same page, the same 4-second visible-only poll,
 * the same cancel. Two copies would poll twice and disagree about which run is
 * cancelling.
 *
 * Polling stops paying attention once nothing is live — `useVisiblePolling`
 * also stops while the tab is hidden — so an idle workspace settles into a
 * refresh per submission rather than a request every four seconds forever.
 */

import { useCallback, useState } from "react";
import { useVisiblePolling } from "../../lib/use-visible-polling";
import type { ComputeJob, EvaluationGateway } from "@simforge-oss/evaluation/client";
import { ComputeApiError } from "@simforge-oss/evaluation/client";
import { jobStatusPresentation } from "../presentation";

export const JOB_POLL_INTERVAL_MS = 4000;
const PAGE_SIZE = 25;

export type JobList = {
  /** Null until the first page settles: loading is not an empty workspace. */
  jobs: ComputeJob[] | null;
  error: string | null;
  nextCursor: string | null;
  /** The job whose cancel is in flight. */
  cancelling: string | null;
  loadMore: () => Promise<void>;
  cancel: (job: ComputeJob) => Promise<void>;
};

export function useJobList(
  gateway: EvaluationGateway,
  /** Change after a submission to pull the new job in immediately. */
  refreshToken?: unknown,
): JobList {
  const [jobs, setJobs] = useState<ComputeJob[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const refresh = useCallback(
    async (signal: AbortSignal) => {
      try {
        const page = await gateway.listJobs({ limit: PAGE_SIZE, signal });
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
  useVisiblePolling(refresh, JOB_POLL_INTERVAL_MS, true, `${anyLive}:${String(refreshToken)}`);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    try {
      const page = await gateway.listJobs({ limit: PAGE_SIZE, cursor: nextCursor });
      setJobs((current) => [...(current ?? []), ...page.jobs]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof ComputeApiError ? cause.message : "More jobs could not be loaded.");
    }
  }, [gateway, nextCursor]);

  const cancel = useCallback(
    async (job: ComputeJob) => {
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
    },
    [gateway],
  );

  return { jobs, error, nextCursor, cancelling, loadMore, cancel };
}
