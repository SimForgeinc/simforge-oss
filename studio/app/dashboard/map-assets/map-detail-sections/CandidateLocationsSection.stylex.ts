import * as stylex from "@stylexjs/stylex";
import { colors, text, space, motion } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const spin = stylex.keyframes({
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});

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
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightSemibold,
    textTransform: "uppercase",
    letterSpacing: text.trackingWide,
    color: { default: colors.mutedForeground, ":hover": colors.text },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: motion.durStandard,
  },
  chevron: {
    width: "0.75rem",
    height: "0.75rem",
    flexShrink: 0,
    transitionProperty: "transform",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: motion.durStandard,
  },
  rotate90: {
    transform: "rotate(90deg)",
  },
  candidateCountBadge: {
    backgroundColor: "rgba(67, 20, 7, 0.6)",
    paddingInline: space.s1_5,
    paddingBlock: "1px",
    fontSize: "10px",
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
    animationName: spin,
    animationDuration: motion.durSpin,
    animationTimingFunction: motion.easeLinear,
    animationIterationCount: "infinite",
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
