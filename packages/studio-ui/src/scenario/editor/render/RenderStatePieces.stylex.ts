import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // editor-pulse h-full w-1/3 bg-primary
  tall: {
    height: "100%",
    width: "33.333333%",
    backgroundColor: colors.primary,
  },
  // h-full bg-primary
  tall2: {
    height: "100%",
    backgroundColor: colors.primary,
  },
  // inline-flex items-center gap-1 px-1.5 py-0.5 text-micro font-medium uppercase tracking-meta
  inlineFlexCenterCaps: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.xs,
    paddingLeft: space.sm,
    paddingRight: space.sm,
    paddingTop: space.xxs,
    paddingBottom: space.xxs,
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    fontWeight: text.weightMedium,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
  },
  // render-chip h-1 overflow-hidden
  clip: {
    height: "0.25rem",
    overflow: "hidden",
    backgroundColor: colors.chip,
  },

  // bg-primary/20 text-primary
  chipRunning: {
    backgroundColor: "hsl(var(--primary) / 0.2)",
    color: colors.primary,
  },
  // bg-primary/15 text-primary
  chipSucceeded: {
    backgroundColor: "hsl(var(--primary) / 0.15)",
    color: colors.primary,
  },
  // bg-destructive/20 text-destructive
  chipFailed: {
    backgroundColor: "hsl(var(--destructive) / 0.2)",
    color: colors.danger,
  },
  // bg-muted text-muted-foreground
  chipCancelled: {
    backgroundColor: colors.muted,
    color: colors.mutedForeground,
  },
  // bg-secondary text-secondary-foreground
  chipQueued: {
    backgroundColor: colors.secondary,
    color: colors.secondaryForeground,
  },
  // size-2.5
  chipSpinner: {
    width: "0.625rem",
    height: "0.625rem",
  },
});
