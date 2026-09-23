import * as stylex from "@stylexjs/stylex";
import { colors, motion, shadows, space, stroke } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // size-4 text-emerald-400
  size4TextEmerald400: {
    width: "1rem",
    height: "1rem",
    color: colors.positive,
  },
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  // h-8 gap-2 rounded-none border border-border bg-card/90 px-3 shadow-sm backdrop-blur
  borderedGlassyGap2: {
    height: "2rem",
    gap: space.s2,
    borderWidth: stroke.hairline,
    borderColor: colors.hairline,
    backgroundColor: "hsl(var(--card) / 0.9)",
    paddingLeft: space.s3,
    paddingRight: space.s3,
    boxShadow: shadows.elevationSm,
    backdropFilter: motion.blurMd,
  },
});
