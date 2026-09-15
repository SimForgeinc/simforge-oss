"use client";

import * as stylex from "@stylexjs/stylex";
import { styles } from "./DatasetRenderPane.stylex";
import { mergeStyleProps } from "../../components/stylex";
import { useStudioHost } from "../../host";
import { useCallback, useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { CloudLoadingSurface } from "../../components/CloudLoadingSurface";
import { Button } from "../../components/ui/button";
import { DocumentRenderWorkspace } from "../editor/render/DocumentRenderWorkspace";

type ResolvedDocument = {
  title: string;
  draftVersion: number | null;
  latestRevisionId: string | null;
};

/**
 * The dataset surface's right pane.
 *
 * It is absolutely layered over the still-mounted scene and stays glass throughout: no opaque card
 * background, because the world behind it is the scenario the renders are of and hiding it behind a
 * black panel wastes the one piece of context the pane has. A reload has only a document id in the
 * URL, so that path resolves the real document record before mounting the render workspace.
 */
export function DatasetRenderPane({
  documentId,
  initialDocumentTitle,
  initialRevisionId,
  resolveDocument,
  onClose,
  onRenderActivityChange,
  onImmersiveChange,
}: {
  documentId: string;
  initialDocumentTitle: string | null;
  initialRevisionId: string | null;
  resolveDocument: boolean;
  onClose: () => void;
  onRenderActivityChange?: (activityKey: string, live: boolean) => void;
  /** True while the pane shows one render or the create form, which claim the full width. */
  onImmersiveChange?: (immersive: boolean) => void;
}) {
  const studioHost = useStudioHost();
  const [document, setDocument] = useState<ResolvedDocument | null>(() =>
    resolveDocument
      ? null
      : { title: initialDocumentTitle ?? "", draftVersion: null, latestRevisionId: initialRevisionId },
  );
  const [loading, setLoading] = useState(resolveDocument);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const record = await studioHost.projects.getDocument(documentId, signal);
        if (signal?.aborted) return;
        setDocument({
          title: record.title,
          draftVersion: record.draftVersion,
          latestRevisionId: record.latestRevisionId,
        });
      } catch (cause) {
        if (
          signal?.aborted ||
          (cause as { name?: string } | null)?.name === "AbortError"
        )
          return;
        setError(
          cause instanceof Error
            ? cause.message
            : "Failed to load this scenario.",
        );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [documentId, studioHost],
  );

  useEffect(() => {
    if (!resolveDocument) {
      setDocument({
        title: initialDocumentTitle ?? "",
        draftVersion: null,
        latestRevisionId: initialRevisionId,
      });
      setLoading(false);
      setError(null);
      return;
    }
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [initialDocumentTitle, initialRevisionId, load, resolveDocument]);

  return (
    <aside
      aria-label="Render workspace"
      {...mergeStyleProps(stylex.props(styles.scenarioDatasetRenderPane), "render-view-enter")}
      data-testid="scenario-dataset-render-pane"
    >
      {loading || !document ? (
        <CloudLoadingSurface
          scope="pane"
          detail="Preparing the saved scenario and its render history."
          title="Loading scenario renders"
        />
      ) : error ? (
        <div {...stylex.props(styles.divFlex)}>
          <p {...stylex.props(styles.pSm)}>{error}</p>
          <div {...stylex.props(styles.divFlex2)}>
            <Button type="button" variant="outline" onClick={() => void load()}>
              <RefreshCw {...stylex.props(styles.tryAgainRefreshCw)} aria-hidden="true" />
              Try again
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              <X {...stylex.props(styles.closeX)} aria-hidden="true" />
              Close
            </Button>
          </div>
        </div>
      ) : !document ? (
        <div {...stylex.props(styles.divFlex3)}>
          <p {...stylex.props(styles.theSavedScenarioDetailsAreNo)}>
            The saved scenario details are not available yet.
          </p>
          <div {...stylex.props(styles.divFlex4)}>
            <Button type="button" variant="outline" onClick={() => void load()}>
              <RefreshCw {...stylex.props(styles.tryAgainRefreshCw2)} aria-hidden="true" />
              Try again
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              <X {...stylex.props(styles.closeX2)} aria-hidden="true" />
              Close
            </Button>
          </div>
        </div>
      ) : (
        <DocumentRenderWorkspace
          documentId={documentId}
          documentTitle={document.title}
          expectedDraftVersion={document.draftVersion}
          latestRevisionId={document.latestRevisionId}
          // Only an explicit deep link pins the pane to one snapshot. Defaulting to the latest
          // revision would hide every render taken from an earlier one, which is the history the
          // pane exists to show now that a render freezes its own snapshot.
          initialRevisionId={initialRevisionId ?? null}
          onClose={onClose}
          onRenderActivityChange={onRenderActivityChange}
          onImmersiveChange={onImmersiveChange}
        />
      )}
    </aside>
  );
}
