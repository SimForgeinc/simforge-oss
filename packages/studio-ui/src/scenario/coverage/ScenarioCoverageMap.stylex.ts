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
    gap: space.s0_5,
    paddingInline: space.s2,
    paddingBlock: space.s1,
    backgroundColor: {
      default: colors.scrim,
      ":hover": colors.panelSolid,
    },
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: {
      default: colors.hairlineStrong,
      ":hover": colors.accent,
    },
    color: colors.ink,
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
  actions: {
    display: "flex",
    gap: space.s1,
    marginTop: space.s1,
  },
  /** The plate's own two verbs: quiet text on the plate, accent under the pointer, like its edge. */
  action: {
    appearance: "none",
    backgroundColor: "transparent",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: {
      default: colors.hairlineStrong,
      ":hover": colors.accent,
    },
    paddingInline: space.s1,
    paddingBlock: space.s0_5,
    fontFamily: text.fontBody,
    fontSize: text.sizeXs,
    lineHeight: text.lineTight,
    color: {
      default: colors.ink,
      ":hover": colors.accent,
    },
    cursor: {
      default: "pointer",
      ":disabled": "progress",
    },
  },
  /** Bottom-left plate: load state and the maps that cannot be drawn. */
  legend: {
    position: "absolute",
    left: space.s4,
    bottom: space.s4,
    zIndex: layers.raised,
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    maxWidth: "18rem",
    paddingInline: space.s3,
    paddingBlock: space.s2,
    backgroundColor: colors.scrim,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.hairline,
    backdropFilter: "blur(6px)",
  },
  legendTitle: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    letterSpacing: text.trackingMetaTight,
    textTransform: "uppercase",
    color: colors.inkFaint,
  },
  legendRow: {
    fontSize: text.sizeXs,
    color: colors.textSubtle,
    lineHeight: text.lineNormal,
  },
  status: {
    position: "absolute",
    left: "50%",
    top: space.s4,
    transform: "translateX(-50%)",
    zIndex: layers.raised,
    paddingInline: space.s3,
    paddingBlock: space.s2,
    backgroundColor: colors.scrim,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.hairline,
    fontSize: text.sizeXs,
    color: colors.textSubtle,
    backdropFilter: "blur(6px)",
  },
});
