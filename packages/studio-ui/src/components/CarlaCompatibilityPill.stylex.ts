import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "../stylex/tokens.stylex";

export const styles = stylex.create({
  root: { flexShrink: 0, cursor: "default", gap: space.s1, whiteSpace: "nowrap", fontWeight: text.weightMedium },
  small: { height: "1.25rem", paddingInline: space.s1_5, paddingBlock: 0, fontSize: text.sizeMicro, lineHeight: "inherit" },
  medium: { height: "1.5rem", paddingInline: space.s2, paddingBlock: space.s0_5, fontSize: text.sizeXs, lineHeight: text.lineXs },
  native: { borderColor: colors.info, backgroundColor: colors.infoWash, color: "rgb(186 230 253)", ":hover": { backgroundColor: colors.infoWash } },
  generated: { borderColor: "transparent", backgroundColor: colors.muted, color: colors.mutedForeground, ":hover": { backgroundColor: colors.muted } },
  browser: { borderColor: colors.hairline, backgroundColor: "transparent", color: colors.mutedForeground },
});
