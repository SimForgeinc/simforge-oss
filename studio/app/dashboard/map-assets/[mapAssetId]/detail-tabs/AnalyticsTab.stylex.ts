import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  loadingState: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    paddingBlock: space.s12,
  },
  loadingSpinner: {
    width: "1.25rem",
    height: "1.25rem",
    color: colors.mutedForeground,
  },
  emptyState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    paddingBlock: space.s12,
    textAlign: "center",
  },
  emptyStateIconWrapper: {
    display: "flex",
    height: "3rem",
    width: "3rem",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.fillSubtle,
    marginBottom: space.s3,
  },
  emptyStateIcon: {
    color: colors.mutedForeground,
  },
  emptyStateTitle: {
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    fontWeight: text.weightMedium,
    color: colors.text,
  },
  emptyStateDescription: {
    marginTop: space.s1,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
    maxWidth: "240px",
  },
});
