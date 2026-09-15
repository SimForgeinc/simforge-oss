"use client";

import * as stylex from "@stylexjs/stylex";
import { styles } from "./ScenarioPreviewTimeline.stylex";
import { Clapperboard, Pause, Play } from "lucide-react";
import { cn } from "../../lib/utils";
import { SCENARIO_FLOATING_CARD_CLASSNAME } from "../floating-card";

export type ScenarioPreviewTimelinePlayback = {
  playing: boolean;
  time: number;
  startTime: number;
  endTime: number;
  disabled?: boolean;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
};

/**
 * The cinematic director's presentation surface.
 *
 * Cut markers are the honest way to show that the camera is on rails: the user
 * can see where the next angle change lands and scrub straight to it. Absent
 * when the scenario cannot be directed, so the control never promises a
 * sequence that does not exist.
 */
export type ScenarioPreviewTimelineCinematic = {
  available: boolean;
  enabled: boolean;
  shotLabel: string | null;
  /** Shot boundary times, in the same units as the playhead. */
  cutTimes: readonly number[];
  onToggle: () => void;
};

function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const remaining = Math.floor(safe % 60);
  return `${minutes}:${remaining.toString().padStart(2, "0")}`;
}

/** A list-only playback scrubber with no actor lanes or interaction clips. */
export function ScenarioPreviewTimeline({
  playback,
  cinematic,
}: {
  playback: ScenarioPreviewTimelinePlayback;
  cinematic?: ScenarioPreviewTimelineCinematic;
}) {
  const endTime = Math.max(playback.startTime + 0.1, playback.endTime);
  const time = Math.max(playback.startTime, Math.min(endTime, playback.time));

  return (
    <div
      aria-label="Scenario preview timeline"
      className={cn(
        SCENARIO_FLOATING_CARD_CLASSNAME,
        "relative isolate flex h-12 w-full items-center gap-2.5 overflow-hidden rounded-[20px] border-white/25 bg-black/15 px-2.5 text-white",
        "shadow-[0_18px_54px_-18px_rgba(0,0,0,0.78)] ring-1 ring-inset ring-white/[0.08] backdrop-blur-[72px] backdrop-saturate-[1.85] backdrop-contrast-[1.05]",
      )}
      data-testid="scenario-preview-timeline"
      role="group"
      style={{
        borderRadius: "20px",
        clipPath: "inset(0 round 20px)",
        backdropFilter: "blur(72px) saturate(1.85) contrast(1.05)",
        WebkitBackdropFilter: "blur(72px) saturate(1.85) contrast(1.05)",
      }}
    >
      <div
        aria-hidden="true"
        {...stylex.props(styles.scenarioPreviewTimelineGlass)}
        data-testid="scenario-preview-timeline-glass"
      >
        <div {...stylex.props(styles.divAbsolute)} />
        <div {...stylex.props(styles.divAbsoluteIcon)} />
        <div {...stylex.props(styles.divAbsolute2)} />
      </div>

      <button
        aria-label={playback.playing ? "Pause scenario preview" : "Play scenario preview"}
        {...stylex.props(styles.buttonRelativeGridIcon)}
        disabled={playback.disabled}
        onClick={playback.onPlayPause}
        type="button"
      >
        {playback.playing ? (
          <Pause aria-hidden="true" {...stylex.props(styles.pauseIcon)} />
        ) : (
          <Play aria-hidden="true" {...stylex.props(styles.playIcon)} />
        )}
      </button>

      <div {...stylex.props(styles.divRelativeFlex)}>
        <input
          aria-label="Scenario preview time"
          {...stylex.props(styles.scenarioPreviewTimeInput)}
          disabled={playback.disabled}
          max={endTime}
          min={playback.startTime}
          onChange={(event) => playback.onSeek(Number(event.target.value))}
          step={0.1}
          type="range"
          value={time}
        />
        {cinematic?.enabled && cinematic.cutTimes.length > 0 ? (
          <div aria-hidden="true" {...stylex.props(styles.scenarioPreviewCutMarkers)} data-testid="scenario-preview-cut-markers">
            {cinematic.cutTimes.map((cutTime) => (
              <span
                {...stylex.props(styles.spanAbsolute)}
                key={cutTime}
                style={{
                  left: `${((Math.max(playback.startTime, Math.min(endTime, cutTime)) - playback.startTime) / (endTime - playback.startTime)) * 100}%`,
                }}
              />
            ))}
          </div>
        ) : null}
      </div>

      <span {...stylex.props(styles.spanRelativeMono)}>
        {formatTime(time - playback.startTime)} / {formatTime(endTime - playback.startTime)}
      </span>

      {cinematic?.available ? (
        <button
          aria-label={cinematic.enabled ? "Turn off the cinematic camera" : "Turn on the cinematic camera"}
          aria-pressed={cinematic.enabled}
          className={cn(
            "relative z-10 flex h-7 shrink-0 items-center gap-1.5 rounded-full border-0 bg-transparent px-2 text-[10px] font-medium shadow-none transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]/70",
            cinematic.enabled ? "text-[#E8E044]" : "text-white/55",
          )}
          data-cinematic-enabled={cinematic.enabled ? "true" : "false"}
          data-testid="scenario-preview-cinematic-toggle"
          onClick={cinematic.onToggle}
          title={cinematic.enabled ? "Cinematic camera on" : "Cinematic camera off"}
          type="button"
        >
          <Clapperboard aria-hidden="true" {...stylex.props(styles.clapperboardIcon)} />
          {cinematic.enabled && cinematic.shotLabel ? (
            <span data-testid="scenario-preview-shot-label">{cinematic.shotLabel}</span>
          ) : null}
        </button>
      ) : null}
    </div>
  );
}
