import * as stylex from "@stylexjs/stylex";
import { styles } from "./TimelineGlassSurface.stylex";

/** Glass chrome for the editor timeline card. */
export const TIMELINE_GLASS_SURFACE_STYLE = styles.surface;

/** Ambient layers keep the timeline legible while letting the active map tint the glass. */
export function TimelineGlassBackdrop() {
  return (
    <div
      aria-hidden="true"
      {...stylex.props(styles.absClipInert)}
      data-testid="timeline-glass-backdrop"
    >
      <div {...stylex.props(styles.absInset0)} />
      <div {...stylex.props(styles.absRound, styles.absRoundAccent)} />
      <div {...stylex.props(styles.absRound2)} />
      <div {...stylex.props(styles.abs)} />
    </div>
  );
}
