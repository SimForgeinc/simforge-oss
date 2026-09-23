import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  tagsHeader: {
    display: "flex",
    alignItems: "center",
    gap: space.s1,
  },
  toggleButton: {
    display: "flex",
    flex: "1 1 0%",
    alignItems: "center",
    gap: space.s1_5,
    color: { default: colors.mutedForeground, ":hover": colors.text },
  },
  chevron: {
    width: "0.75rem",
    height: "0.75rem",
    flexShrink: 0,
  },
  rotate90: {
    transform: "rotate(90deg)",
  },
  copyButton: {
    flexShrink: 0,
    color: { default: colors.inkFaint, ":hover": colors.mutedForeground },
  },
  checkIcon: {
    width: "0.75rem",
    height: "0.75rem",
    color: colors.positive,
  },
  copyIcon: {
    width: "0.75rem",
    height: "0.75rem",
  },
  tagsList: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
    marginTop: space.s2,
  },
  tagItem: {
    backgroundColor: colors.fillFaint,
    paddingInline: space.s2_5,
    paddingBlock: space.s2,
  },
  tagLabel: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightMedium,
    color: colors.text,
  },
  tagDefinition: {
    marginTop: space.s0_5,
    fontSize: text.sizeMeta,
    lineHeight: text.lineSnug,
    color: colors.mutedForeground,
  },
});
