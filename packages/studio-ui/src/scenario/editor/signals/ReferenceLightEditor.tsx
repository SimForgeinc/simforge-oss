"use client";

import { useId, type ReactNode } from "react";
import { ArrowUpDown, ChevronDown, ChevronUp } from "lucide-react";

import { Input } from "../../../components/ui/input";
import {
  MAX_GREEN_S,
  MAX_RED_S,
  MAX_YELLOW_S,
  MIN_GREEN_S,
  MIN_RED_S,
  MIN_YELLOW_S,
  referenceCycleSeconds,
  type ReferenceCyclePhase,
  type ReferenceCycleTiming,
} from "../../../lib/scenario/signals";

import { formatSeconds, indicationSwatch } from "./indication-style";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./ReferenceLightEditor.stylex";

/**
 * The whole authoring surface for one traffic light: three sortable phase rows.
 *
 * Each row controls its duration and the row order is the playback order. The
 * cycle is their sum, and everything that crosses this light takes its turn
 * inside the red row. See `signals/reference-cycle.ts`.
 *
 * The PRIMARY card of the panel, and deliberately not behind a disclosure. v1
 * shipped this above an `Advanced` fold and everything else below it; v2 keeps
 * that ordering.
 */
export function ReferenceLightEditor({
  timing,
  generated,
  crossingStageCount,
  label,
  headerAction,
  phaseOrder,
  onPhaseOrderChange,
  onTimingChange,
}: {
  timing: ReferenceCycleTiming;
  /**
   * Whether these three numbers still explain the plan that is stored.
   *
   * `false` means the cycle has been hand-edited or transferred and the numbers
   * describe only part of it. Surfaced loudly: an author who believes the card
   * describes their junction will retime it and silently lose the hand edits.
   */
  generated: boolean;
  crossingStageCount: number;
  /** What to call the light the author clicked. */
  label: string;
  headerAction?: ReactNode;
  phaseOrder: readonly ReferenceCyclePhase[];
  onPhaseOrderChange: (next: readonly ReferenceCyclePhase[]) => void;
  onTimingChange: (next: Partial<ReferenceCycleTiming>) => void;
}) {
  const cycleS = referenceCycleSeconds(timing);
  const durationByPhase: Record<ReferenceCyclePhase, number> = {
    green: timing.greenS,
    yellow: timing.yellowS,
    red: timing.redS,
  };

  const movePhase = (at: number, direction: -1 | 1) => {
    const nextAt = at + direction;
    if (nextAt < 0 || nextAt >= phaseOrder.length) return;
    const next = [...phaseOrder];
    [next[at], next[nextAt]] = [next[nextAt]!, next[at]!];
    onPhaseOrderChange(next);
  };

  return (
    <section aria-label="Traffic light timing" {...stylex.props(styles.narrowable)}>
      <div {...stylex.props(styles.flexCenterBetween)}>
        <p {...stylex.props(styles.metaInkSemibold)}>{label}</p>
        {headerAction}
      </div>

      {/* The cycle at a glance follows the same user-selected order as the table. */}
      <div
        aria-hidden="true"
        {...stylex.props(styles.flexBorderedClip)}
      >
        {phaseOrder.map((indication) => {
          const seconds = durationByPhase[indication];
          return seconds > 0 ? (
            <span
              key={indication}
              {...stylex.props(indicationSwatch(indication).fill)}
              style={{ width: `${(seconds / Math.max(cycleS, 0.1)) * 100}%` }}
            />
          ) : null;
        })}
      </div>

      <div
        aria-label="Traffic light phase order and duration"
        {...stylex.props(styles.borderedClip)}
        role="table"
      >
        <div
          {...stylex.props(styles.gridCenterCaps)}
          role="row"
        >
          <span aria-label="Order" role="columnheader" />
          <span role="columnheader">Phase</span>
          <span {...stylex.props(styles.rightText)} role="columnheader">Seconds</span>
          <span {...stylex.props(styles.srOnly)} role="columnheader">Reorder</span>
        </div>
        {phaseOrder.map((phase, at) => (
          <TimingRow
            key={phase}
            phase={phase}
            value={durationByPhase[phase]}
            first={at === 0}
            last={at === phaseOrder.length - 1}
            onMoveUp={() => movePhase(at, -1)}
            onMoveDown={() => movePhase(at, 1)}
            onCommit={(value) => onTimingChange(timingUpdateForPhase(phase, value))}
          />
        ))}
      </div>

      <p {...stylex.props(styles.microMutedRelaxed)}>
        {formatSeconds(cycleS)}s cycle
        {crossingStageCount > 0
          ? ` · ${crossingStageCount} crossing ${
              crossingStageCount === 1 ? "stage takes" : "stages take"
            } turns while this light is red`
          : " · nothing crosses this light"}
      </p>

      {/*
        One of the four behaviours that must surface. `generated: false` is not a
        cosmetic caveat: retiming from here recompiles the whole junction, so the
        author's hand edits are about to be replaced and they have to know before
        they type.
      */}
      {!generated ? (
        <p
          {...stylex.props(styles.microBorderedRelaxed)}
          data-testid="signal-reference-hand-edited"
          role="status"
        >
          Hand-edited; retiming overwrites. These three numbers describe only part
          of what this junction does. Changing any of them replaces the whole
          cycle.
        </p>
      ) : null}
    </section>
  );
}

function timingUpdateForPhase(
  phase: ReferenceCyclePhase,
  value: number,
): Partial<ReferenceCycleTiming> {
  if (phase === "green") return { greenS: value };
  if (phase === "yellow") return { yellowS: value };
  return { redS: value };
}

/**
 * One labelled number, committed on blur or Enter.
 *
 * Not per keystroke: typing "25" passes through "2", which would recompile the
 * junction — and push a junk entry onto the document's undo stack — on the way.
 */
function TimingRow({
  phase,
  value,
  first,
  last,
  onMoveUp,
  onMoveDown,
  onCommit,
}: {
  phase: ReferenceCyclePhase;
  value: number;
  first: boolean;
  last: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onCommit: (value: number) => void;
}) {
  const id = useId();
  const label = phase[0]!.toUpperCase() + phase.slice(1);
  const bounds = phase === "green"
    ? { min: MIN_GREEN_S, max: MAX_GREEN_S }
    : phase === "yellow"
      ? { min: MIN_YELLOW_S, max: MAX_YELLOW_S }
      : { min: MIN_RED_S, max: MAX_RED_S };
  return (
    <div
      {...stylex.props(styles.gridCenterRuleB)}
      data-testid={`traffic-light-phase-row-${phase}`}
      role="row"
    >
      <span {...stylex.props(styles.gridCentered)} role="cell">
        <ArrowUpDown aria-hidden="true" className={stylex.props(styles.size3TextMutedForeground60).className} />
      </span>
      <div {...stylex.props(styles.flexCenterNarrowable)} role="cell">
        <span
          aria-hidden="true"
          {...stylex.props(styles.phaseDot, indicationSwatch(phase).fill)}
        />
        <label {...stylex.props(styles.metaInkTruncate)} htmlFor={id}>
          {label}
        </label>
      </div>
      <div {...stylex.props(styles.rel)} role="cell">
        <Input
          id={id}
          key={`${id}-${value}`}
          type="number"
          inputMode="decimal"
          min={bounds.min}
          max={bounds.max}
          step={1}
          defaultValue={value}
          xstyle={styles.metaWideRightText}
          onBlur={(event) => {
            const next = Number(event.currentTarget.value);
            if (Number.isFinite(next) && next !== value) onCommit(next);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <span
          aria-hidden="true"
          {...stylex.props(styles.absMutedInert)}
        >
          s
        </span>
      </div>
      <div {...stylex.props(styles.flexEnd)} role="cell">
        <button
          aria-label={`Move ${label} up`}
          {...stylex.props(styles.gridCenteredMuted)}
          disabled={first}
          onClick={onMoveUp}
          type="button"
        >
          <ChevronUp aria-hidden="true" className={stylex.props(styles.size3).className} />
        </button>
        <button
          aria-label={`Move ${label} down`}
          {...stylex.props(styles.gridCenteredMuted)}
          disabled={last}
          onClick={onMoveDown}
          type="button"
        >
          <ChevronDown aria-hidden="true" className={stylex.props(styles.size3).className} />
        </button>
      </div>
    </div>
  );
}
