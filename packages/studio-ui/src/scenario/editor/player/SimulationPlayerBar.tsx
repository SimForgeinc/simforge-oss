"use client";

import { useRef, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Pause, Play, Video, X } from "lucide-react";
import * as stylex from "@stylexjs/stylex";

import { IconButton } from "../../../components/ui/icon-button";
import { focus, hairline, surface, textLayout, typography } from "../../../stylex/recipes.stylex";
import { styles } from "./SimulationPlayerBar.stylex";

/** Arrow keys step the playhead by this much; with Shift, by the larger step. */
const KEY_STEP_S = 1;
const KEY_STEP_LARGE_S = 5;

export type SimulationPlayerBarProps = {
  playing: boolean;
  time: number;
  startTime: number;
  endTime: number;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
  onExit: () => void;
  /** Name of the actor the chase camera follows, or null for the free camera. */
  chasedLabel: string | null;
  onFreeCamera: () => void;
};

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function formatSeconds(seconds: number): string {
  return `${Math.max(0, seconds).toFixed(1)} s`;
}

/**
 * The only chrome the simulation player shows: play/pause, a scrubber, the
 * time, who the camera follows, and the way out. Everything else in the
 * editor steps aside while the simulation plays (see `player-mode.tsx`).
 */
export function SimulationPlayerBar({
  playing,
  time,
  startTime,
  endTime,
  onPlayPause,
  onSeek,
  onExit,
  chasedLabel,
  onFreeCamera,
}: SimulationPlayerBarProps) {
  const scrubRef = useRef<HTMLDivElement>(null);
  const scrubbingRef = useRef<number | null>(null);
  const span = Math.max(1e-6, endTime - startTime);
  const shown = clamp(time, startTime, endTime);
  const progress = `${((shown - startTime) / span) * 100}%`;

  const seekToClientX = (clientX: number) => {
    const bounds = scrubRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) return;
    onSeek(startTime + clamp((clientX - bounds.left) / bounds.width, 0, 1) * span);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    scrubbingRef.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    seekToClientX(event.clientX);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (scrubbingRef.current !== event.pointerId) return;
    seekToClientX(event.clientX);
  };
  const endScrub = (event: PointerEvent<HTMLDivElement>) => {
    if (scrubbingRef.current !== event.pointerId) return;
    scrubbingRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_STEP_LARGE_S : KEY_STEP_S;
    let next: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = shown - step;
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") next = shown + step;
    else if (event.key === "Home") next = startTime;
    else if (event.key === "End") next = endTime;
    if (next === null) return;
    event.preventDefault();
    onSeek(clamp(next, startTime, endTime));
  };

  return (
    <div {...stylex.props(styles.dock)} data-testid="simulation-player">
      <div
        {...stylex.props(surface.scrim, hairline.all, hairline.strong, styles.bar)}
        role="toolbar"
        aria-label="Simulation player"
      >
        <IconButton
          label={playing ? "Pause simulation" : "Play simulation"}
          data-testid="simulation-player-play"
          onClick={onPlayPause}
          size="sm"
          variant="plate"
        >
          {playing ? <Pause /> : <Play />}
        </IconButton>
        <span
          {...stylex.props(typography.meta, typography.numeric, styles.time)}
          data-testid="simulation-player-time"
        >
          {formatSeconds(shown - startTime)} / {formatSeconds(span)}
        </span>
        <div
          ref={scrubRef}
          {...stylex.props(focus.ring, styles.scrubber)}
          aria-label="Simulation time"
          aria-valuemax={Number(endTime.toFixed(2))}
          aria-valuemin={Number(startTime.toFixed(2))}
          aria-valuenow={Number(shown.toFixed(2))}
          aria-valuetext={formatSeconds(shown - startTime)}
          data-testid="simulation-player-scrubber"
          onKeyDown={onKeyDown}
          onLostPointerCapture={() => { scrubbingRef.current = null; }}
          onPointerCancel={endScrub}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endScrub}
          role="slider"
          tabIndex={0}
        >
          <span aria-hidden="true" {...stylex.props(styles.track)} />
          <span aria-hidden="true" {...stylex.props(styles.progress(progress))} />
          <span aria-hidden="true" {...stylex.props(styles.thumb(progress))} />
        </div>
        {chasedLabel ? (
          <div {...stylex.props(styles.chase)} data-testid="simulation-player-chase">
            <IconButton
              active
              label="Free camera (Esc)"
              data-testid="simulation-player-free-camera"
              onClick={onFreeCamera}
              size="sm"
              variant="ghost"
            >
              <Video />
            </IconButton>
            <span {...stylex.props(styles.chaseText)}>
              <span {...stylex.props(typography.eyebrow)}>Following</span>
              <span {...stylex.props(typography.label, textLayout.truncate)}>{chasedLabel}</span>
            </span>
          </div>
        ) : (
          <span {...stylex.props(typography.meta, styles.hint)} data-testid="simulation-player-hint">
            Click an actor to follow it
          </span>
        )}
        <IconButton
          label="Exit simulation (Esc)"
          data-testid="simulation-player-exit"
          onClick={onExit}
          size="sm"
          variant="plate"
        >
          <X />
        </IconButton>
      </div>
    </div>
  );
}

/**
 * The chased actor's name, floating above it. Rendered once; the chase
 * camera moves and fades it every frame through CSS custom properties, so
 * following a car never re-renders React.
 */
export function ChaseActorLabel({
  label,
  labelRef,
}: {
  label: string | null;
  labelRef: RefObject<HTMLDivElement | null>;
}) {
  if (!label || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={labelRef}
      {...stylex.props(surface.scrim, hairline.all, hairline.strong, typography.label, textLayout.truncate, styles.label)}
      aria-hidden="true"
      data-testid="chase-actor-label"
    >
      {label}
    </div>,
    document.body,
  );
}
