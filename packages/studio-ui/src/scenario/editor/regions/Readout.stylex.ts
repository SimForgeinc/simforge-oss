import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // border border-border/70 bg-muted/30 p-2
  borderedPad2: {
    borderWidth: stroke.hairline,
    borderColor: colors.hairline,
    backgroundColor: colors.fillFaint,
    padding: space.s2,
  },
  // text-micro uppercase tracking-meta text-muted-foreground
  capsMicroMuted: {
    color: colors.mutedForeground,
  },
  // mt-1 truncate font-mono text-foreground/90
  monoTruncate: {
    marginTop: space.s1,
    fontFamily: text.fontMono,
    color: colors.ink,
  },
});
