"use client";

import { rangePercent, type ResolvedInteraction, type TimelineRange } from "../../../lib/scenario/timeline";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./InteractionTrack.stylex";

/**
 * One interaction drawn as a bar on the shared time axis — manifest 84.
 *
 * The bar's *appearance* carries what the static analysis could and could not determine, because those
 * are different claims and drawing them identically is a lie the author cannot detect:
 *
 * - a solid bar is an exact start and an authored end;
 * - a dashed left edge means `armed` — the start on screen is the earliest instant it *could* fire, not
 *   a time anything claims. A condition trigger, a back-solved arrival, or an expression reading a
 *   site fact no template knows yet;
 * - a faded right edge means `openEnded` — no `until` was authored, so it runs until something preempts
 *   it or the clip ends. The bar reaching the right edge is not an authored value.
 *
 * A zero-width bar is a real state, not a bug: an `until` earlier than its own trigger collapses to
 * nothing, and the validator reports it as `until_before_trigger`. `min-w-px` keeps it visible so the
 * author can find the row the error names.
 */
export function InteractionTrack({
  resolved,
  window,
}: {
  resolved: ResolvedInteraction;
  window: TimelineRange;
}) {
  const startPercent = rangePercent(resolved.range.startMs, window);
  const endPercent = rangePercent(resolved.range.endMs, window);

  return (
    <div {...stylex.props(styles.relClip)} aria-hidden="true" data-testid="interaction-track">
      <div {...stylex.props(styles.abs)} />
      <div
        {...stylex.props(
          styles.bar,
          resolved.armed ? styles.barArmed : styles.barExact,
          resolved.openEnded && styles.barOpenEnded,
        )}
        data-armed={String(resolved.armed)}
        data-open-ended={String(resolved.openEnded)}
        style={{
          left: `${startPercent}%`,
          width: `${Math.max(0, endPercent - startPercent)}%`,
        }}
      />
    </div>
  );
}
