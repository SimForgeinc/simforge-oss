import * as stylex from "@stylexjs/stylex";
import { colors, radii, space, stroke, text } from "../../stylex/tokens.stylex";

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
    borderRadius: radii.md,
    paddingInline: space.s3,
    textAlign: "left",
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineWidth: { default: null, ":focus-visible": stroke.thick },
    outlineColor: { default: null, ":focus-visible": colors.ring },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    backgroundColor: { default: colors.bg, ":hover": colors.muted },
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    opacity: { default: null, ":disabled": 0.5 },
  },
  value: { minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  icon: { width: "1rem", height: "1rem", flexShrink: 0, opacity: 0.6 },
  content: { maxHeight: "18rem", overflowY: "auto" },
});
