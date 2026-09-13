import * as stylex from "@stylexjs/stylex";
import { colors, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // flex min-w-0 items-center gap-2
  flexCenterNarrowable: {
    display: "flex",
    minWidth: "0px",
    alignItems: "center",
    gap: space.md,
  },
  // h-8 gap-1.5 rounded-none border border-border/70 bg-background/70 shadow-sm
  borderedGap15: {
    height: "2rem",
    gap: space.sm,
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: "hsl(var(--border) / 0.7)",
    backgroundColor: "hsl(var(--background) / 0.7)",
    boxShadow: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
  },
  // size-3.5
  size35: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // flex items-center gap-2
  flexCenterGap2: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
  },
  // h-8 gap-2 rounded-none border border-[#E8E044]/45 bg-card/90 px-3 text-[#E8E044] shadow-sm backdrop-blur hover:border-[#E8E044] hover:bg-[#E8E044] hover:text-black disabled:border-border disabled:text-muted-foreground
  borderedGlassyGap2: {
    height: "2rem",
    gap: space.md,
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: {
      default: "rgb(232 224 68 / 0.45)",
      ":disabled": colors.border,
      ":hover": colors.accent,
    },
    backgroundColor: {
      default: "hsl(var(--card) / 0.9)",
      ":hover": colors.accent,
    },
    paddingLeft: space.lg,
    paddingRight: space.lg,
    color: {
      default: colors.accent,
      ":disabled": colors.mutedForeground,
      ":hover": "rgb(0 0 0 / 1)",
    },
    boxShadow: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
    backdropFilter: "blur(8px)",
  },
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
});
