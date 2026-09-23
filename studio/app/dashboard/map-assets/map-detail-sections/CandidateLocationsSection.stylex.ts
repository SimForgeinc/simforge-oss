import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  sectionHeaderContainer: {
    display: "flex",
    alignItems: "center",
    gap: space.s1,
  },
  candidateLocationsToggle: {
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
  candidateCountBadge: {
    backgroundColor: "rgba(67, 20, 7, 0.6)",
    paddingInline: space.s1_5,
    paddingBlock: "1px",
    fontSize: text.sizeMicro,
    fontWeight: text.weightSemibold,
    color: "#fdba74",
  },
  candidateLocationsContent: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    marginTop: space.s2,
  },
  loadingMessage: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  loadingSpinner: {
    width: "0.75rem",
    height: "0.75rem",
  },
  emptyStateMessage: {
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  candidateLocationsList: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
  },
});
