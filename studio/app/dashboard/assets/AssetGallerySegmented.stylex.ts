import * as stylex from "@stylexjs/stylex";
import { colors, shadows, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";
const SWITCH_WELL = "hsl(var(--muted) / 0.3)";
const FOCUS_RING = `0 0 0 1px ${colors.bg}, 0 0 0 3px ${colors.ring}`;
export const segmented = stylex.create({
  group: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s0_5,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: SWITCH_WELL,
    padding: space.s0_5,
  },
  option: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    paddingInline: space.s3,
    paddingBlock: space.s1_5,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightMedium,
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineWidth: { default: null, ":focus-visible": stroke.thick },
    outlineColor: { default: null, ":focus-visible": "transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
  },
  optionActive: {
    backgroundColor: colors.bg,
    color: colors.text,
    boxShadow: {
      default: shadows.elevationSm,
      ":focus-visible": `${FOCUS_RING}, ${shadows.elevationSm}`,
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
