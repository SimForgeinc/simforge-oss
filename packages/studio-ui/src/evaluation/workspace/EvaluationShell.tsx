"use client";

/**
 * The evaluation workspace shell: section strip, resizable rail, stage.
 *
 * The same arrangement as the scenarios index, and for the same reason — what
 * is open should change one column, not the page. The shell owns no data and
 * no selection; it is the geometry and the section switch, so both hosts can
 * put their own rails and stages inside it.
 */

import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { WorkspacePanes } from "../../components/WorkspacePanes";
import { EvaluationSectionStrip } from "./EvaluationSectionStrip";
import type { EvaluationSection } from "./useEvaluationSelection";
import { styles } from "./EvaluationShell.stylex";

/** One width for the whole product's evaluation rail, remembered per machine. */
export const EVALUATION_RAIL_WIDTH_KEY = "evaluation.rail-width.v1";

export function EvaluationShell({
  section,
  onSectionChange,
  stripFooter,
  rail,
  stage,
  overlay,
  activePane,
  onActivePaneChange,
}: {
  activePane?: "list" | "detail" | "inspector";
  onActivePaneChange?: (pane: "list" | "detail" | "inspector") => void;
  section: EvaluationSection;
  onSectionChange: (section: EvaluationSection) => void;
  /** Sits under the section squares, off the scrolling column. */
  stripFooter?: ReactNode;
  rail: ReactNode;
  stage: ReactNode;
  /** Failed actions remain beside the stage without covering its controls. */
  overlay?: ReactNode;
}) {
  return (
    <section {...stylex.props(styles.root)} data-testid="evaluation-workspace" data-section={section}>
      <WorkspacePanes
        activePane={activePane}
        onActivePaneChange={onActivePaneChange}
        storageKey={EVALUATION_RAIL_WIDTH_KEY}
        railLabel="Resize the evaluation list"
        rail={
        <div {...stylex.props(styles.panelGrid)}>
          <EvaluationSectionStrip section={section} onSectionChange={onSectionChange} footer={stripFooter} />
          <div {...stylex.props(styles.railColumn)}>{rail}</div>
        </div>
        }
        stage={<div {...stylex.props(styles.stageWrap)}>
        <div {...stylex.props(styles.stage)} data-testid="evaluation-stage">
          {stage}
        </div>
        {overlay ? <div {...stylex.props(styles.overlay)}>{overlay}</div> : null}
      </div>}
      />
    </section>
  );
}
