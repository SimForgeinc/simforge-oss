"use client";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { cn } from "../../../lib/utils";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./RenderWizardChrome.stylex";
import { motionStyles } from "../../../stylex/motion.stylex";

/**
 * The chrome every step of the new-render flow shares.
 *
 * Creating a render used to be one screen holding every control at once — engine, sensors, kinds,
 * clip window, outputs, resolution, FPS, quality, preflight and the submit button — which at pane
 * width meant an author scrolled a form to find out what they were even choosing. It is now a short
 * sequence of decisions, and these three pieces are what makes each step look like the same surface:
 * a rail that says where you are, a body that must fit, and a footer that owns movement.
 *
 * The body deliberately clips instead of scrolling. A step that does not fit is a step that is
 * asking for too much at once, and the fix is to split it rather than to hand the author a scrollbar
 * — the render pane's only scrollable region is the gallery.
 */

export type RenderWizardStep = { id: string; label: string };

export function RenderWizardStepRail({
  steps,
  activeIndex,
  onSelect,
}: {
  steps: readonly RenderWizardStep[];
  activeIndex: number;
  /** Called for an already-completed step only; later steps stay disabled. */
  onSelect: (index: number) => void;
}) {
  return (
    <ol {...stylex.props(styles.flexCenterWrap)} data-testid="render-wizard-steps">
      {steps.map((step, index) => {
        const state = index === activeIndex ? "active" : index < activeIndex ? "done" : "todo";
        return (
          <li {...stylex.props(styles.flexCenterGap1)} key={step.id}>
            {index > 0 ? <span aria-hidden="true" {...stylex.props(styles.ruleT)} /> : null}
            <button
              aria-current={state === "active" ? "step" : undefined}
              className={stylex.props(
                styles.inlineFlexCenterCaps2,
                motionStyles.editorMotion,
                state === "active"
                  ? styles.stepActive
                  : state === "done"
                    ? styles.stepDone
                    : styles.stepTodo,
              ).className}
              data-state={state}
              data-testid={`render-wizard-step-${step.id}`}
              disabled={state === "todo"}
              onClick={() => onSelect(index)}
              type="button"
            >
              {state === "done" ? (
                <Check aria-hidden="true" className={stylex.props(styles.size3).className} />
              ) : (
                <span {...stylex.props(styles.mono)}>{String(index + 1).padStart(2, "0")}</span>
              )}
              {step.label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * One step's content area: fills the pane, never scrolls.
 *
 * `overflow-hidden` is the constraint that keeps the flow honest. `min-h-0` is what makes it apply
 * at all inside the pane's flex column.
 *
 * The step's decisions sit in the middle of that area rather than pinned to its top. The render
 * pane is as tall as the workspace, and a two-card step aligned to the top left a single choice
 * stranded above roughly a thousand pixels of blurred scene — the flow read as a fragment of a
 * form rather than a question being asked. Centring is `safe`, not plain, because plain `center`
 * overflows a clipped box in *both* directions: measured in Chrome, an overflowing column starts
 * 80px above its own top edge, so the step's heading would be the first thing lost on a scenario
 * with many sensors. `safe center` falls back to start alignment exactly then, and browsers that
 * do not know the keyword drop the declaration and keep the old top alignment.
 */
export function RenderWizardBody({
  children,
  className,
  testId,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={cn(stylex.props(styles.flexColFill).className, "render-step-center", className)}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

/**
 * The footer: a note about the step on the left, movement on the right.
 *
 * `primary` replaces the Next button on the last step, so the one button that submits a render is
 * always in the same place rather than buried under whichever section the author scrolled to.
 */
export function RenderWizardFooter({
  note,
  onBack,
  backLabel = "Back",
  onNext,
  nextLabel = "Next",
  nextDisabled = false,
  primary,
}: {
  note?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  primary?: ReactNode;
}) {
  return (
    <footer {...stylex.props(styles.flexCenterBetween)}>
      <div {...stylex.props(styles.microMutedNarrowable)}>{note}</div>
      <div {...stylex.props(styles.flexCenterTight)}>
        {onBack ? (
          <button
            className={stylex.props(styles.inlineFlexCenterCaps, motionStyles.editorMotion).className}
            data-testid="render-wizard-back"
            onClick={onBack}
            type="button"
          >
            <ArrowLeft aria-hidden="true" className={stylex.props(styles.size35).className} />
            {backLabel}
          </button>
        ) : null}
        {primary ?? (onNext ? (
          <button
            className={stylex.props(nextDisabled ? styles.inlineFlexCenterCaps3 : styles.inlineFlexCenterCaps4, motionStyles.editorMotion).className}
            data-testid="render-wizard-next"
            disabled={nextDisabled}
            onClick={onNext}
            type="button"
          >
            {nextLabel}
            <ArrowRight aria-hidden="true" className={stylex.props(styles.size35).className} />
          </button>
        ) : null)}
      </div>
    </footer>
  );
}

/**
 * A selectable card: an engine, a camera, an output.
 *
 * Exclusive choices pass `role="radio"`, multi-selects `aria-pressed`. Both look identical on
 * purpose — the step's heading says which one it is, so the card does not have to.
 */
export function RenderOptionCard({
  badge,
  disabled = false,
  hint,
  icon: Icon,
  label,
  onClick,
  selected,
  selection,
  testId,
}: {
  badge?: ReactNode;
  disabled?: boolean;
  hint?: ReactNode;
  icon?: LucideIcon;
  label: ReactNode;
  onClick: () => void;
  selected: boolean;
  selection: "single" | "multi";
  testId?: string;
}) {
  return (
    <button
      aria-checked={selection === "single" ? selected : undefined}
      aria-pressed={selection === "multi" ? selected : undefined}
      className={stylex.props(styles.flexColStart, selected ? styles.borderPrimaryBgPrimary10 : styles.renderGlassHoverBorderPrimary40, disabled && styles.cursorNotAllowedOpacity50, motionStyles.editorMotion).className}
      data-selected={selected}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      role={selection === "single" ? "radio" : undefined}
      type="button"
    >
      <span {...stylex.props(styles.flexCenterWide)}>
        {Icon ? (
          <Icon
            aria-hidden="true"
            className={stylex.props(selected ? styles.tightAccent : styles.tightMuted).className}
          />
        ) : null}
        <span {...stylex.props(styles.fillXsInk)}>{label}</span>
        {badge}
      </span>
      {hint ? (
        <span {...stylex.props(styles.microMutedRelaxed)}>{hint}</span>
      ) : null}
    </button>
  );
}
