"use client";

import * as stylex from "@stylexjs/stylex";
import { styles } from "./DatasetRenderPane.stylex";
import { mergeStyleProps } from "../../components/stylex";
import { RefreshCw, X } from "lucide-react";
import { CloudLoadingSurface } from "../../components/CloudLoadingSurface";
import { Button } from "../../components/ui/button";
import { DocumentRenderWorkspace } from "../editor/render/DocumentRenderWorkspace";
import { useRenderDocument } from "../editor/render/useRenderDocument";

/**
 * The dataset surface's right pane.
 *
 * It is absolutely layered over the still-mounted scene and stays glass throughout: no opaque card
 * background, because the world behind it is the scenario the renders are of and hiding it behind a
 * black panel wastes the one piece of context the pane has.
 *
 * The record comes from `useRenderDocument`, which is also what the workspace inside it configures
 * the next render against. This pane used to resolve a three-field summary of the document itself
 * (title, draft version, latest revision) and let the workspace find the *content* somewhere else
 * entirely — the open editor session, which this route deliberately leaves empty. One read, one
 * record, one owner.
 */
export function DatasetRenderPane({
  documentId,
  initialDocumentTitle,
  initialRevisionId,
  onClose,
  onRenderActivityChange,
  onImmersiveChange,
}: {
  documentId: string;
  /** Shown while the record is in flight, so a warm list does not flash an empty title. */
  initialDocumentTitle: string | null;
  initialRevisionId: string | null;
  onClose: () => void;
  onRenderActivityChange?: (activityKey: string, live: boolean) => void;
  /** True while the pane shows one render or the create form, which claim the full width. */
  onImmersiveChange?: (immersive: boolean) => void;
}) {
  const { document, loading, error, reload } = useRenderDocument(documentId);

  return (
    <aside
      aria-label="Render workspace"
      {...mergeStyleProps(stylex.props(styles.scenarioDatasetRenderPane), "render-view-enter")}
      data-testid="scenario-dataset-render-pane"
    >
      {error ? (
        <div {...stylex.props(styles.divFlex)}>
          <p {...stylex.props(styles.pSm)}>{error}</p>
          <div {...stylex.props(styles.divFlex2)}>
            <Button type="button" variant="outline" onClick={reload}>
              <RefreshCw {...stylex.props(styles.tryAgainRefreshCw)} aria-hidden="true" />
              Try again
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              <X {...stylex.props(styles.closeX)} aria-hidden="true" />
              Close
            </Button>
          </div>
        </div>
      ) : loading || !document ? (
        <CloudLoadingSurface
          scope="pane"
          detail={
            initialDocumentTitle
              ? `Preparing ${initialDocumentTitle} and its render history.`
              : "Preparing the saved scenario and its render history."
          }
          title="Loading scenario renders"
        />
      ) : (
        <DocumentRenderWorkspace
          document={document}
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
