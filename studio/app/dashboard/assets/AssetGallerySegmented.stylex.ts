import * as stylex from "@stylexjs/stylex";
import { colors, shadows, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";
const FOCUS_RING = `0 0 0 1px ${colors.bg}, 0 0 0 3px ${colors.ring}`;
export const segmented = stylex.create({
  group: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s0_5,
    backgroundColor: colors.fillFaint,
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
  },
  icon: {
    width: "0.875rem",
    height: "0.875rem",
  },
});
