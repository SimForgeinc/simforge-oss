import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  utilityButtonsContainer: {
    display: "flex",
    flexWrap: "wrap",
    gap: space.s2,
  },
  utilityCopyButton: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    paddingInline: space.s2,
    paddingBlock: space.s1,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: { default: colors.mutedForeground, ":hover": colors.text },
    backgroundColor: { default: null, ":hover": colors.fillSubtle },
  },
  copiedCheckIcon: {
    width: "0.75rem",
    height: "0.75rem",
    color: colors.positive,
  },
  copyIcon: {
    width: "0.75rem",
    height: "0.75rem",
  },
});
