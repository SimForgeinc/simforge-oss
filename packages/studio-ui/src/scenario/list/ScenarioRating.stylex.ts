import * as stylex from "@stylexjs/stylex";
import { colors, space } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  // mt-2 flex min-h-5 flex-wrap items-center gap-1.5
  divFlex: {
    marginTop: space.s2,
    display: "flex",
    minHeight: "1.25rem",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s1_5,
  },
  // flex items-center gap-1
  ratingFor: {
    display: "flex",
    alignItems: "center",
    gap: space.s1,
  },
  // font-meta text-micro uppercase tracking-meta-narrow text-muted-foreground
  spanMetaMicroUppercase: {
    color: colors.mutedForeground,
  },
});
