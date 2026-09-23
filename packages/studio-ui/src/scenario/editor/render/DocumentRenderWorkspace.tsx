"use client";

import { useStudioHost } from "../../../host";
import { useCallback } from "react";
import type { ScenarioDocumentDto } from "@simforge-oss/studio-host";
import { getBrowserRecordingRevisionInputClient } from "../../../lib/scenario/recording-client";
import { RenderWorkspace } from "./RenderWorkspace";
import { useOptionalScenarioSession } from "../../scene/ScenarioSessionContext";
import { SimulationStatus } from "../SimulationStatus";

/**
 * The one entry point into the render workspace, for every route that opens it.
 *
 * There is no freeze step. Opening this pane is a read: it lists the document's renders across every
 * snapshot and configures the next one against the record it is given. The snapshot is taken by the
 * render itself, at submit time, through `ensureSnapshot` — which is the only moment the scenario
 * actually needs to be immutable, because that is what the worker executes and what the author
 * later reverts to.
 *
 * The snapshot needs nothing from the browser: the host simulates the saved draft itself (inline,
 * or on a CPU runner) and binds that authoritative simulation to the revision. The client sends
 * only the draft version it is freezing.
 *
 * It takes the whole `document`, not four fields off it. Every render decision — which sensors are
 * offered, the clip length, the authored capture format, which draft version is frozen, which
 * snapshot is reused — comes from that one record, so splitting it into `documentTitle`,
 * `expectedDraftVersion` and `latestRevisionId` props only created places for the content to go
 * missing. It did: the pane used to read the content out of the open editor session instead, and
 * every route that opens the pane without an editor got `null`. See `useRenderDocument`.
 *
 * `initialRevisionId` still pins the pane to one immutable snapshot when history is opened directly.
 */
export function DocumentRenderWorkspace({
  document,
  initialRevisionId = null,
  onClose,
  onRenderActivityChange,
  onImmersiveChange,
}: {
  document: ScenarioDocumentDto;
  /** Known immutable history target. When present, the pane shows that snapshot's renders. */
  initialRevisionId?: string | null;
  onClose: () => void;
  onRenderActivityChange?: (activityKey: string, live: boolean) => void;
  /** True while one render or the create form is open, which claim the pane's full width. */
  onImmersiveChange?: (immersive: boolean) => void;
}) {
  const studioHost = useStudioHost();
  const scenarioSession = useOptionalScenarioSession();
  const liveSession = scenarioSession?.document?.id === document.id ? scenarioSession : null;
  /**
   * Freeze the open draft into an immutable snapshot and return its id.
   *
   * Idempotent per draft version. The document's latest snapshot is checked first: when it was
   * frozen from the draft version the author is looking at, it is the execution package already
   * and is reused. Otherwise `studioHost.projects.ensureRevision` waits on the host's
   * authoritative simulation of this draft (memoized by content, so an unedited scenario resolves
   * at once) and freezes the revision from it; it reuses any other snapshot of the same draft
   * version, so two renders of an unedited scenario share one snapshot and one simulation.
   */
  const ensureSnapshot = useCallback(
    async (signal?: AbortSignal) => {
      if (document.latestRevisionId) {
        const latestRevision = await getBrowserRecordingRevisionInputClient(document.latestRevisionId, signal);
        if (
          latestRevision.documentId === document.id &&
          latestRevision.sourceDraftVersion === document.draftVersion
        ) {
          return latestRevision.id;
        }
      }
      const result = await studioHost.projects.ensureRevision({
        documentId: document.id,
        expectedDraftVersion: document.draftVersion,
        signal,
      });
      return result.revisionId;
    },
    [document, studioHost],
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

  return (
    <>
      {!initialRevisionId && liveSession ? (
        <SimulationStatus
          verification={liveSession.playback.simulationVerification}
          onRetry={liveSession.playback.retrySimulationVerification}
        />
      ) : null}
    <RenderWorkspace
      revisionId={initialRevisionId}
      documentId={document.id}
      documentTitle={document.title}
      currentContent={document.content}
      currentContentSha256={document.contentSha256}
      onRestoreSnapshot={restoreSnapshot}
      ensureSnapshot={ensureSnapshot}
      onClose={onClose}
      onRenderActivityChange={onRenderActivityChange}
      onImmersiveChange={onImmersiveChange}
    />
    </>
  );
}
