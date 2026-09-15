import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  // size-3.5
  filterFilter: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // min-w-0 flex-1 truncate
  spanTruncate: {
    minWidth: 0,
    flex: "1 1 0%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // text-micro text-muted-foreground
  spanMicro: {
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
  // size-2 border border-border
  spanIcon: {
    width: space.md,
    height: space.md,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.border,
  },
  // min-w-0 flex-1 truncate
  spanTruncate2: {
    minWidth: 0,
    flex: "1 1 0%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // text-micro text-muted-foreground
  spanMicro2: {
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    color: colors.mutedForeground,
  },
});
