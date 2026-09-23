import * as stylex from "@stylexjs/stylex";
import { colors, space } from "../../../stylex/tokens.stylex";

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
    gap: space.s1,
    paddingLeft: space.s1_5,
    paddingRight: space.s1_5,
    paddingTop: space.s0_5,
    paddingBottom: space.s0_5,
  },
  // render-chip h-1 overflow-hidden
  clip: {
    height: "0.25rem",
    overflow: "hidden",
    backgroundColor: colors.fillStrong,
  },

  // bg-primary/20 text-primary
  chipRunning: {
    backgroundColor: colors.accentWash,
    color: colors.primary,
  },
  // bg-primary/15 text-primary
  chipSucceeded: {
    backgroundColor: colors.accentWash,
    color: colors.primary,
  },
  // bg-destructive/20 text-destructive
  chipFailed: {
    backgroundColor: colors.criticalWash,
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
