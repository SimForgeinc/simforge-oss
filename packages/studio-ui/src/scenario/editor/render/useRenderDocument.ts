"use client";

import { useCallback, useEffect, useState } from "react";
import type { ScenarioDocumentDto } from "@simforge-oss/studio-host";
import { useStudioHost } from "../../../host";
import { useOptionalScenarioSession } from "../../scene/ScenarioSessionContext";

export type RenderDocumentState = {
  /** The record every render decision is made against; null only while loading or after a failure. */
  document: ScenarioDocumentDto | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
};

/**
 * The document the render workspace renders.
 *
 * The render pane used to borrow the open editor's document out of `ScenarioSessionContext`. That
 * is wrong, and it was wrong in the way that is hardest to see: opening the pane by URL
 * (`?preview=<doc>&pane=render`) deliberately leaves the editor session empty — rendering must not
 * wake a world host and an editor — so the pane received `null` content and every content-derived
 * control silently degraded. The visible symptom was a scenario with eight authored sensors
 * offering none of them, behind the "Add a camera, LiDAR or radar to an actor" empty state.
 *
 * Configuring a render is a read. So the pane performs that read itself, and the editor session is
 * only a shortcut: when the author happens to have this same document open, its in-memory record
 * wins, because it carries edits the server copy does not have yet. Otherwise the record is fetched.
 * One owner, one shape, both routes.
 */
export function useRenderDocument(documentId: string): RenderDocumentState {
  const studioHost = useStudioHost();
  const session = useOptionalScenarioSession();
  const openDocument = session?.document?.id === documentId ? session.document : null;
  const editorHoldsDocument = openDocument !== null;
  const [fetched, setFetched] = useState<ScenarioDocumentDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (editorHoldsDocument) return;
    const abort = new AbortController();
    setError(null);
    studioHost.projects
      .getDocument(documentId, abort.signal)
      .then((record) => {
        if (!abort.signal.aborted) setFetched(record);
      })
      .catch((cause) => {
        if (abort.signal.aborted || (cause as { name?: string } | null)?.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : "Failed to load this scenario.");
      });
    return () => abort.abort();
  }, [attempt, documentId, editorHoldsDocument, studioHost]);

  // A different document invalidates the record we hold rather than showing the previous one's
  // sensors and clip length against the new id.
  useEffect(() => setFetched(null), [documentId]);

  const document = openDocument ?? (fetched?.id === documentId ? fetched : null);
  return {
    document,
    loading: document === null && error === null,
    error,
    reload: useCallback(() => setAttempt((value) => value + 1), []),
  };
}
