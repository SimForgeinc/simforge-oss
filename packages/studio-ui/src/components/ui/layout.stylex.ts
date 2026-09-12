import * as stylex from "@stylexjs/stylex";
import { colors, text } from "../../stylex/tokens.stylex";

export const toolbar = stylex.create({
  root: {
    display: "flex",
    minHeight: "2.75rem",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.5rem",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
    paddingInline: { default: "1.25rem", "@media (min-width: 640px)": "1.5rem" },
    paddingBlock: "0.5rem",
  },
  group: { display: "flex", alignItems: "center", gap: "0.5rem" },
});

export const pageHeader = stylex.create({
  root: {
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
    paddingInline: { default: "1.25rem", "@media (min-width: 640px)": "1.5rem" },
    paddingBlock: "1.25rem",
  },
  row: { display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem" },
  content: { minWidth: 0 },
  eyebrow: { marginBottom: "0.25rem", fontSize: text.sizeXs, lineHeight: "1rem", fontWeight: 500, color: colors.mutedForeground },
  title: { fontSize: "1.5rem", lineHeight: "2rem", fontWeight: 600, letterSpacing: "-0.025em", color: colors.text },
  description: { marginTop: "0.25rem", maxWidth: "48rem", fontSize: text.sizeSm, lineHeight: "1.5rem", color: colors.mutedForeground },
  actions: { display: "flex", flexShrink: 0, alignItems: "center", gap: "0.5rem" },
});

export const separator = stylex.create({
  base: { flexShrink: 0, backgroundColor: colors.border },
  horizontal: { height: "1px", width: "100%" },
  vertical: { height: "100%", width: "1px" },
});
