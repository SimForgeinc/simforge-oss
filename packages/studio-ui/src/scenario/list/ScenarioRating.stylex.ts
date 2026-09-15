import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  // mt-2 flex min-h-5 flex-wrap items-center gap-1.5
  divFlex: {
    marginTop: space.md,
    display: "flex",
    minHeight: "1.25rem",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.sm,
  },
  // flex items-center gap-1
  ratingFor: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
  },
  // font-meta text-micro uppercase tracking-meta-narrow text-muted-foreground
  spanMetaMicroUppercase: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaNarrow,
    color: colors.mutedForeground,
  },
});
