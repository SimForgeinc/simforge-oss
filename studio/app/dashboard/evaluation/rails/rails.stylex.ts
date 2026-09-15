import * as stylex from "@stylexjs/stylex";
import { colors, radii, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  /** The rail header's action column: the primary button, then the workspace picker. */
  actions: {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
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
    borderRadius: radii.md,
    backgroundColor: colors.chip,
    color: colors.text,
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: 1,
    fontWeight: text.weightBold,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  glyphIcon: {
    position: "absolute",
    right: "-2px",
    bottom: "-2px",
    width: "0.75rem",
    height: "0.75rem",
    color: colors.textMuted,
  },
  cost: {
    fontFamily: text.fontMono,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.textMuted,
  },
  /** The report-ready dot on a campaign row. */
  reportDot: {
    width: "0.5rem",
    height: "0.5rem",
    borderRadius: radii.full,
    backgroundColor: colors.signalGreen,
  },
  promoted: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    letterSpacing: text.trackingMetaNarrow,
    textTransform: "uppercase",
    color: colors.accent,
  },
});
