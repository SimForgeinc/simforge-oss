import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  /** The rail header's action column: the primary button, then the workspace picker. */
  actions: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
  },
  /**
   * The row's leading square. A run has no cheap thumbnail — the result media
   * needs a manifest read and a short-lived grant per artifact — so the slot
   * carries the model's monogram over a glyph instead of an empty frame.
   */
  glyph: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: "2rem",
    height: "2rem",
    backgroundColor: colors.fillStrong,
    color: colors.text,
  },
  glyphIcon: {
    position: "absolute",
    right: "-2px",
    bottom: "-2px",
    width: "0.75rem",
    height: "0.75rem",
    color: colors.mutedForeground,
  },
  cost: {
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
  /** The report-ready dot on a campaign row. */
  reportDot: {
    width: "0.5rem",
    height: "0.5rem",
    backgroundColor: colors.signalGreen,
  },
  promoted: {
    color: colors.accent,
  },
});
