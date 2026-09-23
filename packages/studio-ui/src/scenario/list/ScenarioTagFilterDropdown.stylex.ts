import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  // min-w-0 flex-1 truncate
  spanTruncate: {
    minWidth: 0,
    flex: "1 1 0%",
  },
  // text-micro text-muted-foreground
  spanMicro: {
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
  // size-2 border border-border
  spanIcon: {
    width: space.s2,
    height: space.s2,
  },
  // min-w-0 flex-1 truncate
  spanTruncate2: {
    minWidth: 0,
    flex: "1 1 0%",
  },
  // text-micro text-muted-foreground
  spanMicro2: {
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
});
