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

/** A manifest-declared artifact joined to the id the control plane stored it under. */
type StoredArtifact = { role: string; path: string; artifactId: string };

async function grantUrl(
  gateway: EvaluationGateway,
  jobId: string,
  artifact: StoredArtifact,
): Promise<string> {
  const grant = await gateway.artifactDownloadGrant(jobId, artifact.artifactId);
  return grant.url;
}

async function loadJson(
  gateway: EvaluationGateway,
  jobId: string,
  artifact: StoredArtifact,
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

    const load = async () => {
      let document: EvalResultManifest | null = null;
      try {
        document = await gateway.getJobResult(job.id);
        if (!cancelled) setManifest(document);
      } catch (cause) {
        if (!cancelled) {
          record(
            `The durable result manifest could not be read: ${cause instanceof ComputeApiError ? cause.message : String(cause)}`,
          );
        }
      }
      if (cancelled || !document) return;

      /**
       * The control plane derives its artifact roles from file extensions
       * (`openloop.json` is `data`, `result.json` is `manifest`), so its DTO
       * roles are not the evaluation package's roles and cannot be matched
       * against them. The manifest names the real role and the path; the DTO
       * carries the downloadable id. The digest is what joins them, and it is
       * an exact join because both sides record the same content hash.
       */
      const idByDigest: Record<string, string | undefined> = {};
      for (const entry of artifacts) idByDigest[entry.sha256] = entry.artifactId;

      const resolve = (role: EvalArtifactRole) => {
        const declared = document.artifacts.find((entry) => entry.role === role);
        if (!declared) return null;
        const artifactId = idByDigest[declared.sha256];
        if (!artifactId) {
          record(
            `The run declares a ${role} artifact (${declared.path}) that the control plane did not store, so it cannot be shown.`,
          );
          return null;
        }
        return { ...declared, artifactId };
      };

      const openLoopArtifact = resolve("openloop-result");
      if (openLoopArtifact) {
        try {
          const parsed = readOpenLoopResult(await loadJson(gateway, job.id, openLoopArtifact));
          if (cancelled) return;
          if (parsed.ok) setOpenLoop(parsed.value);
          else record(`openloop.json could not be displayed: ${parsed.reason}`);
        } catch (cause) {
          if (!cancelled) record(cause instanceof ComputeApiError ? cause.message : String(cause));
        }
      } else if (document.kind === "openloop" || document.kind === "text") {
        record(
          "This run stored no openloop.json, so there are no per-item results to show. The manifest's own status and provenance are above.",
        );
      }

      const trajectoriesArtifact = resolve("trajectories");
      if (trajectoriesArtifact) {
        try {
          const parsed = (await loadJson(gateway, job.id, trajectoriesArtifact)) as TrajectoriesDocument;
          if (!cancelled) setTrajectories(parsed);
        } catch (cause) {
          if (!cancelled) record(cause instanceof ComputeApiError ? cause.message : String(cause));
        }
      }

      const framesArtifact = resolve("frames");
      if (framesArtifact && framesArtifact.path.endsWith(".json")) {
        try {
          const parsed = (await loadJson(gateway, job.id, framesArtifact)) as FramesManifest;
          if (!cancelled) setFrames(parsed);
        } catch (cause) {
          if (!cancelled) record(cause instanceof ComputeApiError ? cause.message : String(cause));
        }
      }

      const videoArtifact = resolve("video");
      if (videoArtifact) {
        try {
          const url = await grantUrl(gateway, job.id, videoArtifact);
          if (!cancelled) setVideoUrl(url);
        } catch (cause) {
          if (!cancelled) record(cause instanceof ComputeApiError ? cause.message : String(cause));
        }
      }

      const overlayArtifact = resolve("overlay-frames");
      if (overlayArtifact && !overlayArtifact.path.endsWith(".json")) {
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
