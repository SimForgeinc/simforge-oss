import * as stylex from "@stylexjs/stylex";

import { colors, layers, space, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  root: {
    position: "relative",
    width: "100%",
    height: "100%",
    backgroundColor: colors.panelSolid,
    overflow: "hidden",
  },
  map: {
    position: "absolute",
    inset: 0,
  },
  /**
   * Map name plus scenario count, anchored on the footprint's centre.
   *
   * A scrim over the map, solidifying to the plate under the pointer: the
   * basemap is monochrome, so the only colour this plate carries is the accent
   * it takes on its edge when hovered or selected.
   */
  label: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.xxs,
    paddingInline: space.md,
    paddingBlock: space.xs,
    backgroundColor: {
      default: colors.overlayScrim,
      ":hover": colors.panelSolid,
    },
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: {
      default: colors.lineStrong,
      ":hover": colors.accent,
    },
    color: colors.textOnPlate,
    cursor: "pointer",
    whiteSpace: "nowrap",
    backdropFilter: "blur(6px)",
  },
  labelSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.panelSolid,
  },
  labelName: {
    fontSize: text.sizeXs,
    fontWeight: text.weightMedium,
    lineHeight: text.lineTight,
  },
  labelCount: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    letterSpacing: text.trackingMetaTight,
    textTransform: "uppercase",
    color: colors.textSubtle,
    lineHeight: text.lineTight,
  },
  /** Bottom-left plate: load state and the maps that cannot be drawn. */
  legend: {
    position: "absolute",
    left: space.xl,
    bottom: space.xl,
    zIndex: layers.raised,
    display: "flex",
    flexDirection: "column",
    gap: space.xxs,
    maxWidth: "18rem",
    paddingInline: space.lg,
    paddingBlock: space.md,
    backgroundColor: colors.overlayScrim,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.line,
    backdropFilter: "blur(6px)",
  },
  legendTitle: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    letterSpacing: text.trackingMetaTight,
    textTransform: "uppercase",
    color: colors.textFaint,
  },
  legendRow: {
    fontSize: text.sizeXs,
    color: colors.textSubtle,
    lineHeight: text.lineNormal,
  },
  status: {
    position: "absolute",
    left: "50%",
    top: space.xl,
    transform: "translateX(-50%)",
    zIndex: layers.raised,
    paddingInline: space.lg,
    paddingBlock: space.md,
    backgroundColor: colors.overlayScrim,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.line,
    fontSize: text.sizeXs,
    color: colors.textSubtle,
    backdropFilter: "blur(6px)",
  },
});
