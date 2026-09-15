/**
 * Runs, grouped by the scenario they came from.
 *
 * A prediction is about something: the render of an authored scenario, or a
 * clip somebody uploaded. A flat reverse-chronological list loses that — the
 * five runs of one scenario read as five unrelated rows — so the rail groups
 * by the render job the submission recorded (`sourceRenderJobId`, the named
 * field on `ComputeJobSubmission.input`; see `render-handoff.ts`).
 *
 * The link is read defensively. The control plane stores the field on the job,
 * but `ComputeJob.params` is typed `unknown` by contract and older jobs
 * predate the field entirely: anything that does not yield a string id is an
 * uploaded clip, which is what it is.
 */

import type { ComputeJob } from "@simforge-oss/evaluation/client";

export type RunGroupKind = "scenario" | "uploads";

export type RunGroup = {
  /** Stable across renders: the render job id, or the literal uploads key. */
  key: string;
  kind: RunGroupKind;
  title: string;
  /** The render job this group is the scenario of, when it has one. */
  renderJobId: string | null;
  /** Newest first, as the rail shows them. */
  jobs: ComputeJob[];
};

export const UPLOADED_CLIPS_GROUP_KEY = "uploaded-clips";

/**
 * The render job a run came from, when the submission recorded one.
 *
 * Three readings, because the field travels three ways between the submission
 * and a listed job: promoted onto the job row, kept in the opaque params bag,
 * or nested under the handoff provenance the desktop writes.
 */
export function sourceRenderJobId(job: ComputeJob): string | null {
  if ("sourceRenderJobId" in job) {
    const promoted = job.sourceRenderJobId;
    if (typeof promoted === "string" && promoted) return promoted;
  }
  const params: unknown = job.params;
  if (typeof params !== "object" || params === null) return null;
  if ("sourceRenderJobId" in params) {
    const direct = params.sourceRenderJobId;
    if (typeof direct === "string" && direct) return direct;
  }
  if ("provenance" in params) {
    const provenance = params.provenance;
    if (typeof provenance === "object" && provenance !== null && "renderJobId" in provenance) {
      const nested = provenance.renderJobId;
      if (typeof nested === "string" && nested) return nested;
    }
  }
  return null;
}

/**
 * Ordered groups: scenarios by their newest run first, then the uploaded
 * clips. Ties break on the group key so a re-render never reshuffles two
 * scenarios whose newest runs share a timestamp.
 *
 * A run whose render job has no resolved title is grouped under the uploads
 * heading rather than under a raw id: an unresolvable link is not a scenario
 * the reader can recognise.
 */
export function groupRunsByScenario(
  jobs: readonly ComputeJob[],
  titles: ReadonlyMap<string, string>,
): RunGroup[] {
  const scenarios = new Map<string, RunGroup>();
  const uploads: ComputeJob[] = [];

  for (const job of jobs) {
    const renderJobId = sourceRenderJobId(job);
    const title = renderJobId ? titles.get(renderJobId) : undefined;
    if (!renderJobId || !title) {
      uploads.push(job);
      continue;
    }
    const group = scenarios.get(renderJobId);
    if (group) group.jobs.push(job);
    else {
      scenarios.set(renderJobId, {
        key: renderJobId,
        kind: "scenario",
        title,
        renderJobId,
        jobs: [job],
      });
    }
  }

  const newest = (group: RunGroup) =>
    group.jobs.reduce((latest, job) => (job.createdAt > latest ? job.createdAt : latest), "");

  const ordered = [...scenarios.values()].sort((left, right) => {
    const delta = newest(right).localeCompare(newest(left));
    return delta !== 0 ? delta : left.key.localeCompare(right.key);
  });
  for (const group of ordered) {
    group.jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  }

  if (uploads.length > 0) {
    uploads.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
    ordered.push({
      key: UPLOADED_CLIPS_GROUP_KEY,
      kind: "uploads",
      title: "Uploaded clips",
      renderJobId: null,
      jobs: uploads,
    });
  }
  return ordered;
}

/** The render jobs a page of runs needs titles for, deduplicated. */
export function sourceRenderJobIds(jobs: readonly ComputeJob[]): string[] {
  const ids = new Set<string>();
  for (const job of jobs) {
    const renderJobId = sourceRenderJobId(job);
    if (renderJobId) ids.add(renderJobId);
  }
  return [...ids];
}
