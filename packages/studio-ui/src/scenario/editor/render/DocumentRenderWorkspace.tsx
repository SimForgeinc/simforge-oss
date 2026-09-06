"use client";

import { useStudioHost } from "../../../host";
import { useCallback } from "react";
import { getBrowserRecordingRevisionInputClient } from "../../../lib/scenario/recording-client";
import { RenderWorkspace } from "./RenderWorkspace";
import { useOptionalScenarioSession } from "../../scene/ScenarioSessionContext";

/**
 * The one entry point into the render workspace, for every route that opens it.
 *
 * There is no freeze step. Opening this pane is a read: it lists the document's renders across every
 * snapshot and configures the next one against the draft the author is looking at. The snapshot is
 * taken by the render itself, at submit time, through `ensureSnapshot` — which is the only moment
 * the scenario actually needs to be immutable, because that is what the worker executes and what the
 * author later reverts to.
 *
 * This used to gate the whole pane behind a "Freeze revision for recording" button. That existed
 * because freezing needs deterministic traffic evidence (`prepareRevisionEvidence`) which only a
 * live browser session can produce — a real precondition, but one that belongs to submitting a
 * render, not to looking at the ones that already exist.
 *
 * `initialRevisionId` still pins the pane to one immutable snapshot when history is opened directly.
 */
export function DocumentRenderWorkspace({
  documentId,
  documentTitle,
  expectedDraftVersion,
  initialRevisionId = null,
  latestRevisionId = null,
  onClose,
  onRenderActivityChange,
  onImmersiveChange,
}: {
  documentId: string | null;
  documentTitle: string | null;
  expectedDraftVersion?: number | null;
  /** Known immutable history target. When present, the pane shows that snapshot's renders. */
  initialRevisionId?: string | null;
  /** Current immutable snapshot, reused when it already represents the open draft. */
  latestRevisionId?: string | null;
  onClose: () => void;
  onRenderActivityChange?: (activityKey: string, live: boolean) => void;
  /** True while one render or the create form is open, which claim the pane's full width. */
  onImmersiveChange?: (immersive: boolean) => void;
}) {
  const studioHost = useStudioHost();
  const scenarioSession = useOptionalScenarioSession();

  /**
   * Freeze the open draft into an immutable snapshot and return its id.
   *
   * Idempotent per draft version. The document's latest snapshot is checked first: when it was
   * frozen from the draft version the author is looking at, it is the execution package already
   * and is reused without touching the browser session. Only a changed or never-frozen draft needs
   * deterministic traffic evidence, which only a live session can produce.
   * `studioHost.projects.ensureRevision` then reuses any other snapshot of the same draft version,
   * so two renders of an unedited scenario share one snapshot instead of minting a duplicate.
   */
  const ensureSnapshot = useCallback(
    async (signal?: AbortSignal) => {
      if (!documentId) {
        throw new Error("Open a saved scenario before creating a render.");
      }
      const openDocument =
        scenarioSession?.document?.id === documentId ? scenarioSession.document : null;
      const currentDraftVersion = openDocument?.draftVersion ?? expectedDraftVersion;
      if (latestRevisionId && currentDraftVersion != null) {
        const latestRevision = await getBrowserRecordingRevisionInputClient(latestRevisionId, signal);
        if (
          latestRevision.documentId === documentId &&
          latestRevision.sourceDraftVersion === currentDraftVersion
        ) {
          return latestRevision.id;
        }
      }
      if (!scenarioSession) {
        throw new Error("Open this scenario from its dataset before creating a render.");
      }
      const evidence = await scenarioSession.prepareRevisionEvidence(documentId);
      const result = await studioHost.projects.ensureRevision({
        documentId,
        expectedDraftVersion: currentDraftVersion,
        evidence,
        signal,
      });
      return result.revisionId;
    },
    [documentId, expectedDraftVersion, latestRevisionId, scenarioSession, studioHost],
  );

  /**
   * Restore a render's snapshot over the open draft.
   *
   * Deliberately an ordinary document write rather than a bespoke endpoint: the snapshot's content
   * is saved as the draft's content under the draft's own optimistic version, so a revert is an
   * edit like any other — it bumps the draft version, it can be rendered again, and it can itself
   * be reverted by restoring a different render. Handing the result to `updateDocument` is what
   * moves the open editor and the world onto the restored scenario.
   */
  const restoreSnapshot = useCallback(
    async (revisionId: string) => {
      const current = scenarioSession?.document;
      if (!current) {
        throw new Error("Open this scenario in its editor before restoring a render's setup.");
      }
      const snapshot = await getBrowserRecordingRevisionInputClient(revisionId);
      const updated = await studioHost.projects.saveDocument(current, snapshot.content);
      scenarioSession.updateDocument(updated);
    },
    [scenarioSession, studioHost],
  );

  if (!documentId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Select a saved scenario to open its render workspace.
      </div>
    );
  }
  return (
    <RenderWorkspace
      revisionId={initialRevisionId}
      documentId={documentId}
      documentTitle={documentTitle}
      currentContent={scenarioSession?.document?.content ?? null}
      currentContentSha256={scenarioSession?.document?.contentSha256 ?? null}
      onRestoreSnapshot={restoreSnapshot}
      ensureSnapshot={ensureSnapshot}
      onClose={onClose}
      onRenderActivityChange={onRenderActivityChange}
      onImmersiveChange={onImmersiveChange}
    />
  );
}
