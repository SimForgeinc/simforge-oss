import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  field: { minWidth: 0 },
  fieldLabel: { display: "block", color: colors.mutedForeground },
  trigger: {
    display: "inline-flex",
    alignItems: "center",
    width: "100%",
    height: "2.5rem",
    gap: space.s2,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.input,
    paddingInline: space.s3,
    textAlign: "left",
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    backgroundColor: { default: colors.bg, ":hover": colors.muted },
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    opacity: { default: null, ":disabled": 0.5 },
  },
  value: { minWidth: 0, flex: 1, },
  icon: { width: "1rem", height: "1rem", flexShrink: 0, opacity: 0.6 },
  content: { maxHeight: "18rem", overflowY: "auto" },
});
