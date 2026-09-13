"use client";

import type { Choreography } from "@simforge-oss/scenario";
import { CarFront } from "lucide-react";
import { mergeStyleProps, type XStyle } from "../../../components/stylex/surface";
import type { V1TimelineCrashMarker } from "./V1TimelineRail";

import {
  choreographyWindow,
  rangePercent,
  timelineTicks,
} from "../../../lib/scenario/timeline";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./TimelineRuler.stylex";

/**
 * The time axis above the interaction rows — manifest 84.
 *
 * It shares the same [0, clipSeconds] clock as browser playback.
 */
export function TimelineRuler({
  choreography,
  crashes = [],
  className,
  xstyle,
}: {
  choreography: Choreography;
  crashes?: readonly V1TimelineCrashMarker[];
  className?: string;
  /** Caller StyleX styles, applied last so they win. */
  xstyle?: XStyle;
}) {
  const window = choreographyWindow(choreography);
  const ticks = timelineTicks(window);

  return (
    <div
      {...mergeStyleProps(stylex.props(styles.relRuleB, xstyle), className)}
      data-testid="timeline-ruler"
    >
      {ticks.map((tick) => {
        const isOrigin = tick.timeMs === 0;
        const percent = rangePercent(tick.timeMs, window);
        const labelPosition = percent <= 0
          ? styles.tickLabelStart
          : percent >= 100
            ? styles.tickLabelEnd
            : styles.tickLabelCentered;
        return (
          <div
            key={tick.id}
            aria-hidden="true"
            {...stylex.props(styles.tick, isOrigin ? styles.tickOrigin : styles.tickMinor)}
            style={{ left: `${percent}%` }}
          >
            {/*
              Labels hang to the right of their tick except the last one, which would otherwise
              overflow the column and be clipped. `-translate-x-full` flips it to the left of the line
              rather than shrinking the rail to make room.
            */}
            <span
              data-testid={`timeline-tick-label-${tick.timeMs}`}
              {...stylex.props(
                styles.tickLabel,
                isOrigin ? styles.tickLabelOrigin : styles.tickLabelMinor,
                labelPosition,
              )}
            >
              {tick.title}
            </span>
          </div>
        );
      })}
      {crashes.map((crash, index) => {
        const percent = rangePercent(crash.timeS * 1000, window);
        const actors = crash.actorLabels.filter(Boolean);
        const actorSummary = actors.length > 0 ? ` involving ${actors.join(" and ")}` : "";
        const label = `Crash at ${crash.timeS.toFixed(1)} seconds${actorSummary}`;
        return (
          <span
            aria-label={label}
            {...stylex.props(styles.absFlexCenter)}
            data-testid="timeline-crash-marker"
            key={`${crash.timeS}-${actors.join("-")}-${index}`}
            role="img"
            style={{ left: `${percent}%` }}
            title={label}
          >
            <CarFront aria-hidden="true" className={stylex.props(styles.size25).className} strokeWidth={2.5} />
          </span>
        );
      })}
      {/*
        The axis is decorative for assistive tech — every interaction's timing is already stated in
        words on its own row by `triggerLabel`, so announcing tick positions would be noise, and a
        screen-reader user gets the times without needing the geometry.
      */}
      <span {...stylex.props(styles.srOnly)}>
        Timeline over {choreography.clipSeconds} seconds.
      </span>
    </div>
  );
}
