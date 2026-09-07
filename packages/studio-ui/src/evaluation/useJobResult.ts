"use client";

/**
 * Load one job and, once it is terminal, its durable result.
 *
 * The DTO is polled while the server may still change it, then the manifest is
 * read once and the documents the result screen draws from — `openloop.json`
 * and `trajectories.json` — are fetched through short-lived exact-object
 * grants. Media (the source clip, rendered frames) keeps its grant URL only in
 * component state; nothing durable is handed a public URL.
 *
 * Failure to read a document is reported, never smoothed over: a result screen
 * that silently omits an unreadable artifact would look like a clean run.
 */

import { useCallback, useEffect, useState } from "react";
import { useVisiblePolling } from "../lib/use-visible-polling";
import type {
  ComputeJob,
  ComputeJobResultArtifact,
  EvalArtifactRole,
  EvalResultManifest,
  FramesManifest,
  OpenLoopResult,
  TrajectoriesDocument,
} from "./contracts";
import { readOpenLoopResult } from "./contracts";
import type { EvaluationGateway } from "./gateway";
import { ComputeApiError } from "./gateway";
import { jobStatusPresentation } from "./presentation";

const POLL_INTERVAL_MS = 3000;

export type JobResultBundle = {
  job: ComputeJob | null;
  manifest: EvalResultManifest | null;
  openLoop: OpenLoopResult | null;
  trajectories: TrajectoriesDocument | null;
  frames: FramesManifest | null;
  /** Grant URL for the source clip, when the run retained one. */
  videoUrl: string | null;
  /** Grant URLs for rendered frames, in manifest order. */
  frameUrls: string[];
  loading: boolean;
  /** Problems reading the job or its documents, each already user-readable. */
  problems: string[];
};

async function grantUrl(
  gateway: EvaluationGateway,
  jobId: string,
  artifact: ComputeJobResultArtifact,
): Promise<string> {
  const grant = await gateway.artifactDownloadGrant(jobId, artifact.artifactId);
  return grant.url;
}

async function loadJson(
  gateway: EvaluationGateway,
  jobId: string,
  artifact: ComputeJobResultArtifact,
): Promise<unknown> {
  const url = await grantUrl(gateway, jobId, artifact);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new ComputeApiError(
      response.status,
      "artifact_unreadable",
      `${artifact.role} could not be downloaded (${response.status}).`,
      null,
    );
  }
  return response.json();
}

export function useJobResult(gateway: EvaluationGateway, jobId: string): JobResultBundle {
  const [job, setJob] = useState<ComputeJob | null>(null);
  const [manifest, setManifest] = useState<EvalResultManifest | null>(null);
  const [openLoop, setOpenLoop] = useState<OpenLoopResult | null>(null);
  const [trajectories, setTrajectories] = useState<TrajectoriesDocument | null>(null);
  const [frames, setFrames] = useState<FramesManifest | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [frameUrls, setFrameUrls] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [problems, setProblems] = useState<string[]>([]);

  const poll = useCallback(
    async (signal: AbortSignal) => {
      try {
        const next = await gateway.getJob(jobId, signal);
        setJob(next);
        setProblems((current) => current.filter((problem) => !problem.startsWith("Run status")));
      } catch (cause) {
        if (signal.aborted) return;
        setProblems((current) => [
          ...current.filter((problem) => !problem.startsWith("Run status")),
          `Run status could not be refreshed: ${cause instanceof ComputeApiError ? cause.message : String(cause)}`,
        ]);
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [gateway, jobId],
  );

  const live = job === null || jobStatusPresentation(job.status).live;
  useVisiblePolling(poll, POLL_INTERVAL_MS, live, jobId);

  const artifacts = job?.result?.artifacts ?? null;

  useEffect(() => {
    if (!job || !artifacts) return;
    let cancelled = false;
    const record = (problem: string) =>
      setProblems((current) => (current.includes(problem) ? current : [...current, problem]));

    const byRole = (role: EvalArtifactRole) => artifacts.find((entry) => entry.role === role);

    const load = async () => {
      try {
        const document = await gateway.getJobResult(job.id);
        if (!cancelled) setManifest(document);
      } catch (cause) {
        if (!cancelled) {
          record(
            `The durable result manifest could not be read: ${cause instanceof ComputeApiError ? cause.message : String(cause)}`,
          );
        }
      }

      const openLoopArtifact = byRole("openloop-result");
      if (openLoopArtifact) {
        try {
          const parsed = readOpenLoopResult(await loadJson(gateway, job.id, openLoopArtifact));
          if (cancelled) return;
          if (parsed.ok) setOpenLoop(parsed.value);
          else record(`openloop.json could not be displayed: ${parsed.reason}`);
        } catch (cause) {
          if (!cancelled) record(cause instanceof ComputeApiError ? cause.message : String(cause));
        }
      }

      const trajectoriesArtifact = byRole("trajectories");
      if (trajectoriesArtifact) {
        try {
          const document = (await loadJson(gateway, job.id, trajectoriesArtifact)) as TrajectoriesDocument;
          if (!cancelled) setTrajectories(document);
        } catch (cause) {
          if (!cancelled) record(cause instanceof ComputeApiError ? cause.message : String(cause));
        }
      }

      const framesArtifact = byRole("frames");
      if (framesArtifact && framesArtifact.mediaType === "application/json") {
        try {
          const document = (await loadJson(gateway, job.id, framesArtifact)) as FramesManifest;
          if (!cancelled) setFrames(document);
        } catch (cause) {
          if (!cancelled) record(cause instanceof ComputeApiError ? cause.message : String(cause));
        }
      }

      const videoArtifact = byRole("video");
      if (videoArtifact) {
        try {
          const url = await grantUrl(gateway, job.id, videoArtifact);
          if (!cancelled) setVideoUrl(url);
        } catch (cause) {
          if (!cancelled) record(cause instanceof ComputeApiError ? cause.message : String(cause));
        }
      }

      const overlayArtifact = byRole("overlay-frames");
      if (overlayArtifact && overlayArtifact.mediaType !== "application/json") {
        try {
          const url = await grantUrl(gateway, job.id, overlayArtifact);
          if (!cancelled) setFrameUrls([url]);
        } catch (cause) {
          if (!cancelled) record(cause instanceof ComputeApiError ? cause.message : String(cause));
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [gateway, job, artifacts]);

  return {
    job,
    manifest,
    openLoop,
    trajectories,
    frames,
    videoUrl,
    frameUrls,
    loading,
    problems,
  };
}
