import * as stylex from "@stylexjs/stylex";
import { colors, text, space, motion } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

const spin = stylex.keyframes({
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});

export const styles = stylex.create({
  headerRow: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
  },
  sectionToggle: {
    display: "flex",
    flex: "1 1 0%",
    alignItems: "center",
    gap: space.sm,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.025em",
    color: { default: colors.mutedForeground, ":hover": colors.text },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
  },
  chevron: {
    width: "0.75rem",
    height: "0.75rem",
    flexShrink: 0,
    transitionProperty: "transform",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
  },
  rotate90: {
    transform: "rotate(90deg)",
  },
  enrichIconButton: {
    display: "flex",
    width: "1.25rem",
    height: "1.25rem",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: { default: colors.border, ":hover": "hsl(var(--foreground) / 0.3)" },
    color: { default: colors.mutedForeground, ":hover": colors.text },
    transitionProperty: "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionTimingFunction: motion.easeStandard,
    transitionDuration: "150ms",
    backgroundColor: { default: null, ":hover": "hsl(var(--muted) / 0.5)" },
    pointerEvents: { default: null, ":disabled": "none" },
    opacity: { default: null, ":disabled": 0.5 },
  },
  enrichLoadingIcon: {
    width: "0.75rem",
    height: "0.75rem",
    animationName: spin,
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  enrichSparklesIcon: {
    width: "0.75rem",
    height: "0.75rem",
  },
  enrichTooltip: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  contentPanel: {
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
    marginTop: space.md,
  },
  statusText: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  emptyStateText: {
    fontSize: text.sizeXs,
    lineHeight: 1.625,
    color: colors.mutedForeground,
  },
  stackY2: { marginTop: { default: space.md, ":first-child": space.none } },
  enrichButton: {
    width: "100%",
  },
  buttonLoadingIcon: {
    marginRight: space.sm,
    width: "0.875rem",
    height: "0.875rem",
    animationName: spin,
    animationDuration: "1s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  buttonSparklesIcon: {
    marginRight: space.sm,
    width: "0.875rem",
    height: "0.875rem",
  },
  emptyStateError: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.danger,
  },
  provenanceLabel: {
    color: "hsl(var(--foreground) / 0.8)",
  },
  loadedError: {
    marginTop: space.sm,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.danger,
  },
  attributionText: {
    fontSize: "10px",
    lineHeight: 1.375,
    color: colors.mutedForeground,
  },
});
