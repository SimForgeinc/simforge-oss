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
  root: {
    borderBottomWidth: stroke.hairline,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
    paddingInline: { default: space.s5, [layout.bpSm]: space.s6 },
    paddingBlock: space.s5,
  },
  row: { display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: space.s4 },
  content: { minWidth: 0 },
  eyebrow: { marginBottom: space.s1, fontSize: text.sizeXs, lineHeight: text.lineXs, fontWeight: text.weightMedium, color: colors.mutedForeground },
  title: { fontSize: text.size2xl, lineHeight: text.lineXl, fontWeight: text.weightSemibold, letterSpacing: text.trackingTight, color: colors.text },
  description: { marginTop: space.s1, maxWidth: "48rem", fontSize: text.sizeSm, lineHeight: text.lineBase, color: colors.mutedForeground },
  actions: { display: "flex", flexShrink: 0, alignItems: "center", gap: space.s2 },
});

export const separator = stylex.create({
  base: { flexShrink: 0, backgroundColor: colors.border },
  horizontal: { height: "1px", width: "100%" },
  vertical: { height: "100%", width: "1px" },
});
