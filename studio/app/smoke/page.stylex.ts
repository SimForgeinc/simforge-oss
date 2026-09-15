import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  // min-h-svh bg-background text-foreground
  div: {
    minHeight: "100svh",
    backgroundColor: colors.bg,
    color: colors.text,
  },
  // mx-auto max-w-5xl px-6 py-16
  main: {
    marginInline: "auto",
    maxWidth: "64rem",
    paddingInline: space.xxl,
    paddingBlock: "4rem",
  },
  // font-meta text-xs uppercase tracking-wide text-muted-foreground
  localPlatform: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    textTransform: "uppercase",
    letterSpacing: "0.025em",
    color: colors.mutedForeground,
  },
  // mt-3 font-display text-4xl font-semibold
  simforgeChromeSmokeSurface: {
    marginTop: space.lg,
    fontFamily: text.fontDisplay,
    fontSize: "2.25rem",
    lineHeight: "2.5rem",
    fontWeight: text.weightSemibold,
  },
});
