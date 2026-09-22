import * as stylex from "@stylexjs/stylex";
import { colors, radii, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";
const SWITCH_WELL = "hsl(var(--muted) / 0.3)";
const FOCUS_RING = `0 0 0 1px ${colors.bg}, 0 0 0 3px ${colors.ring}`;
const SHADOW_SM = "0 1px 2px 0 rgb(0 0 0 / 0.05)";
export const segmented = stylex.create({
  group: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.125rem",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: SWITCH_WELL,
    padding: "0.125rem",
  },
  option: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.375rem",
    borderRadius: radii.sm,
    paddingInline: "0.75rem",
    paddingBlock: "0.375rem",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: 500,
    transitionProperty:
      "color, background-color, border-color, text-decoration-color, fill, stroke",
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
  },
  optionActive: {
    backgroundColor: colors.bg,
    color: colors.text,
    boxShadow: {
      default: SHADOW_SM,
      ":focus-visible": `${FOCUS_RING}, ${SHADOW_SM}`,
    },
  },
  optionIdle: {
    color: { default: colors.mutedForeground, ":hover": colors.text },
    boxShadow: { default: null, ":focus-visible": FOCUS_RING },
  },
  icon: {
    width: "0.875rem",
    height: "0.875rem",
  },
});
