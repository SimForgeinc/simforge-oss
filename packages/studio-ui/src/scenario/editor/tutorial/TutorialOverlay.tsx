"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Button } from "../../../components/ui/button";
import {
  markTutorialComplete,
  reachableSteps,
  shouldRunTutorial,
  tutorialStepsForMode,
  type TutorialStep,
} from "./tutorial-steps";
import type { EditorExperience } from "../simple-timed-routes";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./TutorialOverlay.stylex";
import { motionStyles } from "../../../stylex/motion.stylex";

type Rect = { top: number; left: number; width: number; height: number };

/**
 * The first-run walkthrough.
 *
 * It is a dialog, not decoration: focus moves into it, Escape closes it, and the
 * arrow keys step it. A tour that traps a keyboard user is worse than no tour, so
 * everything it does is reachable without a pointer.
 *
 * The spotlight is a ring drawn *around* the anchor rather than a mask cut out of
 * a backdrop. A masked backdrop has to sit above the editor to dim it, which
 * means it also eats the click the step is telling the author to make — v1 solved
 * this with `pointer-events-none` on the backdrop and re-enabling it per hole,
 * and the ring avoids the problem instead of managing it.
 */
export function TutorialOverlay({
  mode,
  onClose,
}: {
  mode: EditorExperience;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);

  const steps = useMemo(
    () =>
      reachableSteps(tutorialStepsForMode(mode), (anchor) =>
        Boolean(document.querySelector(`[data-tutorial="${anchor}"]`)),
      ),
    [mode],
  );
  const step: TutorialStep | undefined = steps[index];

  const finish = useCallback(() => {
    markTutorialComplete(readStorage(), mode);
    onClose();
  }, [mode, onClose]);

  // Track the anchor's box. Scroll and resize both move it, and the rails are
  // independently scrollable, so a one-shot measurement drifts.
  useEffect(() => {
    if (!step?.anchor) {
      setRect(null);
      return;
    }
    const measure = () => {
      const node = document.querySelector(`[data-tutorial="${step.anchor}"]`);
      if (!node) return setRect(null);
      const box = node.getBoundingClientRect();
      setRect({
        top: box.top,
        left: box.left,
        width: box.width,
        height: box.height,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step?.anchor]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish();
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setIndex((current) => Math.min(current + 1, steps.length - 1));
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setIndex((current) => Math.max(current - 1, 0));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [finish, steps.length]);

  if (!step) return null;
  const last = index === steps.length - 1;

  return (
    <div {...stylex.props(styles.fixedInertInset0)}>
      {rect ? (
        <div
          aria-hidden="true"
          className={`${stylex.props(styles.abs).className} tutorial-spotlight-ring`}
          style={{
            top: rect.top - 2,
            left: rect.left - 2,
            width: rect.width + 4,
            height: rect.height + 4,
          }}
        />
      ) : null}

      <div
        aria-labelledby="scenario-tutorial-title"
        aria-modal="false"
        {...stylex.props(styles.absBorderedLive)}
        role="dialog"
        style={cardPosition(step, rect)}
      >
        <div {...stylex.props(styles.flexStartGap2)}>
          <div {...stylex.props(styles.fillNarrowable)}>
            <p {...stylex.props(styles.capsMicroAccent)}>
              {mode} mode · Step {index + 1} of {steps.length}
            </p>
            <h2
              {...stylex.props(styles.smSemibold)}
              id="scenario-tutorial-title"
            >
              {step.title}
            </h2>
          </div>
          <button
            type="button"
            aria-label="Skip the walkthrough"
            className={stylex.props(styles.inlineFlexCenterMid, motionStyles.editorMotion).className}
            onClick={finish}
          >
            <X aria-hidden="true" className={stylex.props(styles.size4).className} />
          </button>
        </div>
        <p {...stylex.props(styles.xsMuted)}>{step.body}</p>
        <div {...stylex.props(styles.flexCenterGap2)}>
          <Button
            xstyle={styles.h8}
            disabled={index === 0}
            size="sm"
            variant="outline"
            onClick={() => setIndex((current) => Math.max(current - 1, 0))}
          >
            Back
          </Button>
          <Button
            autoFocus
            xstyle={styles.pushRight}
            size="sm"
            onClick={() =>
              last ? finish() : setIndex((current) => current + 1)
            }
          >
            {last ? "Start authoring" : "Next"}
          </Button>
        </div>
        <p {...stylex.props(styles.microMuted)}>
          ← → to step · Esc to skip
        </p>
      </div>
    </div>
  );
}

/**
 * Place the card beside its anchor, clamped into the viewport.
 *
 * Clamping matters more than the requested side: the rails are 220px at the
 * narrow breakpoint and a 352px card anchored to one would otherwise hang off
 * screen with its buttons unreachable.
 */
function cardPosition(step: TutorialStep, rect: Rect | null) {
  if (!rect) {
    return { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };
  }
  const GAP = 12;
  const CARD_W = 352;
  const CARD_H = 220;
  const vw = typeof window === "undefined" ? CARD_W : window.innerWidth;
  const vh = typeof window === "undefined" ? CARD_H : window.innerHeight;

  let top = rect.top;
  let left = rect.left + rect.width + GAP;
  if (step.side === "left") left = rect.left - CARD_W - GAP;
  if (step.side === "bottom") {
    top = rect.top + rect.height + GAP;
    left = rect.left;
  }
  if (step.side === "top") {
    top = rect.top - CARD_H - GAP;
    left = rect.left;
  }

  return {
    top: clamp(top, GAP, Math.max(GAP, vh - CARD_H - GAP)),
    left: clamp(left, GAP, Math.max(GAP, vw - CARD_W - GAP)),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function readStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Whether this browser has already been walked through. */
export function tutorialPending(mode: EditorExperience): boolean {
  return shouldRunTutorial(readStorage(), mode);
}
