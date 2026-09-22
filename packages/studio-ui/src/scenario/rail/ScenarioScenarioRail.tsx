"use client";

import * as stylex from "@stylexjs/stylex";
import { styles } from "./ScenarioScenarioRail.stylex";
import { mergeStyleProps } from "../../components/stylex";
import { useEffect, useRef } from "react";
import Link from "next/link";
import {
  BarChart3,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  LayoutList,
  Pause,
  Play,
  Plus,
} from "lucide-react";
import { CloudActivityIndicator } from "../../components/CloudLoadingSurface";
import { ListSkeleton } from "../../components/ListSkeleton";
import type { ScenarioDocumentSummaryDto } from "../../lib/scenario/contracts";
import { Button } from "../../components/ui/button";
import { control, rail } from "../scenario-controls.stylex";
import { documentMapLabel, documentName } from "../list/document-list-utils";
import { focus, motionRecipe, textLayout, typography } from "../../stylex/recipes.stylex";

/**
 * The in-editor scenario rail: every sibling document in the active dataset, selectable in place.
 *
 * This is what makes the editor navigable at all. Without it the editor opens `documents[0]` and every
 * other document in the dataset is unreachable — a dataset of 40 is a dataset where 39 are invisible.
 *
 * The rail is wider than v1's 72px strip because a v2 document has a title worth reading; v1's rail
 * showed an actor count and a runtime badge, which fit in a column that a scenario name does not.
 */
export function ScenarioScenarioRail({
  datasetId,
  datasetName,
  documents,
  activeDocumentId,
  loading,
  error,
  canCreate,
  creating,
  autoplayPlaying,
  autoplayProgress,
  statusOpen,
  onSelectDocument,
  onSelectPrevious,
  onSelectNext,
  onCreateDocument,
  onToggleAutoplay,
  onToggleStatus,
  onBack,
}: {
  datasetId: string;
  datasetName: string | null;
  documents: ScenarioDocumentSummaryDto[];
  activeDocumentId: string | null;
  loading: boolean;
  error: string | null;
  canCreate: boolean;
  creating: boolean;
  autoplayPlaying: boolean;
  autoplayProgress: number;
  statusOpen: boolean;
  onSelectDocument: (documentId: string) => void;
  onSelectPrevious: () => void;
  onSelectNext: () => void;
  onCreateDocument: () => void;
  onToggleAutoplay: () => void;
  onToggleStatus: () => void;
  /**
   * Return to the dataset list *within the same rail*, when the rail is the datasets page's sidebar.
   *
   * When given, the dataset label stops being a link out to the dataset route: on that page there is nowhere
   * to navigate to, and following a link would unmount the world scene beside the rail — the exact
   * teardown this rail's in-place selection exists to avoid. Omitted inside the editor, where the label
   * links to the full list as before.
   */
  onBack?: () => void;
}) {
  const activeRef = useRef<HTMLButtonElement | null>(null);

  // Autoplay and Alt+Arrow both move the selection without the user scrolling, so the rail has to
  // follow. `nearest` rather than `center` so a manual click does not jump the list under the cursor.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeDocumentId]);

  return (
    <aside
      {...stylex.props(styles.scenarioScenarioRail)}
      data-testid="scenario-scenario-rail"
      aria-label="Scenarios in this dataset"
    >
      <div
        {...stylex.props(styles.scenarioScenarioHeader)}
        data-testid="scenario-scenario-header"
      >
        <div {...stylex.props(styles.divFlex)}>
          <h2 {...stylex.props([typography.eyebrow, styles.scenarios])}>
            Scenarios
          </h2>
          <span {...stylex.props(styles.spanMetaMicro)}>
            {documents.length}
          </span>
        </div>
        <div {...stylex.props(styles.divFlex2)}>
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              {...stylex.props([textLayout.truncate, focus.ring, motionRecipe.colors, [typography.eyebrow, styles.backToAllDatasetsButton]])}
              title="Back to all datasets"
            >
              <ChevronLeft {...stylex.props(styles.chevronleftIcon)} aria-hidden="true" />
              <span {...stylex.props(textLayout.truncate)}>{datasetName ?? "Dataset"}</span>
            </button>
          ) : (
            <Link
              href={`/dashboard/scenario/${encodeURIComponent(datasetId)}`}
              {...stylex.props([textLayout.truncate, focus.ring, motionRecipe.colors, [typography.eyebrow, styles.openTheFullScenarioListLink]])}
              title="Open the full scenario list"
            >
              <LayoutList {...stylex.props(styles.layoutlistIcon)} aria-hidden="true" />
              {datasetName ?? "Dataset"}
            </Link>
          )}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            xstyle={[control.iconSm, control.flatBackground, statusOpen ? rail.toggleOn : null]}
            aria-pressed={statusOpen}
            aria-label="Dataset status"
            title="Dataset status"
            onClick={onToggleStatus}
          >
            <BarChart3 {...stylex.props(styles.barchart3Icon)} aria-hidden="true" />
          </Button>
        </div>
        <div {...stylex.props(styles.divFlex3)}>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            xstyle={control.iconSm}
            aria-label="Previous scenario"
            title="Previous scenario (Alt+↑)"
            onClick={onSelectPrevious}
          >
            <ChevronUp {...stylex.props(styles.chevronupIcon)} aria-hidden="true" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            xstyle={control.iconSm}
            aria-label="Next scenario"
            title="Next scenario (Alt+↓)"
            onClick={onSelectNext}
          >
            <ChevronDown {...stylex.props(styles.chevrondownIcon)} aria-hidden="true" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            xstyle={[[typography.eyebrow, rail.autoplay], autoplayPlaying ? rail.autoplayOn : null]}
            aria-pressed={autoplayPlaying}
            title="Step through every scenario in this dataset"
            onClick={onToggleAutoplay}
          >
            {autoplayPlaying ? (
              <Pause {...stylex.props(styles.pauseIcon)} aria-hidden="true" />
            ) : (
              <Play {...stylex.props(styles.playIcon)} aria-hidden="true" />
            )}
            Review
          </Button>
        </div>
        {canCreate ? (
          <Button
            type="button"
            size="md"
            variant="accent"
            xstyle={rail.footerAction}
            disabled={creating}
            onClick={onCreateDocument}
          >
            {creating ? (
              <CloudActivityIndicator />
            ) : (
              <Plus {...stylex.props(styles.plusIcon)} aria-hidden="true" />
            )}
            Add Scenario
          </Button>
        ) : null}
        {autoplayPlaying ? (
          <div
            {...stylex.props(styles.timeUntilTheNextScenario)}
            role="progressbar"
            aria-label="Time until the next scenario"
            aria-valuenow={Math.round(autoplayProgress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              {...stylex.props(styles.div)}
              style={{ width: `${autoplayProgress * 100}%` }}
            />
          </div>
        ) : null}
      </div>

      <div {...mergeStyleProps(stylex.props(styles.div2), "scenario-glass-scrollbar")}>
        {error ? (
          <p {...stylex.props(styles.alert)} role="alert">
            {error}
          </p>
        ) : null}
        {loading && documents.length === 0 ? (
          <ListSkeleton label="Loading scenarios" />
        ) : error && documents.length === 0 ? null : documents.length === 0 ? (
          <p {...stylex.props(styles.noScenariosInThisDatasetYet)}>
            No scenarios in this dataset yet.
          </p>
        ) : (
          <ul>
            {documents.map((document) => {
              const active = document.id === activeDocumentId;
              return (
                <li key={document.id} {...stylex.props(styles.row)}>
                  <button
                    ref={active ? activeRef : undefined}
                    type="button"
                    aria-current={active ? "true" : undefined}
                    onClick={() => onSelectDocument(document.id)}
                    {...stylex.props(styles.documentButton, active ? styles.activeDocument : styles.idleDocument)}
                    data-document-id={document.id}
                  >
                    <span {...stylex.props(styles.spanMetaMedium)}>
                      {documentName(document)}
                    </span>
                    <span {...stylex.props([textLayout.truncate, [typography.eyebrow, styles.spanTruncateMetaMicro]])}>
                      {documentMapLabel(document)} · {document.roleCount}{" "}
                      {document.roleCount === 1 ? "role" : "roles"}
                    </span>
                    {document.hasRender ? (
                      <span {...stylex.props([typography.eyebrow, styles.rendered])}>
                        Rendered
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
