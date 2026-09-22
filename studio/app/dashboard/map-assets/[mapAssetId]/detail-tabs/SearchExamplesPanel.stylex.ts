import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

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
    color: colors.mutedForeground,
  },
  comingSoonBadge: {
    backgroundColor: "hsl(var(--secondary) / 0.4)",
    paddingInline: space.s1_5,
    paddingBlock: space.s0_5,
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
  },
  examplePillAvailable: {
    borderColor: { default: colors.hairline, ":hover": colors.accentLineSubtle },
    backgroundColor: { default: "hsl(var(--secondary) / 0.3)", ":hover": colors.accentWash },
    color: colors.text,
  },
  examplePillUnavailable: {
    cursor: "not-allowed",
    borderStyle: "dashed",
    borderColor: colors.hairline,
    backgroundColor: "transparent",
    color: colors.inkFaint,
  },
});
