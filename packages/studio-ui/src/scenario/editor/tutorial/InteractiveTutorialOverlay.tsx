"use client";

import { Check, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Button } from "../../../components/ui/button";
import { CAMERA_ORBIT_EVENT } from "@simforge-oss/viewer";
import { markTutorialComplete } from "./tutorial-steps";
import type { EditorExperience } from "../simple-timed-routes";
import {
  interactiveTutorialProgram,
  type InteractiveAction,
  type InteractiveStep,
} from "./interactive-tutorial-programs";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./InteractiveTutorialOverlay.stylex";

type Rect = { top: number; left: number; width: number; height: number };

export function InteractiveTutorialOverlay({
  actorCount,
  configuredRouteCount,
  customRouteTool,
  editorMode,
  mode,
  interactionCount,
  playbackInspecting,
  playbackPlaying,
  onClose,
}: {
  actorCount: number;
  configuredRouteCount: number;
  customRouteTool: "add" | "move" | null;
  editorMode: string;
  mode: EditorExperience;
  interactionCount: number;
  playbackInspecting: boolean;
  playbackPlaying: boolean;
  onClose: () => void;
}) {
  const [steps] = useState<readonly InteractiveStep[]>(() =>
    interactiveTutorialProgram(mode, playbackInspecting),
  );
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const actorBaseline = useRef(actorCount);
  const configuredRouteBaseline = useRef(configuredRouteCount);
  const interactionBaseline = useRef(interactionCount);
  const routeDrawingStarted = useRef(false);
  const latestActorCount = useRef(actorCount);
  const latestConfiguredRouteCount = useRef(configuredRouteCount);
  const cardRef = useRef<HTMLDivElement>(null);
  const step = steps[index]!;
  latestActorCount.current = actorCount;
  latestConfiguredRouteCount.current = configuredRouteCount;

  const advance = useCallback((action: InteractiveAction) => {
    setIndex((current) => {
      if (steps[current]?.action !== action) return current;
      return Math.min(current + 1, steps.length - 1);
    });
  }, [steps]);

  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true });
  }, [step.id]);

  useEffect(() => {
    if (step.action === "place-actor") {
      actorBaseline.current = latestActorCount.current;
    }
    if (step.action === "configure-route") {
      configuredRouteBaseline.current = latestConfiguredRouteCount.current;
      routeDrawingStarted.current = false;
    }
  }, [step.action, step.id]);

  useEffect(() => {
    if (!step.selector) {
      setRect(null);
      return;
    }
    const measure = () => {
      const anchor = document.querySelector(step.selector!);
      if (!anchor) {
        setRect(null);
        return;
      }
      const box = anchor.getBoundingClientRect();
      setRect({ top: box.top, left: box.left, width: box.width, height: box.height });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step.selector]);

  useEffect(() => {
    if (step.action === "reset" && !playbackInspecting) advance("reset");
    if (step.action === "place-actor" && actorCount > actorBaseline.current) advance("place-actor");
    if (step.action === "configure-route" && editorMode === "drawingRoute") {
      routeDrawingStarted.current = true;
      advance("configure-route");
    }
    if (
      step.action === "draw-route"
      && routeDrawingStarted.current
      && configuredRouteCount > configuredRouteBaseline.current
      && customRouteTool === "move"
    ) {
      advance("draw-route");
    }
    if (step.action === "add-action" && interactionCount > interactionBaseline.current) advance("add-action");
    if (step.action === "play" && playbackPlaying) advance("play");
    if (step.action === "exit-playback" && !playbackInspecting && !playbackPlaying) {
      advance("exit-playback");
    }
  }, [
    actorCount,
    advance,
    configuredRouteCount,
    customRouteTool,
    editorMode,
    interactionCount,
    playbackInspecting,
    playbackPlaying,
    step.action,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        step.action === "move"
        && ["KeyW", "KeyA", "KeyS", "KeyD"].includes(event.code)
        && !event.altKey
        && !event.ctrlKey
        && !event.metaKey
      ) {
        advance("move");
      }
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (step.action === "open-cars" && target.closest('[data-testid="tool-vehicles"]')) {
        advance("open-cars");
      }
      if (
        step.action === "open-pedestrians"
        && target.closest('[data-testid="tool-pedestrians"]')
      ) {
        advance("open-pedestrians");
      }
      if (step.action === "choose-actor" && target.closest('[data-testid^="catalog-action-"]')) {
        advance("choose-actor");
      }
    };
    const onCameraOrbit = () => {
      if (step.action === "orbit") advance("orbit");
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener(CAMERA_ORBIT_EVENT, onCameraOrbit);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener(CAMERA_ORBIT_EVENT, onCameraOrbit);
    };
  }, [advance, step.action]);

  const finish = () => {
    markTutorialComplete(readStorage(), mode);
    onClose();
  };

  return (
    <div {...stylex.props(styles.fixedInertInset0)} data-testid="interactive-tutorial-overlay">
      <div aria-hidden="true" {...stylex.props(styles.absInset0)} />
      {rect && step.selector !== '[data-tutorial="canvas"]' ? (
        <div
          aria-hidden="true"
          {...stylex.props(styles.abs)}
          data-testid="interactive-tutorial-spotlight"
          style={{
            top: rect.top - 4,
            left: rect.left - 4,
            width: rect.width + 8,
            height: rect.height + 8,
          }}
        />
      ) : null}
      <div
        aria-labelledby="interactive-tutorial-title"
        aria-live="polite"
        {...stylex.props(styles.absWhiteBordered)}
        data-action={step.action}
        data-testid="interactive-tutorial-card"
        ref={cardRef}
        role="dialog"
        style={cardPosition(step.card)}
        tabIndex={-1}
      >
        <div {...stylex.props(styles.flexStartGap3)}>
          <div {...stylex.props(styles.fillNarrowable)}>
            <p {...stylex.props(styles.capsMonoBold)}>
              {step.eyebrow} · Step {index + 1} of {steps.length}
            </p>
            <h2 {...stylex.props(styles.semiboldBase)} id="interactive-tutorial-title">
              {step.title}
            </h2>
          </div>
          <button
            aria-label="Exit interactive tutorial"
            {...stylex.props(styles.gridCenteredTight)}
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" className={stylex.props(styles.size4).className} />
          </button>
        </div>
        <p {...stylex.props(styles.xs)}>{step.body}</p>
        <div {...stylex.props(styles.flexCenterBordered)}>
          {step.action === "finish" ? (
            <Check aria-hidden="true" className={stylex.props(styles.tight).className} />
          ) : (
            <span aria-hidden="true" {...stylex.props(styles.tightRoundPulsing)} />
          )}
          <strong {...stylex.props(styles.xsMedium)}>{step.prompt}</strong>
        </div>
        {step.action === "finish" ? (
          <Button xstyle={styles.wide} onClick={finish} size="sm" type="button">
            Continue authoring
          </Button>
        ) : (
          <p {...stylex.props(styles.mt3TextLeading4)}>
            There is no Next button—complete the highlighted action to continue.
          </p>
        )}
      </div>
    </div>
  );
}

function cardPosition(position: InteractiveStep["card"]): CSSProperties {
  const inset = 16;
  if (position === "top-left") return { top: 72, left: inset };
  if (position === "bottom-left") return { bottom: 24, left: inset };
  if (position === "bottom-right") return { right: inset, bottom: 24 };
  return { top: 72, right: inset };
}

function readStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
