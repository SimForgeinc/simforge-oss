import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // border border-border/70 bg-muted/30 p-2
  borderedPad2: {
    borderWidth: "1px",
    borderColor: "hsl(var(--border) / 0.7)",
    backgroundColor: "hsl(var(--muted) / 0.3)",
    padding: space.md,
  },
  // text-micro uppercase tracking-meta text-muted-foreground
  capsMicroMuted: {
    fontSize: text.sizeMicro,
    lineHeight: "0.875rem",
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // mt-1 truncate font-mono text-foreground/90
  monoTruncate: {
    marginTop: space.xs,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: text.fontMono,
    color: "hsl(var(--foreground) / 0.9)",
  },
});
