import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground
  flexCenterMid: {
    display: "flex",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    padding: space.s6,
    textAlign: "center",
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    color: colors.mutedForeground,
  },
});
