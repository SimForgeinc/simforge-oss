"use client";

import { CloudActivityIndicator } from "../../../components/CloudLoadingSurface";
import { cn } from "../../../lib/utils";
import {
  renderProgressBar,
  renderStateChipStyle,
  renderStateVisual,
} from "./render-view-model";
import type { ScenarioRenderJobState } from "@simforge-oss/studio-host";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./RenderStatePieces.stylex";

/**
 * The two visual atoms every render surface repeats: a state chip and a progress bar.
 *
 * Extracted because the gallery tile, the details header and the postprocess child tile all show the
 * same two things, and three copies is three places for the accessible name to drift.
 */

export function RenderStateChip({
  state,
  className,
}: {
  state: ScenarioRenderJobState;
  className?: string;
}) {
  const visual = renderStateVisual(state);
  return (
    <span
      className={cn(stylex.props(styles.inlineFlexCenterCaps, renderStateChipStyle(visual.tone)).className, className)}
      data-render-state={state}
    >
      {visual.live ? (
        <CloudActivityIndicator iconXstyle={styles.chipSpinner} />
      ) : null}
      {visual.label}
    </span>
  );
}

/**
 * A `role="progressbar"` that stays honest.
 *
 * When the worker has reported no percentage the bar is indeterminate: it carries no
 * `aria-valuenow`, and it pulses through `.editor-pulse` rather than a bare `animate-*` so
 * `prefers-reduced-motion` is respected (parity plan §5.4 flags v2's unguarded `animate-pulse`).
 * A terminal state renders nothing — a bar sitting at 0 next to the word "Failed" is noise.
 */
export function RenderProgressBar({
  state,
  progressPercent,
  label,
  xstyle,
}: {
  state: ScenarioRenderJobState;
  progressPercent: number | null;
  label: string;
  /** Caller StyleX styles, composed after this bar's own so they win. */
  xstyle?: stylex.StyleXStyles;
}) {
  const bar = renderProgressBar({ jobState: state, progressPercent });
  if (!renderStateVisual(state).live && state !== "succeeded") return null;

  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={bar.percent ?? undefined}
      aria-valuetext={bar.indeterminate ? "In progress, no percentage reported" : undefined}
      {...stylex.props(styles.clip, xstyle)}
      role="progressbar"
    >
      {bar.indeterminate ? (
        <div className={`${stylex.props(styles.tall).className} editor-pulse`} />
      ) : (
        <div {...stylex.props(styles.tall2)} style={{ width: `${bar.widthPercent}%` }} />
      )}
    </div>
  );
}
