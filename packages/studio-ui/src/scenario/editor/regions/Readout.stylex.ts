import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // border border-border/70 bg-muted/30 p-2
  borderedPad2: {
    borderWidth: stroke.hairline,
    borderColor: "hsl(var(--border) / 0.7)",
    backgroundColor: "hsl(var(--muted) / 0.3)",
    padding: space.s2,
  },
  // text-micro uppercase tracking-meta text-muted-foreground
  capsMicroMuted: {
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // mt-1 truncate font-mono text-foreground/90
  monoTruncate: {
    marginTop: space.s1,
    fontFamily: text.fontMono,
    color: "hsl(var(--foreground) / 0.9)",
  },
});
