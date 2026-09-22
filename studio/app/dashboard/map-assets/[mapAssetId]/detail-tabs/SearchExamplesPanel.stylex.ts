import * as stylex from "@stylexjs/stylex";
import { colors, motion, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  searchExamplesPanel: {
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
  },
  exampleGroup: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
  },
  groupHeader: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
  },
  groupTitle: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: text.trackingWider,
    color: colors.mutedForeground,
  },
  comingSoonBadge: {
    backgroundColor: "hsl(var(--secondary) / 0.4)",
    paddingInline: space.s1_5,
    paddingBlock: space.s0_5,
    fontSize: "9px",
    fontWeight: text.weightMedium,
    textTransform: "uppercase",
    letterSpacing: text.trackingWide,
    color: colors.mutedForeground,
  },
  exampleChipList: {
    display: "flex",
    flexWrap: "wrap",
    gap: space.s1_5,
  },
  examplePill: {
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    paddingInline: space.s2_5,
    paddingBlock: space.s1,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: motion.durStandard,
  },
  examplePillAvailable: {
    borderColor: { default: colors.border, ":hover": "hsl(var(--primary) / 0.4)" },
    backgroundColor: { default: "hsl(var(--secondary) / 0.3)", ":hover": "hsl(var(--primary) / 0.1)" },
    color: colors.text,
  },
  examplePillUnavailable: {
    cursor: "not-allowed",
    borderStyle: "dashed",
    borderColor: "hsl(var(--border) / 0.6)",
    backgroundColor: "transparent",
    color: "hsl(var(--muted-foreground) / 0.7)",
  },
});
