import * as stylex from "@stylexjs/stylex";
import { colors, layout, space, stroke, text } from "../../stylex/tokens.stylex";

export const toolbar = stylex.create({
  root: {
    display: "flex",
    minHeight: "2.75rem",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s2,
    borderBottomWidth: stroke.hairline,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
    paddingInline: { default: space.s5, [layout.bpSm]: space.s6 },
    paddingBlock: space.s2,
  },
  group: { display: "flex", alignItems: "center", gap: space.s2 },
});

export const pageHeader = stylex.create({
  description: { marginTop: space.s1, maxWidth: "48rem", fontSize: text.sizeSm, lineHeight: text.lineBase, color: colors.mutedForeground },
});

export const separator = stylex.create({
  base: { flexShrink: 0, backgroundColor: colors.border },
  horizontal: { height: "1px", width: "100%" },
  vertical: { height: "100%", width: "1px" },
});
