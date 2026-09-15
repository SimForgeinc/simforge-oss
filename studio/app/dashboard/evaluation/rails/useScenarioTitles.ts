"use client";

/**
 * Scenario titles for the render jobs a set of runs came from.
 *
 * A run records the render job it was made from, and a render job records the
 * revision it rendered — but no render-job route carries the scenario's name,
 * so the title is two reads: `render-jobs/:id/provenance` for the document id,
 * then `documents/:id` for its title. Both are existing routes; neither is
 * invented for this rail.
 *
 * Resolved titles are cached for the lifetime of the tab. A render job's
 * document is immutable enough for a group heading — a rename lands on the
 * next reload — and the alternative is re-reading two endpoints per render job
 * on every poll of the job list.
 */

import { useEffect, useState } from "react";

/** Resolved title, or null for "asked, and there is no title to show". */
const titleCache = new Map<string, string | null>();

async function resolveTitle(renderJobId: string, signal: AbortSignal): Promise<string | null> {
  const provenanceResponse = await fetch(
    `/api/simforge/render-jobs/${encodeURIComponent(renderJobId)}/provenance`,
    { cache: "no-store", signal },
  );
  if (!provenanceResponse.ok) return null;
  const provenance: unknown = await provenanceResponse.json();
  if (typeof provenance !== "object" || provenance === null || !("documentId" in provenance)) {
    return null;
  }
  const documentId = provenance.documentId;
  if (typeof documentId !== "string" || !documentId) return null;

  const documentResponse = await fetch(
    `/api/simforge/documents/${encodeURIComponent(documentId)}`,
    { cache: "no-store", signal },
  );
  if (!documentResponse.ok) return null;
  const document: unknown = await documentResponse.json();
  if (typeof document !== "object" || document === null || !("title" in document)) return null;
  const title = document.title;
  return typeof title === "string" && title.trim() ? title : null;
}

export function useScenarioTitles(renderJobIds: readonly string[]): ReadonlyMap<string, string> {
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(() => new Map());

  // Joined rather than depended on as an array: the caller derives these ids
  // from a polled job list, so the array identity changes every four seconds
  // while its contents almost never do.
  const key = renderJobIds.join(",");

  useEffect(() => {
    const ids = key.split(",").filter(Boolean);
    const controller = new AbortController();
    const publish = () => {
      const next = new Map<string, string>();
      for (const renderJobId of ids) {
        const title = titleCache.get(renderJobId);
        if (title) next.set(renderJobId, title);
      }
      setTitles(next);
    };
    publish();

    const pending = ids.filter((renderJobId) => !titleCache.has(renderJobId));
    if (pending.length === 0) return;
    void Promise.all(
      pending.map(async (renderJobId) => {
        try {
          titleCache.set(renderJobId, await resolveTitle(renderJobId, controller.signal));
        } catch {
          // An unreadable render job is a run without a scenario, which the
          // rail already has a place for: uploaded clips.
          if (!controller.signal.aborted) titleCache.set(renderJobId, null);
        }
      }),
    ).then(() => {
      if (!controller.signal.aborted) publish();
    });
    return () => controller.abort();
  }, [key]);

  return titles;
}
